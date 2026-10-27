import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  EmailChallengeService,
  consumeEmailChallenge,
} from "../../src/features/email/email-challenge-service";
import { purgeExpiredEmailSecurityRecords } from "../../src/features/email/email-cleanup-service";
import {
  emailBucketKeys,
  recordEmailVerificationFailure,
} from "../../src/features/email/email-rate-limit";
import {
  PasswordResetService,
  consumePasswordResetAuthorization,
} from "../../src/features/email/password-reset-service";
import { memberService } from "../../src/features/members/member-service";
import { AppError } from "../../src/lib/api/errors";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { inSerializableTransaction } from "../../src/lib/db/transaction";
import { resetServerEnvForTests } from "../../src/lib/env";
import type { EmailSender, EmailMessage, EmailDeliveryOutcome } from "../../src/lib/email/mailer";
import { digestEmailBucketKey } from "../../src/lib/security/email-security";
import {
  EMAIL_CHALLENGE_TTL_MS,
  EMAIL_SEND_COOLDOWN_MS,
  PASSWORD_RESET_AUTHORIZATION_TTL_MS,
} from "../../src/lib/security/email-policy";
import { hashPassword } from "../../src/lib/security/secrets";
import type { AuthorizedActor, PublicRequestContext } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";

/**
 * 邮箱验证与重置授权基础设施。
 *
 * 命名空间：全部夹具挂固定 UUID（`e146…`），每次 `prepareFixtures` 按 userId 精确清理再重建；
 * 邮箱地址与 IP 用固定值，计数桶按同一份键构造器算摘要清理 —— 跨运行不串状态。
 *
 * 时间：服务路径的时间来源可注入（`now`），计数窗口 / 有效期用「注入时钟推进」验证；
 * 涉及 `consumeEmailChallenge`（真实服务端时间）的到期断言用「库内回拨」夹具，
 * 两种手段都不真实等待 10 / 15 分钟。SMTP 用 Fake Sender，不发真实邮件。
 */

process.env.MAIL_ENABLED = "true";
process.env.SMTP_HOST = "smtpdm.aliyun.test";
process.env.SMTP_PORT = "465";
process.env.SMTP_USER = "noreply@pczafu.cn";
process.env.SMTP_PASSWORD = "i146-test-smtp-password";
process.env.MAIL_FROM = "浙江农林大学电脑医院 <noreply@pczafu.cn>";
process.env.EMAIL_CODE_PEPPER = "i146-test-email-code-pepper-at-least-32b";
resetServerEnvForTests();

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

const ID = (suffix: string) => `e1460000-0000-4000-8000-0000000000${suffix}`;
const ADMIN_ID = ID("01");
const MEMBER_ID = ID("02");
const BIND_ID = ID("03");
const BUDGET1_ID = ID("04");
const BUDGET2_ID = ID("05");
const BUDGET3_ID = ID("06");
const FAIL_ID = ID("07");
const UNCERTAIN_ID = ID("08");
/** 档案 ID：沿用 `ID` 的 2 位尾部，仅把第四段换成 `8001` 与用户 ID 区分（末段仍 12 位）。 */
const PROFILE = (suffix: string) => `e1460000-0000-4000-8001-0000000000${suffix}`;
const ADMIN_EMAIL_ROW_ID = ID("e1");

const MEMBER_EMAIL = "member146@example.com";
const BIND_EMAIL = "bind146@example.com";
const BUDGET_EMAILS = [
  "budget146-1@example.com",
  "budget146-2@example.com",
  "budget146-3@example.com",
];
const FAIL_EMAIL = "fail146@example.com";
const UNCERTAIN_EMAIL = "uncertain146@example.com";
const ALL_EMAILS = [MEMBER_EMAIL, BIND_EMAIL, ...BUDGET_EMAILS, FAIL_EMAIL, UNCERTAIN_EMAIL];
const CTX_IPS = [
  "10.146.0.1",
  "10.146.0.2",
  "10.146.0.3",
  "10.146.0.4",
  "10.146.0.5",
  "10.146.0.6",
];

const FIXTURE_USER_IDS = [
  ADMIN_ID,
  MEMBER_ID,
  BIND_ID,
  BUDGET1_ID,
  BUDGET2_ID,
  BUDGET3_ID,
  FAIL_ID,
  UNCERTAIN_ID,
];

const ADMIN_ACTOR: AuthorizedActor = {
  actorType: "USER",
  userId: ADMIN_ID,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_i146_admin",
};

const MEMBER_PASSWORD = "I146-Member-Password-1";

let ctxSeq = 0;
function ctx(ip: string): PublicRequestContext {
  ctxSeq += 1;
  return { requestId: `req_i146_${ctxSeq}`, ipAddress: ip, userAgent: "i146-test" };
}

function expectCode(run: () => Promise<unknown>, code: string) {
  return assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AppError, `期望 AppError，实际：${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** 可注入结果的假 Sender：捕获邮件文本（验证码从正文解析），可挂起指定次数模拟迟到结果。 */
class FakeEmailSender implements EmailSender {
  messages: EmailMessage[] = [];
  outcome: EmailDeliveryOutcome = { status: "ACCEPTED" };
  /** 下一次 send 挂起，直到 `release()` —— 用于制造「发送结果迟到」场景。 */
  deferNext = false;
  private releaseNext: (() => void) | undefined;
  private firstSendStarted!: () => void;
  private readonly firstSendStartedPromise = new Promise<void>((resolve) => {
    this.firstSendStarted = resolve;
  });

  async send(message: EmailMessage): Promise<EmailDeliveryOutcome> {
    this.messages.push(message);
    this.firstSendStarted();
    if (this.deferNext) {
      this.deferNext = false;
      await new Promise<void>((resolve) => {
        this.releaseNext = resolve;
      });
    }
    return this.outcome;
  }

  codeFrom(index: number): string {
    const match = this.messages[index]?.text.match(/验证码：(\d{6})/);
    assert.ok(match, `第 ${index + 1} 封邮件正文应包含 6 位验证码`);
    return match[1]!;
  }

  waitForFirstSend(): Promise<void> {
    return this.firstSendStartedPromise;
  }

  release(): void {
    this.releaseNext?.();
  }
}

/** 注入时钟：`advance` 推进毫秒，窗口与有效期的推进不真实等待。 */
class TestClock {
  private current = Date.now();
  now = () => new Date(this.current);
  advance(ms: number): void {
    this.current += ms;
  }
}

function buildService(sender: FakeEmailSender, clock: TestClock) {
  const challenges = new EmailChallengeService({ sender, now: clock.now });
  const passwordReset = new PasswordResetService({ challengeService: challenges, now: clock.now });
  return { challenges, passwordReset };
}

async function createUser(id: string, displayName: string, status = "ACTIVE") {
  const now = new Date();
  await getDb().user.create({
    data: { id, status, displayName, createdAt: now, updatedAt: now },
  });
}

async function attachRole(userId: string, code: "MEMBER" | "ADMIN") {
  const role = await getDb().role.findUniqueOrThrow({ where: { code } });
  const now = new Date();
  await getDb().userRole.create({
    data: {
      id: randomUUID(),
      userId,
      roleId: role.id,
      sourceType: "ADMIN_CREATED",
      grantedBy: ADMIN_ID,
      grantedAt: now,
      activeKey: `${userId}:${role.id}`,
    },
  });
}

async function attachProfile(id: string, userId: string, realName: string) {
  const now = new Date();
  await getDb().memberProfile.create({
    data: { id, userId, realName, status: "ACTIVE", joinedAt: now, createdAt: now, updatedAt: now },
  });
}

async function attachCredential(userId: string) {
  const now = new Date();
  await getDb().passwordCredential.create({
    data: {
      userId,
      passwordHash: await hashPassword(MEMBER_PASSWORD),
      mustChangePassword: false,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

async function attachEmailIdentity(id: string, userId: string, email: string) {
  const now = new Date();
  await getDb().userIdentity.create({
    data: {
      id,
      userId,
      type: "EMAIL",
      identifierNormalized: email,
      verifiedAt: now,
      activeEmailKey: `email:${userId}`,
      createdAt: now,
      updatedAt: now,
    },
  });
}

/** 本文件会用到的全部计数键（与生产同源的构造器算出摘要后精准清理）。 */
function fixtureCounterKeys(): string[] {
  const keys: string[] = [emailBucketKeys.budgetDay(), emailBucketKeys.budgetMinute()];
  for (const userId of FIXTURE_USER_IDS) {
    keys.push(emailBucketKeys.sendCooldownUser(userId), emailBucketKeys.sendDailyUser(userId));
    for (const purpose of [
      "EMAIL_BIND",
      "EMAIL_CHANGE_OLD",
      "EMAIL_CHANGE_NEW",
      "PASSWORD_RESET",
    ]) {
      keys.push(emailBucketKeys.verifyFailure(userId, purpose));
    }
  }
  for (const email of ALL_EMAILS) {
    keys.push(emailBucketKeys.sendCooldownEmail(email), emailBucketKeys.sendDailyEmail(email));
  }
  for (const ip of [...CTX_IPS, "unknown"]) {
    keys.push(emailBucketKeys.sendDailyIp(ip), emailBucketKeys.verifyIp(ip));
  }
  return keys;
}

async function prepareFixtures(): Promise<void> {
  const db = getDb();
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { action: { startsWith: "email." } },
        { actorUserId: { in: FIXTURE_USER_IDS } },
        { targetId: { in: FIXTURE_USER_IDS } },
      ],
    },
  });
  await db.passwordResetAuthorization.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.emailChallenge.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.emailSecurityCounter.deleteMany({
    where: {
      bucketKeyDigest: { in: fixtureCounterKeys().map((key) => digestEmailBucketKey(key)) },
    },
  });
  await db.authSession.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.userRole.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.memberProfile.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.userIdentity.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.user.deleteMany({ where: { id: { in: FIXTURE_USER_IDS } } });

  const now = new Date();
  await db.role.upsert({
    where: { code: "MEMBER" },
    update: {},
    create: {
      id: "00000000-0000-4000-8000-000000000001",
      code: "MEMBER",
      name: "成员",
      createdAt: now,
    },
  });
  await db.role.upsert({
    where: { code: "ADMIN" },
    update: {},
    create: {
      id: "00000000-0000-4000-8000-000000000002",
      code: "ADMIN",
      name: "管理员",
      createdAt: now,
    },
  });

  await createUser(ADMIN_ID, "I146 管理员");
  await attachRole(ADMIN_ID, "ADMIN");

  await createUser(MEMBER_ID, "I146 已绑定成员");
  await attachProfile(PROFILE("02"), MEMBER_ID, "I146 已绑定成员");
  await attachRole(MEMBER_ID, "MEMBER");
  await attachCredential(MEMBER_ID);
  await attachEmailIdentity(ADMIN_EMAIL_ROW_ID, MEMBER_ID, MEMBER_EMAIL);

  for (const [id, name] of [
    [BIND_ID, "I146 待绑定成员"],
    [BUDGET1_ID, "I146 预算一"],
    [BUDGET2_ID, "I146 预算二"],
    [BUDGET3_ID, "I146 预算三"],
    [FAIL_ID, "I146 失败计数"],
    [UNCERTAIN_ID, "I146 不确定"],
  ] as const) {
    await createUser(id, name);
    await attachProfile(PROFILE(id.slice(-2)), id, name);
    await attachRole(id, "MEMBER");
    await attachCredential(id);
  }
}

before(async () => {
  if (!enabled) return;
  await prepareFixtures();
});
beforeEach(async () => {
  if (!enabled) return;
  await prepareFixtures();
});
after(async () => {
  if (!enabled) return;
  await disconnectDb();
});

function counterRow(key: string) {
  return getDb().emailSecurityCounter.findUnique({
    where: { bucketKeyDigest: digestEmailBucketKey(key) },
  });
}

/* --------------------------------------------------- 正常链路（发送 → 验证 → 消费） */

dbTest("绑定链路：签发邮件 → 校验 → 事务内条件消费并落身份；重放被拒", async () => {
  const sender = new FakeEmailSender();
  const clock = new TestClock();
  const { challenges } = buildService(sender, clock);

  const issued = await challenges.requestEmailChallenge(
    { userId: BIND_ID, purpose: "EMAIL_BIND", targetEmail: " Bind146@Example.COM " },
    ctx(CTX_IPS[0]!),
  );
  assert.match(issued.challengeId, /^[0-9a-f-]{36}$/);
  assert.equal(issued.maskedEmail, "b***@example.com", "回显必须是脱敏值，不能是完整地址");
  const ttl = new Date(issued.expiresAt).getTime() - clock.now().getTime();
  assert.ok(ttl > 9 * 60_000 && ttl <= 10 * 60_000, `有效期应约 10 分钟，实际 ${ttl}ms`);

  assert.equal(sender.messages.length, 1);
  assert.equal(sender.messages[0]!.to, BIND_EMAIL);
  const code = sender.codeFrom(0);

  const row = await getDb().emailChallenge.findUniqueOrThrow({ where: { id: issued.challengeId } });
  assert.equal(row.status, "ACTIVE", "服务商接受后挑战才可验证");
  assert.equal(row.targetEmailNormalized, BIND_EMAIL);
  // 只存摘要：库里不得出现明文验证码；审计同样不得出现。
  const stored = JSON.stringify(row);
  assert.equal(stored.includes(code), false);
  const audits = await getDb().auditLog.findMany({
    where: { action: { in: ["email.challenge.requested", "email.challenge.sent"] } },
  });
  assert.equal(audits.length, 2);
  for (const audit of audits) {
    const text = JSON.stringify(audit);
    assert.equal(text.includes(code), false, "审计不得携带明文验证码");
    assert.equal(text.includes(BIND_EMAIL), false, "审计中的邮箱必须脱敏");
  }

  const proof = await challenges.verifyEmailChallenge(
    { challengeId: issued.challengeId, code, expectedPurpose: "EMAIL_BIND" },
    ctx(CTX_IPS[0]!),
  );
  assert.equal(proof.userId, BIND_ID);
  assert.equal(proof.emailNormalized, BIND_EMAIL);

  // 未来的绑定流程形态：校验与身份写入共用同一事务（本任务不落业务入口，这里模拟）。
  await inSerializableTransaction(async (tx) => {
    const consumed = await consumeEmailChallenge(tx, {
      challengeId: issued.challengeId,
      code,
      purpose: "EMAIL_BIND",
    });
    const now = new Date();
    await tx.userIdentity.create({
      data: {
        id: randomUUID(),
        userId: consumed.userId,
        type: "EMAIL",
        identifierNormalized: consumed.emailNormalized,
        verifiedAt: now,
        activeEmailKey: `email:${consumed.userId}`,
        createdAt: now,
        updatedAt: now,
      },
    });
  });
  const consumedRow = await getDb().emailChallenge.findUniqueOrThrow({
    where: { id: issued.challengeId },
  });
  assert.equal(consumedRow.status, "CONSUMED");
  assert.ok(consumedRow.finishedAt);
  const identity = await getDb().userIdentity.findFirst({
    where: { userId: BIND_ID, type: "EMAIL" },
  });
  assert.equal(identity?.identifierNormalized, BIND_EMAIL);
  assert.equal(identity?.activeEmailKey, `email:${BIND_ID}`);

  // 重放：同一挑战不能再次消费；再次校验也失败（已消费）。
  await expectCode(
    () =>
      inSerializableTransaction((tx) =>
        consumeEmailChallenge(tx, { challengeId: issued.challengeId, code, purpose: "EMAIL_BIND" }),
      ),
    "EMAIL_CHALLENGE_INVALID",
  );
  await expectCode(
    () =>
      challenges.verifyEmailChallenge({ challengeId: issued.challengeId, code }, ctx(CTX_IPS[0]!)),
    "EMAIL_CHALLENGE_INVALID",
  );
});

dbTest(
  "重置链路：验证 → 原子消费并签发授权 → 消费授权；管理员重置使旧授权与旧验证码失效",
  async () => {
    const sender = new FakeEmailSender();
    const clock = new TestClock();
    const { challenges, passwordReset } = buildService(sender, clock);

    // 服务端解析收件地址：PASSWORD_RESET 不接受调用方指定目标。
    await expectCode(
      () =>
        challenges.requestEmailChallenge(
          { userId: MEMBER_ID, purpose: "PASSWORD_RESET", targetEmail: MEMBER_EMAIL },
          ctx(CTX_IPS[0]!),
        ),
      "VALIDATION_FAILED",
    );
    const issued = await challenges.requestEmailChallenge(
      { userId: MEMBER_ID, purpose: "PASSWORD_RESET" },
      ctx(CTX_IPS[0]!),
    );
    assert.equal(sender.messages[0]!.to, MEMBER_EMAIL, "收件地址由服务端按当前有效邮箱解析");
    const code = sender.codeFrom(0);

    // 未验证邮箱的账号没有可用的找回通道。
    await expectCode(
      () =>
        challenges.requestEmailChallenge(
          { userId: BIND_ID, purpose: "PASSWORD_RESET" },
          ctx(CTX_IPS[1]!),
        ),
      "EMAIL_NOT_VERIFIED",
    );

    const issuedAuth = await passwordReset.verifyChallengeAndIssue(
      { challengeId: issued.challengeId, code },
      ctx(CTX_IPS[0]!),
    );
    assert.equal(issuedAuth.userId, MEMBER_ID);
    assert.match(issuedAuth.token, /^[A-Za-z0-9_-]{43}$/);
    const authRow = await getDb().passwordResetAuthorization.findUniqueOrThrow({
      where: { id: issuedAuth.grantId },
    });
    assert.equal(authRow.status, "ISSUED");
    assert.equal(authRow.emailIdentityId, ADMIN_EMAIL_ROW_ID);
    assert.equal(authRow.credentialVersion, 0);
    assert.equal(
      Buffer.from(authRow.tokenDigest).toString("utf8").includes(issuedAuth.token),
      false,
    );
    // 同一挑战已消费：再次验证不得再次签发。
    await expectCode(
      () =>
        passwordReset.verifyChallengeAndIssue(
          { challengeId: issued.challengeId, code },
          ctx(CTX_IPS[0]!),
        ),
      "EMAIL_CHALLENGE_INVALID",
    );

    // 消费授权（后续阶段在同一事务里写密码 / 递增代次 / 撤 Session，这里只消费）。
    await inSerializableTransaction((tx) =>
      consumePasswordResetAuthorization(tx, { token: issuedAuth.token, context: ctx(CTX_IPS[0]!) }),
    );
    const consumedAuth = await getDb().passwordResetAuthorization.findUniqueOrThrow({
      where: { id: issuedAuth.grantId },
    });
    assert.equal(consumedAuth.status, "CONSUMED");
    assert.ok(
      (await getDb().auditLog.count({
        where: { action: "email.reset.authorization.consumed", targetId: issuedAuth.grantId },
      })) === 1,
    );
    await expectCode(
      () =>
        inSerializableTransaction((tx) =>
          consumePasswordResetAuthorization(tx, {
            token: issuedAuth.token,
            context: ctx(CTX_IPS[0]!),
          }),
        ),
      "EMAIL_RESET_AUTHORIZATION_INVALID",
    );

    // 新一轮：管理员在验证码签发后重置密码（credentialVersion 0 → 1）：
    // 旧验证码不得兑换成新代次授权 —— 消费与签发整笔回滚，挑战不被消费。
    clock.advance(61_000);
    const issued2 = await challenges.requestEmailChallenge(
      { userId: MEMBER_ID, purpose: "PASSWORD_RESET" },
      ctx(CTX_IPS[1]!),
    );
    const code2 = sender.codeFrom(1);
    await memberService.resetAccountPassword(MEMBER_ID, ADMIN_ACTOR);
    await expectCode(
      () =>
        passwordReset.verifyChallengeAndIssue(
          { challengeId: issued2.challengeId, code: code2 },
          ctx(CTX_IPS[1]!),
        ),
      "EMAIL_CHALLENGE_INVALID",
    );
    const challenge2 = await getDb().emailChallenge.findUniqueOrThrow({
      where: { id: issued2.challengeId },
    });
    assert.equal(challenge2.status, "ACTIVE", "整笔回滚后挑战不得被独立消费");
    assert.equal(
      await getDb().passwordResetAuthorization.count({
        where: { userId: MEMBER_ID, status: "ISSUED" },
      }),
      0,
    );

    // 再签发一轮并用管理员重置使**已签发**的授权失效：消费授权时必须复核凭据代次。
    clock.advance(61_000);
    const issued3 = await challenges.requestEmailChallenge(
      { userId: MEMBER_ID, purpose: "PASSWORD_RESET" },
      ctx(CTX_IPS[2]!),
    );
    const code3 = sender.codeFrom(2);
    const auth3 = await passwordReset.verifyChallengeAndIssue(
      { challengeId: issued3.challengeId, code: code3 },
      ctx(CTX_IPS[2]!),
    );
    await memberService.resetAccountPassword(MEMBER_ID, ADMIN_ACTOR);
    await expectCode(
      () =>
        inSerializableTransaction((tx) =>
          consumePasswordResetAuthorization(tx, { token: auth3.token, context: ctx(CTX_IPS[2]!) }),
        ),
      "EMAIL_RESET_AUTHORIZATION_INVALID",
    );
  },
);

/* -------------------------------------------------------- 重发失效与迟到结果 */

dbTest("重发使旧挑战失效；迟到的发送结果不得激活已被替代的挑战", async () => {
  const sender = new FakeEmailSender();
  const clock = new TestClock();
  const { challenges } = buildService(sender, clock);

  sender.deferNext = true;
  const first = challenges
    .requestEmailChallenge(
      { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
      ctx(CTX_IPS[0]!),
    )
    .catch((error: unknown) => error); // 先挂监听，避免断言前的未处理拒绝
  await sender.waitForFirstSend(); // 第一封已发出（发送在事务外），结果挂起
  const firstCode = sender.codeFrom(0);

  // 冷却后重发：新挑战使旧挑战立即失效（不必等旧挑战自然过期）。
  clock.advance(61_000);
  const second = await challenges.requestEmailChallenge(
    { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
    ctx(CTX_IPS[0]!),
  );
  const secondCode = sender.codeFrom(1);

  // 旧发送结果这时才返回「已接受」：不得把 INVALIDATED 的挑战复活成 ACTIVE。
  sender.release();
  const firstOutcome = await first;
  assert.ok(firstOutcome instanceof AppError, `首次请求应失败，实际：${String(firstOutcome)}`);
  assert.equal(firstOutcome.code, "EMAIL_CHALLENGE_INVALID");
  const secondRow = await getDb().emailChallenge.findUniqueOrThrow({
    where: { id: second.challengeId },
  });
  assert.equal(secondRow.status, "ACTIVE");
  const firstRow = await getDb().emailChallenge.findFirst({
    where: { userId: FAIL_ID, status: "INVALIDATED" },
  });
  assert.ok(firstRow, "被替代的挑战必须保持 INVALIDATED");
  assert.ok(
    (await getDb().auditLog.count({
      where: { action: "email.challenge.send_discarded", targetId: firstRow.id },
    })) === 1,
  );

  // 旧验证码不可用（含旧挑战已被替代这条）。
  await expectCode(
    () =>
      challenges.verifyEmailChallenge(
        { challengeId: firstRow.id, code: firstCode },
        ctx(CTX_IPS[0]!),
      ),
    "EMAIL_CHALLENGE_INVALID",
  );
  // 新验证码可用。
  const proof = await challenges.verifyEmailChallenge(
    { challengeId: second.challengeId, code: secondCode },
    ctx(CTX_IPS[0]!),
  );
  assert.equal(proof.userId, FAIL_ID);
});

/* ------------------------------------------------------------- 失败计数与阻断 */

dbTest("失败计数：5 次错码后阻断 15 分钟，重发 / 换 IP 都不清零；窗口后恢复", async () => {
  const sender = new FakeEmailSender();
  const clock = new TestClock();
  const { challenges } = buildService(sender, clock);

  const issued = await challenges.requestEmailChallenge(
    { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
    ctx(CTX_IPS[0]!),
  );
  const code = sender.codeFrom(0);
  const failKey = emailBucketKeys.verifyFailure(FAIL_ID, "EMAIL_BIND");

  const wrong = code === "000000" ? "111111" : "000000";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await expectCode(
      () =>
        challenges.verifyEmailChallenge(
          { challengeId: issued.challengeId, code: wrong },
          ctx(CTX_IPS[attempt % CTX_IPS.length]!),
        ),
      "EMAIL_CHALLENGE_INVALID",
    );
    // 失败计数必须已持久化（独立提交，不随业务事务回滚）。
    const row = await counterRow(failKey);
    assert.equal(row?.counter, attempt, `第 ${attempt} 次失败后计数应为 ${attempt}`);
  }
  const blocked = await counterRow(failKey);
  assert.ok(blocked?.blockedUntil, "第 5 次失败必须写入阻断截止时间");
  const blockWindow = blocked.blockedUntil!.getTime() - clock.now().getTime();
  assert.ok(
    blockWindow > 14 * 60_000 && blockWindow <= 15 * 60_000,
    `阻断窗口异常：${blockWindow}`,
  );

  // 即使验证码正确、即使换 IP、即使重新签发挑战，阻断都拦得住（不清零）。
  await expectCode(
    () =>
      challenges.verifyEmailChallenge({ challengeId: issued.challengeId, code }, ctx(CTX_IPS[5]!)),
    "EMAIL_RATE_LIMITED",
  );
  clock.advance(61_000);
  const reissued = await challenges.requestEmailChallenge(
    { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
    ctx(CTX_IPS[5]!),
  );
  const reissuedCode = sender.codeFrom(1);
  const stillBlocked = await counterRow(failKey);
  assert.ok(stillBlocked?.blockedUntil, "重发不得清除阻断");
  await expectCode(
    () =>
      challenges.verifyEmailChallenge(
        { challengeId: reissued.challengeId, code: reissuedCode },
        ctx(CTX_IPS[5]!),
      ),
    "EMAIL_RATE_LIMITED",
  );
  assert.ok(
    (await getDb().auditLog.count({ where: { action: "email.challenge.verify_blocked" } })) >= 1,
  );

  // 阻断窗口过去后恢复正常（错误计数窗口也一并过期）。
  // 注意：跨越 15 分钟后，重发时的挑战早已过期（10 分钟 TTL），必须重新签发一份。
  clock.advance(15 * 60_000 + 1_000);
  const afterBlock = await challenges.requestEmailChallenge(
    { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
    ctx(CTX_IPS[5]!),
  );
  const afterBlockCode = sender.codeFrom(2);
  const proof = await challenges.verifyEmailChallenge(
    { challengeId: afterBlock.challengeId, code: afterBlockCode },
    ctx(CTX_IPS[5]!),
  );
  assert.equal(proof.userId, FAIL_ID);
});

dbTest("并发验码串行化：预置 4 次失败后少量并发错码只放行最后一次实际尝试（F1 返修）", async () => {
  const sender = new FakeEmailSender();
  const clock = new TestClock();
  const { challenges } = buildService(sender, clock);

  const issued = await challenges.requestEmailChallenge(
    { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
    ctx(CTX_IPS[0]!),
  );
  const code = sender.codeFrom(0);
  const wrong = code === "000000" ? "111111" : "000000";
  const failKey = emailBucketKeys.verifyFailure(FAIL_ID, "EMAIL_BIND");

  // 预置 4 次失败：还剩 1 次实际尝试额度，且尚未阻断。
  await inSerializableTransaction(async (tx) => {
    for (let i = 0; i < 4; i += 1) {
      await recordEmailVerificationFailure(
        tx,
        { userId: FAIL_ID, purpose: "EMAIL_BIND" },
        clock.now(),
      );
    }
  });
  const preset = await counterRow(failKey);
  assert.equal(preset?.counter, 4);
  assert.equal(preset?.blockedUntil, null);

  // 5 个并发错误验证码请求、各自不同 IP（覆盖「换 IP 绕过」）：决策事务在
  // （账号, 用途）失败桶行锁上排成先后 → 恰好 1 次真实判决（INVALID），其余全部限流。
  const attempts = await Promise.allSettled(
    [0, 1, 2, 3, 4].map((index) =>
      challenges.verifyEmailChallenge(
        { challengeId: issued.challengeId, code: wrong },
        ctx(CTX_IPS[index]!),
      ),
    ),
  );
  const codes = attempts.map((item) =>
    item.status === "rejected" ? (item.reason as AppError).code : "FULFILLED",
  );
  assert.equal(
    codes.filter((item) => item === "EMAIL_CHALLENGE_INVALID").length,
    1,
    `只允许剩余 1 次实际尝试，实际分布：${codes.join(",")}`,
  );
  assert.equal(
    codes.filter((item) => item === "EMAIL_RATE_LIMITED").length,
    4,
    `限流次数不符，实际分布：${codes.join(",")}`,
  );

  // 持久化失败数必须恰为 5（不越过上限），阻断已生效，失败审计随判决事务先行提交。
  const final = await counterRow(failKey);
  assert.equal(final?.counter, 5, "并发错码不得把失败计数推过 5");
  assert.ok(final?.blockedUntil, "第 5 次失败必须写入阻断");
  assert.equal(
    await getDb().auditLog.count({
      where: { action: "email.challenge.verify_failed", targetId: issued.challengeId },
    }),
    1,
    "抛错前失败审计必须已提交（恰好本次实际失败一条）",
  );
  // 阻断生效后，正确的验证码同样被拦下。
  await expectCode(
    () =>
      challenges.verifyEmailChallenge({ challengeId: issued.challengeId, code }, ctx(CTX_IPS[5]!)),
    "EMAIL_RATE_LIMITED",
  );
});

/* -------------------------------------------------------------- 期限与用途 */

dbTest(
  "期限：过期挑战（库内回拨）不能验证也不能消费；用途 / 目标不符直接拒绝且不计失败",
  async () => {
    const sender = new FakeEmailSender();
    const clock = new TestClock();
    const { challenges } = buildService(sender, clock);

    const issued = await challenges.requestEmailChallenge(
      { userId: UNCERTAIN_ID, purpose: "EMAIL_BIND", targetEmail: UNCERTAIN_EMAIL },
      ctx(CTX_IPS[0]!),
    );
    const code = sender.codeFrom(0);

    // 用途 / 目标不符：拒绝且**不计入**失败次数（服务端调用方用错准入）。
    await expectCode(
      () =>
        challenges.verifyEmailChallenge(
          { challengeId: issued.challengeId, code, expectedPurpose: "EMAIL_CHANGE_NEW" },
          ctx(CTX_IPS[0]!),
        ),
      "EMAIL_CHALLENGE_INVALID",
    );
    assert.equal(await counterRow(emailBucketKeys.verifyFailure(UNCERTAIN_ID, "EMAIL_BIND")), null);
    await expectCode(
      () =>
        inSerializableTransaction((tx) =>
          consumeEmailChallenge(tx, {
            challengeId: issued.challengeId,
            code,
            purpose: "EMAIL_CHANGE_NEW",
          }),
        ),
      "EMAIL_CHALLENGE_INVALID",
    );

    // 期限：库内回拨 expires_at 到过去 —— 正确的验证码同样不能通过，且要计失败。
    // 回拨取 60s 而非 1s：注入时钟可能比真实时间慢一秒以上，1s 回拨不保证已过期。
    await getDb().emailChallenge.update({
      where: { id: issued.challengeId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await expectCode(
      () =>
        challenges.verifyEmailChallenge(
          { challengeId: issued.challengeId, code },
          ctx(CTX_IPS[0]!),
        ),
      "EMAIL_CHALLENGE_INVALID",
    );
    assert.equal(
      (await counterRow(emailBucketKeys.verifyFailure(UNCERTAIN_ID, "EMAIL_BIND")))?.counter,
      1,
    );
    await expectCode(
      () =>
        inSerializableTransaction((tx) =>
          consumeEmailChallenge(tx, {
            challengeId: issued.challengeId,
            code,
            purpose: "EMAIL_BIND",
          }),
        ),
      "EMAIL_CHALLENGE_INVALID",
    );
    const row = await getDb().emailChallenge.findUniqueOrThrow({
      where: { id: issued.challengeId },
    });
    assert.equal(row.status, "ACTIVE", "过期未消费的挑战不被改写状态（清理按到期收走）");
  },
);

/* ------------------------------------------------------------ 并发消费竞争 */

dbTest("同一挑战 / 同一授权并发消费最多一次成功", async () => {
  const sender = new FakeEmailSender();
  const clock = new TestClock();
  const { challenges, passwordReset } = buildService(sender, clock);

  const issued = await challenges.requestEmailChallenge(
    { userId: MEMBER_ID, purpose: "PASSWORD_RESET" },
    ctx(CTX_IPS[0]!),
  );
  const code = sender.codeFrom(0);
  await challenges.verifyEmailChallenge(
    { challengeId: issued.challengeId, code },
    ctx(CTX_IPS[0]!),
  );

  const challengeConsumers = await Promise.allSettled(
    [1, 2, 3].map(() =>
      inSerializableTransaction((tx) =>
        consumeEmailChallenge(tx, {
          challengeId: issued.challengeId,
          code,
          purpose: "PASSWORD_RESET",
        }),
      ),
    ),
  );
  assert.equal(
    challengeConsumers.filter((item) => item.status === "fulfilled").length,
    1,
    "同一挑战并发消费必须只有一份有效证明",
  );

  clock.advance(61_000);
  const issued2 = await challenges.requestEmailChallenge(
    { userId: MEMBER_ID, purpose: "PASSWORD_RESET" },
    ctx(CTX_IPS[0]!),
  );
  const code2 = sender.codeFrom(1);
  const auth = await passwordReset.verifyChallengeAndIssue(
    { challengeId: issued2.challengeId, code: code2 },
    ctx(CTX_IPS[0]!),
  );
  const authConsumers = await Promise.allSettled(
    [1, 2, 3].map(() =>
      inSerializableTransaction((tx) =>
        consumePasswordResetAuthorization(tx, { token: auth.token, context: ctx(CTX_IPS[0]!) }),
      ),
    ),
  );
  assert.equal(
    authConsumers.filter((item) => item.status === "fulfilled").length,
    1,
    "同一授权并发消费必须只有一次成功",
  );
  for (const item of authConsumers) {
    if (item.status === "rejected") {
      assert.ok(item.reason instanceof AppError);
      assert.equal(item.reason.code, "EMAIL_RESET_AUTHORIZATION_INVALID");
    }
  }
});

dbTest("授权消费卡在资格读取期间跨过到期时刻：拒绝且不消费（F3 返修）", async () => {
  const sender = new FakeEmailSender();
  const clock = new TestClock();
  const { challenges, passwordReset } = buildService(sender, clock);

  const issued = await challenges.requestEmailChallenge(
    { userId: MEMBER_ID, purpose: "PASSWORD_RESET" },
    ctx(CTX_IPS[0]!),
  );
  const code = sender.codeFrom(0);
  const auth = await passwordReset.verifyChallengeAndIssue(
    { challengeId: issued.challengeId, code },
    ctx(CTX_IPS[0]!),
  );

  // 持有者先锁住用户行并等到锁确实在手；消费事务读完授权行后的资格读取（users）
  // 会停在这个 X 锁上（serializable 的读为共享锁读）。
  let holderLocked!: () => void;
  const holderLockedPromise = new Promise<void>((resolve) => {
    holderLocked = resolve;
  });
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  const holder = getDb().$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${MEMBER_ID} FOR UPDATE`;
      holderLocked();
      await holderGate;
    },
    { timeout: 20_000 },
  );
  await holderLockedPromise;

  // 消费路径的取时次序：第一次取时（锁后初检）→ 卡在资格读取 → 第二次取时
  // （条件消费前复核期限）。第二次取时在等待期间跨过到期时刻后必须拒绝消费。
  let nowCalls = 0;
  let firstNowCalled!: () => void;
  const firstNowCall = new Promise<void>((resolve) => {
    firstNowCalled = resolve;
  });
  const consuming = getDb()
    .$transaction(
      (tx) =>
        consumePasswordResetAuthorization(tx, {
          token: auth.token,
          context: ctx(CTX_IPS[0]!),
          now: () => {
            nowCalls += 1;
            if (nowCalls === 1) firstNowCalled();
            return clock.now();
          },
        }),
      { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 },
    )
    .then(
      () => "FULFILLED" as const,
      (error: unknown) => error,
    );

  // 初检已在等待前完成（第一次取时发生）；确认消费确实停在资格读取的锁等待上
  // （150ms 内未结束、且尚未执行复核取时），然后让时间跨过到期时刻、解除等待。
  await firstNowCall;
  const settledEarly = await Promise.race([
    consuming.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
  ]);
  assert.equal(settledEarly, false, "消费应停在资格读取的锁等待上");
  assert.equal(nowCalls, 1, "等待期间不得提前执行条件消费前的复核取时");
  clock.advance(PASSWORD_RESET_AUTHORIZATION_TTL_MS + 60_000);
  releaseHolder();
  await holder;

  const outcome = await consuming;
  assert.ok(outcome instanceof AppError, `消费必须被拒绝，实际：${String(outcome)}`);
  assert.equal(outcome.code, "EMAIL_RESET_AUTHORIZATION_INVALID");
  assert.ok(nowCalls >= 2, "条件消费前必须重新取时复核期限");
  const row = await getDb().passwordResetAuthorization.findUniqueOrThrow({
    where: { id: auth.grantId },
  });
  assert.equal(row.status, "ISSUED", "跨期后不得消费授权");
  assert.equal(row.finishedAt, null);
  assert.equal(
    await getDb().auditLog.count({
      where: { action: "email.reset.authorization.consumed", targetId: auth.grantId },
    }),
    0,
  );
});

/* ------------------------------------------------------------ 全站预算竞争 */

dbTest("预算最后一个名额竞争不超发：并发请求只有额度内数量成功", async () => {
  process.env.EMAIL_DAILY_BUDGET = "2";
  resetServerEnvForTests();
  try {
    const sender = new FakeEmailSender();
    const clock = new TestClock();
    const { challenges } = buildService(sender, clock);
    const users = [BUDGET1_ID, BUDGET2_ID, BUDGET3_ID];
    const settled = await Promise.allSettled(
      users.map((userId, index) =>
        challenges.requestEmailChallenge(
          { userId, purpose: "EMAIL_BIND", targetEmail: BUDGET_EMAILS[index]! },
          ctx(CTX_IPS[index]!),
        ),
      ),
    );
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    assert.equal(fulfilled.length, 2, "预算为 2 时最多 2 封成功");
    const rejected = settled.filter((item) => item.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof AppError);
    assert.equal(rejected[0]!.reason.code, "EMAIL_BUDGET_EXHAUSTED");
    assert.equal(sender.messages.length, 2, "被拒绝的请求不得发送邮件");
    const dayBudget = await counterRow(emailBucketKeys.budgetDay());
    assert.equal(dayBudget?.counter, 2, "预算计数不得超发");
    // 预算拒绝留痕（受控事件）。
    assert.ok(
      (await getDb().auditLog.count({
        where: { action: "email.challenge.requested", errorCode: "EMAIL_BUDGET_EXHAUSTED" },
      })) >= 1,
    );
  } finally {
    delete process.env.EMAIL_DAILY_BUDGET;
    resetServerEnvForTests();
  }
});

/* -------------------------------------------------- 计数桶等锁取时（F3 补充） */

dbTest(
  "计数桶等锁后取时：锁等待期间跨过冷却截止应按锁后时刻放行并重建完整窗口（F3 补充）",
  async () => {
    const sender = new FakeEmailSender();
    const clock = new TestClock();
    const { challenges } = buildService(sender, clock);

    // 预置「即将到期」的冷却桶：窗口还剩 1 秒、计数已到上限 ——
    // 若沿用等锁前的时间判定会被限流，按锁后时间则已过期、应放行并重建窗口。
    const cooldownKey = emailBucketKeys.sendCooldownUser(FAIL_ID);
    const cooldownDigest = digestEmailBucketKey(cooldownKey);
    const startNow = clock.now();
    await getDb().emailSecurityCounter.create({
      data: {
        bucketKeyDigest: cooldownDigest,
        counter: 1,
        windowStartedAt: new Date(startNow.getTime() - 59_000),
        windowExpiresAt: new Date(startNow.getTime() + 1_000),
        blockedUntil: null,
        updatedAt: startNow,
      },
    });

    // 持有者锁住同一冷却桶行：预占会停在等这条锁上（取时发生在锁齐之后）。
    let holderLocked!: () => void;
    const holderLockedPromise = new Promise<void>((resolve) => {
      holderLocked = resolve;
    });
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = getDb().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT bucket_key_digest FROM email_security_counters WHERE bucket_key_digest = ${cooldownDigest} FOR UPDATE`;
        holderLocked();
        await holderGate;
      },
      { timeout: 20_000 },
    );
    await holderLockedPromise;

    const requesting = challenges
      .requestEmailChallenge(
        { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
        ctx(CTX_IPS[0]!),
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    // 确认预占确实停在锁等待上（尚未取任何决策时间）。
    const settledEarly = await Promise.race([
      requesting.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    assert.equal(settledEarly, false, "预占应停在冷却桶的锁等待上");

    // 等待期间推进注入时间跨过冷却截止，再解除等待：应按锁后时间放行。
    clock.advance(2_000);
    const postWaitNow = clock.now();
    releaseHolder();
    await holder;

    const outcome = await requesting;
    if (!outcome.ok) {
      assert.fail(`应按锁后时间放行，实际：${String(outcome.error)}`);
    }
    assert.equal(sender.messages.length, 1, "放行后应发出验证码邮件");

    // 冷却桶以锁后时刻重建：计数归 1、窗口从锁后时刻起算并保留完整 60 秒。
    const cooldown = await counterRow(cooldownKey);
    assert.ok(cooldown, "冷却桶必须存在");
    assert.equal(cooldown.counter, 1);
    assert.equal(cooldown.windowStartedAt.getTime(), postWaitNow.getTime());
    assert.equal(
      cooldown.windowExpiresAt.getTime() - cooldown.windowStartedAt.getTime(),
      EMAIL_SEND_COOLDOWN_MS,
    );

    // 挑战 createdAt / expiresAt 同样以本次实际预占时刻（锁后）为准。
    const row = await getDb().emailChallenge.findUniqueOrThrow({
      where: { id: outcome.value.challengeId },
    });
    assert.equal(row.createdAt.getTime(), postWaitNow.getTime());
    assert.equal(
      new Date(outcome.value.expiresAt).getTime(),
      postWaitNow.getTime() + EMAIL_CHALLENGE_TTL_MS,
    );
  },
);

/* -------------------------------------------------- SMTP 失败 / 不确定语义 */

dbTest("SMTP 失败 / 不确定：挑战不可验证、不退款不补发，冷却后主动重发成功", async () => {
  const sender = new FakeEmailSender();
  const clock = new TestClock();
  const { challenges } = buildService(sender, clock);

  // 明确失败：额度与冷却保留（不自动退款）。
  sender.outcome = { status: "FAILED" };
  await expectCode(
    () =>
      challenges.requestEmailChallenge(
        { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
        ctx(CTX_IPS[0]!),
      ),
    "EMAIL_SEND_FAILED",
  );
  assert.equal((await counterRow(emailBucketKeys.sendCooldownUser(FAIL_ID)))?.counter, 1);
  assert.equal((await counterRow(emailBucketKeys.sendDailyUser(FAIL_ID)))?.counter, 1);
  assert.ok(
    (await getDb().auditLog.count({
      where: { action: "email.challenge.send_failed", errorCode: "EMAIL_SEND_FAILED" },
    })) === 1,
  );
  const failedChallenge = await getDb().emailChallenge.findFirst({
    where: { userId: FAIL_ID },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(failedChallenge?.status, "PENDING", "失败挑战保持不可验证");
  // 冷却内立即重发被拒（额度不退款）。
  await expectCode(
    () =>
      challenges.requestEmailChallenge(
        { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
        ctx(CTX_IPS[0]!),
      ),
    "EMAIL_RATE_LIMITED",
  );
  // 结果不确定：同样不可验证、额度保留。
  sender.outcome = { status: "UNCERTAIN" };
  await expectCode(
    () =>
      challenges.requestEmailChallenge(
        { userId: UNCERTAIN_ID, purpose: "EMAIL_BIND", targetEmail: UNCERTAIN_EMAIL },
        ctx(CTX_IPS[0]!),
      ),
    "EMAIL_SEND_UNCERTAIN",
  );
  const uncertainChallenge = await getDb().emailChallenge.findFirst({
    where: { userId: UNCERTAIN_ID },
  });
  assert.equal(uncertainChallenge?.status, "PENDING");

  // 冷却过后主动重发成功，新挑战可验证。
  clock.advance(61_000);
  sender.outcome = { status: "ACCEPTED" };
  const retried = await challenges.requestEmailChallenge(
    { userId: FAIL_ID, purpose: "EMAIL_BIND", targetEmail: FAIL_EMAIL },
    ctx(CTX_IPS[0]!),
  );
  const retriedRow = await getDb().emailChallenge.findUniqueOrThrow({
    where: { id: retried.challengeId },
  });
  assert.equal(retriedRow.status, "ACTIVE");
});

/* -------------------------------------------------------- 身份唯一约束与兼容 */

dbTest(
  "邮箱身份数据库约束：一人一有效邮箱、一邮箱全局一人、非 EMAIL 行不得携带有效键",
  async () => {
    const db = getDb();
    const now = new Date();
    // 同一用户的第二个「有效邮箱」被唯一键拦下。
    await assert.rejects(
      () =>
        db.userIdentity.create({
          data: {
            id: randomUUID(),
            userId: MEMBER_ID,
            type: "EMAIL",
            identifierNormalized: "second146@example.com",
            verifiedAt: now,
            activeEmailKey: `email:${MEMBER_ID}`,
            createdAt: now,
            updatedAt: now,
          },
        }),
      (error: unknown) => (error as { code?: string }).code === "P2002",
    );
    // 同一规范化邮箱不能归属第二个用户（全局唯一，软删除也不释放）。
    await assert.rejects(
      () =>
        db.userIdentity.create({
          data: {
            id: randomUUID(),
            userId: BIND_ID,
            type: "EMAIL",
            identifierNormalized: MEMBER_EMAIL,
            createdAt: now,
            updatedAt: now,
          },
        }),
      (error: unknown) => (error as { code?: string }).code === "P2002",
    );
    // CHECK 约束：active_email_key 只可能出现在 EMAIL 行上。
    await assert.rejects(
      () =>
        db.userIdentity.create({
          data: {
            id: randomUUID(),
            userId: BIND_ID,
            type: "QQ",
            identifierNormalized: "146000001",
            activeEmailKey: `email:${BIND_ID}`,
            createdAt: now,
            updatedAt: now,
          },
        }),
      (error: unknown) => /active_email_key_chk|Check constraint/i.test(String(error)),
    );
    // 历史非 EMAIL 身份不受影响：可正常插入，active_email_key 保持 NULL。
    const qq = await db.userIdentity.create({
      data: {
        id: randomUUID(),
        userId: MEMBER_ID,
        type: "QQ",
        identifierNormalized: "146000002",
        createdAt: now,
        updatedAt: now,
      },
    });
    assert.equal(qq.activeEmailKey, null);
    assert.equal(qq.verifiedAt, null);
  },
);

/* ------------------------------------------------------------- 有界清理服务 */

dbTest("清理服务：只删保留期外的终结 / 过期记录与失效计数桶，不动有效数据", async () => {
  const db = getDb();
  const now = new Date();
  const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000);
  const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1_000);
  const digest = () => new Uint8Array(32).fill(7);

  const makeChallenge = async (
    id: string,
    status: string,
    expiresAt: Date,
    finishedAt: Date | null,
  ) => {
    await db.emailChallenge.create({
      data: {
        id,
        userId: BIND_ID,
        purpose: "EMAIL_BIND",
        targetEmailNormalized: BIND_EMAIL,
        codeDigest: digest(),
        status,
        expiresAt,
        finishedAt,
        createdAt: old,
        updatedAt: old,
      },
    });
  };
  const oldConsumedId = randomUUID();
  const recentConsumedId = randomUUID();
  const oldExpiredPendingId = randomUUID();
  await makeChallenge(oldConsumedId, "CONSUMED", old, old);
  await makeChallenge(recentConsumedId, "CONSUMED", recent, recent);
  await makeChallenge(oldExpiredPendingId, "PENDING", old, null);

  const oldAuthId = randomUUID();
  const freshAuthId = randomUUID();
  await db.passwordResetAuthorization.create({
    data: {
      id: oldAuthId,
      userId: MEMBER_ID,
      emailIdentityId: ADMIN_EMAIL_ROW_ID,
      emailNormalized: MEMBER_EMAIL,
      credentialVersion: 0,
      tokenDigest: digest(),
      status: "ISSUED",
      expiresAt: old,
      finishedAt: null,
      createdAt: old,
      updatedAt: old,
    },
  });
  await db.passwordResetAuthorization.create({
    data: {
      id: freshAuthId,
      userId: MEMBER_ID,
      emailIdentityId: ADMIN_EMAIL_ROW_ID,
      emailNormalized: MEMBER_EMAIL,
      credentialVersion: 0,
      tokenDigest: new Uint8Array(32).fill(9),
      status: "ISSUED",
      expiresAt: new Date(now.getTime() + 60_000),
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  const staleCounterKey = emailBucketKeys.verifyIp("10.146.99.1");
  const activeCounterKey = emailBucketKeys.verifyIp("10.146.99.2");
  const blockedCounterKey = emailBucketKeys.verifyIp("10.146.99.3");
  const renewedCounterKey = emailBucketKeys.verifyIp("10.146.99.4");
  const insertCounter = (key: string, windowExpiresAt: Date, blockedUntil: Date | null) =>
    db.emailSecurityCounter.create({
      data: {
        bucketKeyDigest: digestEmailBucketKey(key),
        counter: 1,
        windowStartedAt: old,
        windowExpiresAt,
        blockedUntil,
        updatedAt: old,
      },
    });
  await insertCounter(staleCounterKey, old, null);
  await insertCounter(activeCounterKey, new Date(now.getTime() + 3_600_000), null);
  await insertCounter(blockedCounterKey, old, new Date(now.getTime() + 300_000));
  await insertCounter(renewedCounterKey, old, null);

  try {
    const result = await purgeExpiredEmailSecurityRecords({
      now,
      batchSize: 50,
      // 候选选出后、删除前，该桶被并发请求续用（窗口顺延、计数增长）：
      // 删除条件必须复检「仍过期且无活动阻断」，不得把续用过的桶一并删掉。
      beforeCounterDelete: async () => {
        await db.emailSecurityCounter.update({
          where: { bucketKeyDigest: digestEmailBucketKey(renewedCounterKey) },
          data: {
            counter: 3,
            windowExpiresAt: new Date(now.getTime() + 3_600_000),
            updatedAt: now,
          },
        });
      },
    });
    assert.ok(
      result.challengesDeleted >= 2,
      `应删除 2 条过期挑战，实际 ${result.challengesDeleted}`,
    );
    assert.equal(
      await db.emailChallenge.count({ where: { id: oldConsumedId } }),
      0,
      "保留期外的终结挑战必须被清理",
    );
    assert.equal(await db.emailChallenge.count({ where: { id: recentConsumedId } }), 1);
    assert.equal(await db.emailChallenge.count({ where: { id: oldExpiredPendingId } }), 0);
    assert.equal(await db.passwordResetAuthorization.count({ where: { id: oldAuthId } }), 0);
    assert.equal(await db.passwordResetAuthorization.count({ where: { id: freshAuthId } }), 1);
    assert.equal(await counterRow(staleCounterKey), null, "失效计数桶应被清理");
    assert.ok(await counterRow(activeCounterKey), "活动窗口内的桶不得删除");
    assert.ok(await counterRow(blockedCounterKey), "仍在阻断中的桶不得删除");
    const renewed = await counterRow(renewedCounterKey);
    assert.equal(renewed?.counter, 3, "候选选出后被续用的桶不得删除，计数保持");
    assert.ok(
      renewed && renewed.windowExpiresAt.getTime() > now.getTime(),
      "被续用的桶保留顺延后的窗口",
    );
    // 幂等：再跑一轮不报错、不再误删。
    const second = await purgeExpiredEmailSecurityRecords({ now, batchSize: 50 });
    assert.equal(second.challengesDeleted + second.authorizationsDeleted, 0);
    assert.equal(second.countersDeleted, 0);
  } finally {
    await db.emailChallenge.deleteMany({
      where: { id: { in: [oldConsumedId, recentConsumedId, oldExpiredPendingId] } },
    });
    await db.passwordResetAuthorization.deleteMany({
      where: { id: { in: [oldAuthId, freshAuthId] } },
    });
    await db.emailSecurityCounter.deleteMany({
      where: {
        bucketKeyDigest: {
          in: [staleCounterKey, activeCounterKey, blockedCounterKey, renewedCounterKey].map((key) =>
            digestEmailBucketKey(key),
          ),
        },
      },
    });
  }
});
