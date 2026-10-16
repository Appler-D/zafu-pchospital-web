import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, test } from "node:test";
import {
  AccountEmailService,
  getEmailVerificationState,
} from "../../src/features/email/account-email-service";
import { inSerializableTransaction } from "../../src/lib/db/transaction";
import {
  consumeEmailChallenge,
  EmailChallengeService,
} from "../../src/features/email/email-challenge-service";
import { emailBucketKeys } from "../../src/features/email/email-rate-limit";
import { PasswordResetService } from "../../src/features/email/password-reset-service";
import { authService } from "../../src/features/auth/auth-service";
import { getDb, disconnectDb } from "../../src/lib/db/client";
import { resetServerEnvForTests } from "../../src/lib/env";
import { digestEmailBucketKey } from "../../src/lib/security/email-security";
import { digestSessionToken, hashPassword } from "../../src/lib/security/secrets";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { accountEmailRoute, adminEmailRoute } from "../../src/lib/api/account-email-routes";
import type { AuthorizedActor, EmailChallengeRequestResult } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;
process.env.MAIL_ENABLED = "true";
process.env.SMTP_HOST = "smtp.example.test";
process.env.SMTP_PORT = "465";
process.env.SMTP_USER = "test@example.com";
process.env.SMTP_PASSWORD = "fake-smtp-password";
process.env.MAIL_FROM = "test@example.com";
process.env.EMAIL_CODE_PEPPER = "email-binding-test-pepper-at-least-32-characters";
resetServerEnvForTests();
const ids = [1, 2, 3].map((n) => `e1464444-0000-4000-8001-00000000000${n}`);
const [a, b, c] = ids as [string, string, string];
const password = "Binding-password-146!";
const context = { requestId: "email-binding-test", ipAddress: "10.146.4.1" };
const actor: AuthorizedActor = {
  ...context,
  actorType: "USER",
  userId: a,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
};
const email = (n: number) => `binding146-${n}@example.com`;
let now: number, service: AccountEmailService, challenges: EmailChallengeService;
let sent: string[];
const token = (id: string) => `binding146-session-${id}`;
const proof = (r: EmailChallengeRequestResult) => ({ challengeId: r.challengeId, code: "123456" });
async function expectCode(run: () => Promise<unknown>, code: string) {
  await assert.rejects(
    run,
    (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === code,
  );
}
async function cleanup() {
  const db = getDb();
  await db.emailAssistance.deleteMany({ where: { userId: { in: ids } } });
  await db.emailExemption.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetAuthorization.deleteMany({ where: { userId: { in: ids } } });
  await db.emailChallenge.deleteMany({ where: { userId: { in: ids } } });
  await db.authSession.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: ids } },
        { targetId: { in: ids } },
        { requestId: context.requestId },
      ],
    },
  });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.memberProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.userRole.deleteMany({ where: { userId: { in: ids } } });
  await db.userIdentity.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  const keys = [
    emailBucketKeys.budgetDay(),
    emailBucketKeys.budgetMinute(),
    emailBucketKeys.sendDailyIp(context.ipAddress),
    emailBucketKeys.verifyIp(context.ipAddress),
  ];
  for (const id of ids) {
    keys.push(emailBucketKeys.sendCooldownUser(id), emailBucketKeys.sendDailyUser(id));
    for (const p of [
      "EMAIL_BIND",
      "EMAIL_CHANGE_OLD",
      "EMAIL_CHANGE_NEW",
      "PASSWORD_RESET",
      "ACCOUNT_EMAIL_PASSWORD",
    ])
      keys.push(emailBucketKeys.verifyFailure(id, p));
  }
  for (let n = 1; n <= 12; n++)
    keys.push(
      emailBucketKeys.sendCooldownEmail(email(n)),
      emailBucketKeys.sendDailyEmail(email(n)),
    );
  await db.emailSecurityCounter.deleteMany({
    where: { bucketKeyDigest: { in: keys.map(digestEmailBucketKey) } },
  });
}
before(async () => {
  if (!enabled) return;
  const db = getDb();
  for (const code of ["ADMIN", "MEMBER"])
    await db.role.upsert({
      where: { code },
      create: { id: randomUUID(), code, name: code, createdAt: new Date() },
      update: {},
    });
});
beforeEach(async () => {
  if (!enabled) return;
  await cleanup();
  now = Date.now();
  sent = [];
  challenges = new EmailChallengeService({
    now: () => new Date(now),
    codeFactory: () => "123456",
    sender: {
      send: async (m) => {
        sent.push(m.to);
        return { status: "ACCEPTED" };
      },
    },
  });
  service = new AccountEmailService({ challenges, now: () => new Date(now) });
  const db = getDb(),
    at = new Date();
  const hash = await hashPassword(password);
  for (const id of ids) {
    await db.user.create({
      data: { id, status: "ACTIVE", displayName: "邮箱测试", createdAt: at, updatedAt: at },
    });
    const role = await db.role.findUniqueOrThrow({
      where: { code: id === c ? "MEMBER" : "ADMIN" },
    });
    await db.userRole.create({
      data: {
        id: randomUUID(),
        userId: id,
        roleId: role.id,
        sourceType: "ADMIN_CREATED",
        grantedAt: at,
        activeKey: `${id}:${role.id}`,
      },
    });
    if (id === c)
      await db.memberProfile.create({
        data: {
          id: randomUUID(),
          userId: id,
          realName: "邮箱测试成员",
          status: "ACTIVE",
          joinedAt: at,
          createdAt: at,
          updatedAt: at,
        },
      });
    await db.userIdentity.create({
      data: {
        id: randomUUID(),
        userId: id,
        type: "QQ",
        identifierNormalized: `14644440${ids.indexOf(id)}`,
        createdAt: at,
        updatedAt: at,
      },
    });
    await db.passwordCredential.create({
      data: {
        userId: id,
        passwordHash: hash,
        mustChangePassword: false,
        createdAt: at,
        updatedAt: at,
      },
    });
    await db.authSession.create({
      data: {
        id: randomUUID(),
        userId: id,
        tokenDigest: digestSessionToken(token(id)),
        createdAt: at,
        lastSeenAt: at,
        expiresAt: new Date(now + 86400000),
        rememberMe: true,
      },
    });
  }
});
after(async () => {
  if (enabled) {
    await cleanup();
    await disconnectDb();
  }
});

dbTest("初绑→正常换绑，证明原子消费、历史邮箱不释放、保留会话期限", async () => {
  const db = getDb();
  const original = await db.authSession.findUniqueOrThrow({
    where: { tokenDigest: digestSessionToken(token(c)) },
  });
  const r = await service.requestChallenge(
    token(c),
    { mode: "BIND", targetEmail: email(1) },
    context,
  );
  assert.equal(await db.userIdentity.count({ where: { userId: c, type: "EMAIL" } }), 0);
  await expectCode(
    () =>
      service.confirm(token(b), { mode: "BIND", targetEmail: email(1), proof: proof(r) }, context),
    "EMAIL_CHALLENGE_INVALID",
  );
  const first = await service.confirm(
    token(c),
    { mode: "BIND", targetEmail: email(1), proof: proof(r) },
    context,
  );
  await expectCode(() => authService.authenticate(token(c)), "AUTH_SESSION_INVALID");
  now += 61000;
  const resetCode = await challenges.requestEmailChallenge(
    { userId: c, purpose: "PASSWORD_RESET" },
    context,
  );
  const authorization = await new PasswordResetService({
    challengeService: challenges,
    now: () => new Date(now),
  }).verifyChallengeAndIssue(proof(resetCode), context);
  now += 61000;
  const old = await service.requestChallenge(
    first.token,
    { mode: "OLD", currentPassword: password },
    context,
  );
  await expectCode(
    () =>
      service.requestChallenge(
        first.token,
        { mode: "NEW", currentPassword: password, targetEmail: email(2), old: proof(old) },
        context,
      ),
    "EMAIL_RATE_LIMITED",
  );
  now += 61000;
  const next = await service.requestChallenge(
    first.token,
    { mode: "NEW", currentPassword: password, targetEmail: email(2), old: proof(old) },
    context,
  );
  assert.equal(
    (await db.emailChallenge.findUniqueOrThrow({ where: { id: old.challengeId } })).status,
    "ACTIVE",
  );
  await expectCode(
    () =>
      service.confirm(
        first.token,
        {
          mode: "CHANGE",
          currentPassword: password,
          targetEmail: email(2),
          old: proof(old),
          proof: { ...proof(next), code: "999999" },
        },
        context,
      ),
    "EMAIL_CHALLENGE_INVALID",
  );
  assert.equal((await service.getState(first.token)).email, email(1));
  const done = await service.confirm(
    first.token,
    {
      mode: "CHANGE",
      currentPassword: password,
      targetEmail: email(2),
      old: proof(old),
      proof: proof(next),
    },
    context,
  );
  assert.equal(
    (
      await db.passwordResetAuthorization.findUniqueOrThrow({
        where: { id: authorization.grantId },
      })
    ).status,
    "INVALIDATED",
  );
  const session = await authService.authenticate(done.token);
  assert.equal(session.expiresAt, original.expiresAt.toISOString());
  assert.equal(session.rememberMe, true);
  assert.equal((await service.getState(done.token)).email, email(2));
  assert.equal(
    (await db.emailChallenge.findUniqueOrThrow({ where: { id: old.challengeId } })).status,
    "CONSUMED",
  );
  await expectCode(
    () => service.requestChallenge(token(b), { mode: "BIND", targetEmail: email(1) }, context),
    "EMAIL_ALREADY_BOUND",
  );
});

dbTest("历史 activeEmailKey 空值仍已绑定；用途/密码/强制改密拒绝", async () => {
  const db = getDb(),
    at = new Date(now);
  await db.userIdentity.create({
    data: {
      id: randomUUID(),
      userId: b,
      type: "EMAIL",
      identifierNormalized: email(1),
      verifiedAt: at,
      createdAt: at,
      updatedAt: at,
    },
  });
  assert.equal((await service.getState(token(b))).email, email(1));
  await expectCode(
    () => service.requestChallenge(token(b), { mode: "BIND", targetEmail: email(2) }, context),
    "EMAIL_CHALLENGE_INVALID",
  );
  const r = await service.requestChallenge(
    token(c),
    { mode: "BIND", targetEmail: email(3) },
    context,
  );
  await expectCode(
    () =>
      challenges.verifyEmailChallenge(
        { ...proof(r), expectedUserId: c, expectedPurpose: "EMAIL_CHANGE_NEW" },
        context,
      ),
    "EMAIL_CHALLENGE_INVALID",
  );
  for (let n = 0; n < 5; n++)
    await expectCode(
      () => service.requestChallenge(token(b), { mode: "OLD", currentPassword: "wrong" }, context),
      "PASSWORD_CURRENT_INVALID",
    );
  await expectCode(
    () => service.requestChallenge(token(b), { mode: "OLD", currentPassword: password }, context),
    "EMAIL_RATE_LIMITED",
  );
  await expectCode(
    () =>
      inSerializableTransaction((tx) =>
        consumeEmailChallenge(tx, { ...proof(r), purpose: "EMAIL_BIND", expectedUserId: b }),
      ),
    "EMAIL_CHALLENGE_INVALID",
  );
  await db.passwordCredential.update({
    where: { userId: c },
    data: { credentialVersion: { increment: 1 } },
  });
  await expectCode(
    () =>
      service.confirm(token(c), { mode: "BIND", targetEmail: email(3), proof: proof(r) }, context),
    "EMAIL_CHALLENGE_INVALID",
  );
  await db.passwordCredential.update({ where: { userId: c }, data: { mustChangePassword: true } });
  await expectCode(() => service.getState(token(c)), "PASSWORD_CHANGE_REQUIRED");
  assert.equal(
    (await db.emailChallenge.findUniqueOrThrow({ where: { id: r.challengeId } })).status,
    "ACTIVE",
  );
});

dbTest("协助固定目标、一次消费、无档案管理员、自助/撤销/过期/凭据变化拒绝", async () => {
  await expectCode(
    () => service.createAssistance(a, { targetEmail: email(1), reason: "原邮箱不可用" }, actor),
    "FORBIDDEN",
  );
  await service.createAssistance(
    b,
    { targetEmail: email(2), reason: "已通过原联系方式核验" },
    actor,
  );
  let astate = (await service.getState(token(b))).assistance!;
  await service.revokeAssistance(b, astate.id, actor);
  await expectCode(
    () =>
      service.requestChallenge(
        token(b),
        { mode: "ASSISTED", assistanceId: astate.id, currentPassword: password },
        context,
      ),
    "EMAIL_CHALLENGE_INVALID",
  );
  await service.createAssistance(b, { targetEmail: email(2), reason: "重新核验本人" }, actor);
  astate = (await service.getState(token(b))).assistance!;
  const r = await service.requestChallenge(
    token(b),
    { mode: "ASSISTED", assistanceId: astate.id, currentPassword: password },
    context,
  );
  const done = await service.confirm(
    token(b),
    { mode: "ASSISTED", assistanceId: astate.id, currentPassword: password, proof: proof(r) },
    context,
  );
  assert.equal((await service.getState(done.token)).email, email(2));
  assert.ok(
    (await getDb().emailAssistance.findUniqueOrThrow({ where: { id: astate.id } })).consumedAt,
  );
  await service.createAssistance(b, { targetEmail: email(3), reason: "邮箱再次不可用" }, actor);
  astate = (await service.getState(done.token)).assistance!;
  now += 30 * 60000;
  await expectCode(
    () =>
      service.requestChallenge(
        done.token,
        { mode: "ASSISTED", assistanceId: astate.id, currentPassword: password },
        context,
      ),
    "EMAIL_CHALLENGE_INVALID",
  );
  await service.createAssistance(b, { targetEmail: email(3), reason: "再次核验本人" }, actor);
  astate = (await service.getState(done.token)).assistance!;
  await getDb().passwordCredential.update({
    where: { userId: b },
    data: { credentialVersion: { increment: 1 } },
  });
  await expectCode(
    () =>
      service.requestChallenge(
        done.token,
        { mode: "ASSISTED", assistanceId: astate.id, currentPassword: password },
        context,
      ),
    "EMAIL_CHALLENGE_INVALID",
  );
});

dbTest("豁免独立于验证、到期与记录 ID 撤销、邮件关闭仍可管理及改密优先", async () => {
  process.env.MAIL_ENABLED = "false";
  resetServerEnvForTests();
  try {
    await expectCode(
      () => service.grantExemption(a, { reason: "邮箱暂不可用" }, actor),
      "FORBIDDEN",
    );
    await getDb().passwordCredential.update({
      where: { userId: b },
      data: { mustChangePassword: true },
    });
    await service.grantExemption(b, { reason: "邮箱暂不可用" }, actor);
    const initial = await service.getAdminState(b, actor);
    assert.equal(initial.verified, false);
    assert.ok(initial.exemption);
    assert.equal(initial.canAssist, false);
    assert.equal(Date.parse(initial.exemption!.expiresAt) - now, 24 * 3600000);
    await service.grantExemption(b, { reason: "重新核验需要等待", durationHours: 168 }, actor);
    await service.revokeExemption(b, initial.exemption!.id, actor);
    assert.ok((await service.getAdminState(b, actor)).exemption);
    await expectCode(() => service.getState(token(b)), "PASSWORD_CHANGE_REQUIRED");
    now += 168 * 3600000;
    assert.equal(
      (await getEmailVerificationState(b, getDb(), () => new Date(now))).exemption,
      null,
    );
    assert.equal(
      (
        await getDb().authSession.findUniqueOrThrow({
          where: { tokenDigest: digestSessionToken(token(b)) },
        })
      ).revokedAt,
      null,
    );
  } finally {
    process.env.MAIL_ENABLED = "true";
    resetServerEnvForTests();
  }
});

dbTest("代表性唯一竞争与被撤销会话不能切换，失败回滚证明", async () => {
  const r1 = await service.requestChallenge(
    token(b),
    { mode: "BIND", targetEmail: email(5) },
    context,
  );
  now += 61000;
  const r2 = await service.requestChallenge(
    token(c),
    { mode: "BIND", targetEmail: email(5) },
    context,
  );
  const results = await Promise.allSettled([
    service.confirm(token(b), { mode: "BIND", targetEmail: email(5), proof: proof(r1) }, context),
    service.confirm(token(c), { mode: "BIND", targetEmail: email(5), proof: proof(r2) }, context),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    await getDb().userIdentity.count({
      where: { type: "EMAIL", identifierNormalized: email(5), deletedAt: null },
    }),
    1,
  );
  const loser = results[0]!.status === "rejected" ? b : c;
  const rp = loser === b ? r1 : r2;
  assert.equal(
    (await getDb().emailChallenge.findUniqueOrThrow({ where: { id: rp.challengeId } })).status,
    "ACTIVE",
  );
  await getDb().authSession.updateMany({
    where: { userId: loser },
    data: { revokedAt: new Date() },
  });
  await expectCode(
    () =>
      service.confirm(
        token(loser),
        { mode: "BIND", targetEmail: email(5), proof: proof(rp) },
        context,
      ),
    "AUTH_SESSION_INVALID",
  );
});

dbTest("薄 Route：同源/认证/私有响应、Cookie 轮换、脱敏与详情访问审计", async () => {
  const base = process.env.APP_BASE_URL!;
  const req = (path: string, body?: unknown, session = token(b), origin = base) =>
    new Request(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(session ? { cookie: `pc_hospital_session=${session}` } : {}),
        origin,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const denied = await accountEmailRoute(
    req("/api/v1/account/email", {}, token(b), "https://evil.invalid"),
    "challenge",
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("cache-control"), "private, no-store");
  assert.equal(
    (await accountEmailRoute(req("/api/v1/account/email", undefined, ""), "state")).status,
    401,
  );
  const r = await service.requestChallenge(
    token(b),
    { mode: "BIND", targetEmail: email(1) },
    context,
  );
  const confirmed = await accountEmailRoute(
    req("/api/v1/account/email/confirm", {
      mode: "BIND",
      targetEmail: email(1),
      proof: proof(r),
      returnTo: "//evil.invalid",
    }),
    "confirm",
  );
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.headers.get("set-cookie")!, /HttpOnly/i);
  assert.equal(confirmed.headers.get("cache-control"), "private, no-store");
  const json = await confirmed.json();
  assert.equal(json.data.destination, "/admin");
  assert.equal(json.data.token, undefined);
  const state = await adminEmailRoute(req("/admin", undefined, token(a)), "state", b);
  const masked = await state.json();
  assert.notEqual(masked.data.maskedEmail, email(1));
  assert.equal(masked.data.verified, true);
  const revealed = await adminEmailRoute(req("/admin", {}, token(a)), "reveal", b);
  assert.equal((await revealed.json()).data.email, email(1));
  assert.equal(
    await getDb().auditLog.count({
      where: { actorUserId: a, targetId: b, action: "email.detail.revealed" },
    }),
    1,
  );
});
