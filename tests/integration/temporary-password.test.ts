import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { POST as accountLookupRoute } from "../../src/app/api/v1/admin/accounts/lookup/route";
import { POST as accountResetRoute } from "../../src/app/api/v1/admin/accounts/[userId]/password-reset/route";
import { POST as changePasswordRoute } from "../../src/app/api/v1/auth/password/change/route";
import { GET as meRoute } from "../../src/app/api/v1/me/route";
import type { Prisma } from "../../src/generated/prisma/client";
import { authService } from "../../src/features/auth/auth-service";
import { memberService } from "../../src/features/members/member-service";
import { AppError } from "../../src/lib/api/errors";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { authenticateRequest, SESSION_COOKIE_NAME } from "../../src/lib/auth/request";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import {
  digestAccountThrottleKey,
  digestLoginThrottleKey,
  hashPassword,
} from "../../src/lib/security/secrets";
import {
  TEMPORARY_PASSWORD_TTL_MS,
  TEMPORARY_SESSION_MAX_MS,
} from "../../src/lib/security/temporary-password";
import type { AuthorizedActor, PublicRequestContext } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";
import { sameOriginHeaders } from "./http-harness";

/**
 * 管理员手动重置与临时密码恢复。
 *
 * 命名空间：本文件的全部数据都挂在一组**固定 UUID**（`e113…`）上，每次 `prepareFixtures`
 * 按这组 userId 精确清理再重建，绝不触碰库里其它测试与开发数据。QQ 每次重建都用新随机值
 * （`freshQq`），避免与残留数据撞身份唯一键。
 *
 * 时间边界一律用「库内回拨」做确定性夹具（把 `temporary_expires_at` / `expires_at` 改成
 * 过去），不等真实一小时；并发场景只做两类定向时序：同码并发消费、再次签发与旧改密竞争。
 */
const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

const NAME_PREFIX = "I113 ";
const ID = (suffix: string) => `e1130000-0000-4000-8000-0000000000${suffix}`;
const ADMIN_ID = ID("01");
const MEMBER_ID = ID("02");
const ADMIN_TARGET_ID = ID("03");
const REVOKED_ID = ID("04");
const DISABLED_ID = ID("05");
const PLAIN_MEMBER_ID = ID("06");
const DELETED_ID = ID("07");
const PROFILE_ADMIN = ID("11");
const PROFILE_MEMBER = ID("12");
const PROFILE_REVOKED = ID("13");
const PROFILE_DISABLED = ID("14");
const PROFILE_PLAIN_MEMBER = ID("15");

const ADMIN_PASSWORD = "I113-Admin-Password-1";
const MEMBER_PASSWORD = "I113-Member-Password-1";
const PLAIN_MEMBER_PASSWORD = "I113-Plain-Password-1";
const MEMBER_NEW_PASSWORD = "I113-Member-New-1";

const ADMIN_ACTOR: AuthorizedActor = {
  actorType: "USER",
  userId: ADMIN_ID,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_i113_admin",
};

/** 只持有 MEMBER 权限：钉住「没有 member:manage 就不能查询 / 签发」。 */
const PLAIN_MEMBER_ACTOR: AuthorizedActor = {
  actorType: "USER",
  userId: PLAIN_MEMBER_ID,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["MEMBER"]),
  requestId: "req_i113_member",
};

/** 当前夹具里各账号的 QQ（每次重建都换新随机值，防撞身份唯一键）。 */
const qq: Record<string, string> = {};
let qqSeq = 0;
function freshQq(): string {
  qqSeq += 1;
  return `2${String(Date.now()).slice(-5)}${String(qqSeq).padStart(3, "0")}`;
}

let ctxSeq = 0;
function ctx(ip: string): PublicRequestContext {
  ctxSeq += 1;
  return { requestId: `req_i113_${ctxSeq}`, ipAddress: ip, userAgent: "i113-test" };
}

function expectCode(run: () => Promise<unknown>, code: string) {
  return assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AppError, `期望 AppError，实际：${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function createUser(input: {
  id: string;
  displayName: string;
  status?: string;
  deletedAt?: Date | null;
}) {
  const now = new Date();
  await getDb().user.create({
    data: {
      id: input.id,
      status: input.status ?? "ACTIVE",
      displayName: input.displayName,
      deletedAt: input.deletedAt ?? null,
      createdAt: now,
      updatedAt: now,
    },
  });
}

async function createProfile(id: string, userId: string, realName: string, status = "ACTIVE") {
  const now = new Date();
  await getDb().memberProfile.create({
    data: {
      id,
      userId,
      realName,
      status,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    },
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

async function attachQq(userId: string, value: string) {
  const now = new Date();
  await getDb().userIdentity.create({
    data: {
      id: randomUUID(),
      userId,
      type: "QQ",
      identifierNormalized: value,
      createdAt: now,
      updatedAt: now,
    },
  });
}

async function setCredential(userId: string, plainPassword: string) {
  const now = new Date();
  await getDb().passwordCredential.create({
    data: {
      userId,
      passwordHash: await hashPassword(plainPassword),
      mustChangePassword: false,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

const FIXTURE_IDS = [
  ADMIN_ID,
  MEMBER_ID,
  ADMIN_TARGET_ID,
  REVOKED_ID,
  DISABLED_ID,
  PLAIN_MEMBER_ID,
  DELETED_ID,
  PROFILE_ADMIN,
  PROFILE_MEMBER,
  PROFILE_REVOKED,
  PROFILE_DISABLED,
  PROFILE_PLAIN_MEMBER,
];

/** 按固定 userId 清掉本文件建的一切（顺序满足 RESTRICT 外键），再重建全部角色与账号。 */
async function prepareFixtures(): Promise<void> {
  const db = getDb();
  for (const key of Object.keys(qq)) delete qq[key];

  await db.auditLog.deleteMany({
    where: { OR: [{ actorUserId: { in: FIXTURE_IDS } }, { targetId: { in: FIXTURE_IDS } }] },
  });
  await db.authSession.deleteMany({ where: { userId: { in: FIXTURE_IDS } } });
  // 账号桶键只由固定 userId 决定（与 pepper 一起 HMAC），跨运行是同一个键 ——
  // 上一次中断留下的阻断必须清掉，否则新运行会莫名进入 429。
  await db.loginThrottle.deleteMany({
    where: { keyDigest: { in: FIXTURE_IDS.map((id) => digestAccountThrottleKey(id)) } },
  });
  await db.passwordCredential.deleteMany({ where: { userId: { in: FIXTURE_IDS } } });
  await db.userRole.deleteMany({ where: { userId: { in: FIXTURE_IDS } } });
  await db.memberProfile.deleteMany({ where: { userId: { in: FIXTURE_IDS } } });
  await db.userIdentity.deleteMany({ where: { userId: { in: FIXTURE_IDS } } });
  await db.user.deleteMany({ where: { id: { in: FIXTURE_IDS } } });

  // 角色是共享 seed 数据：只补建，不删除（其它测试文件依赖同一份）。
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

  qq.admin = freshQq();
  qq.member = freshQq();
  qq.adminTarget = freshQq();
  qq.revoked = freshQq();
  qq.disabled = freshQq();
  qq.plainMember = freshQq();
  qq.deleted = freshQq();

  await createUser({ id: ADMIN_ID, displayName: `${NAME_PREFIX}Admin` });
  await createProfile(PROFILE_ADMIN, ADMIN_ID, `${NAME_PREFIX}Admin`);
  await attachRole(ADMIN_ID, "ADMIN");
  await attachQq(ADMIN_ID, qq.admin!);
  await setCredential(ADMIN_ID, ADMIN_PASSWORD);

  await createUser({ id: MEMBER_ID, displayName: `${NAME_PREFIX}成员` });
  await createProfile(PROFILE_MEMBER, MEMBER_ID, `${NAME_PREFIX}成员`);
  await attachRole(MEMBER_ID, "MEMBER");
  await attachQq(MEMBER_ID, qq.member!);
  await setCredential(MEMBER_ID, MEMBER_PASSWORD);

  // 管理员目标：没有成员档案、也没有既有凭据 —— 覆盖「按 userId 定位」与 upsert 建行。
  await createUser({ id: ADMIN_TARGET_ID, displayName: `${NAME_PREFIX}另一位管理员` });
  await attachRole(ADMIN_TARGET_ID, "ADMIN");
  await attachQq(ADMIN_TARGET_ID, qq.adminTarget!);

  await createUser({ id: REVOKED_ID, displayName: `${NAME_PREFIX}已撤成员` });
  await createProfile(PROFILE_REVOKED, REVOKED_ID, `${NAME_PREFIX}已撤成员`, "REVOKED");
  await attachRole(REVOKED_ID, "MEMBER");
  await attachQq(REVOKED_ID, qq.revoked!);
  await setCredential(REVOKED_ID, MEMBER_PASSWORD);

  await createUser({ id: DISABLED_ID, displayName: `${NAME_PREFIX}禁用成员`, status: "DISABLED" });
  await createProfile(PROFILE_DISABLED, DISABLED_ID, `${NAME_PREFIX}禁用成员`);
  await attachRole(DISABLED_ID, "MEMBER");
  await attachQq(DISABLED_ID, qq.disabled!);
  await setCredential(DISABLED_ID, MEMBER_PASSWORD);

  await createUser({
    id: DELETED_ID,
    displayName: `${NAME_PREFIX}软删账号`,
    deletedAt: new Date(),
  });
  await attachQq(DELETED_ID, qq.deleted!);
  await setCredential(DELETED_ID, MEMBER_PASSWORD);

  await createUser({ id: PLAIN_MEMBER_ID, displayName: `${NAME_PREFIX}普通成员` });
  await createProfile(PROFILE_PLAIN_MEMBER, PLAIN_MEMBER_ID, `${NAME_PREFIX}普通成员`);
  await attachRole(PLAIN_MEMBER_ID, "MEMBER");
  await attachQq(PLAIN_MEMBER_ID, qq.plainMember!);
  await setCredential(PLAIN_MEMBER_ID, PLAIN_MEMBER_PASSWORD);
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

/* ------------------------------------------------------- R02/R03/R07/R08/R09 */

dbTest("正常恢复链路：签发 → 旧凭据失效 → 受限登录 → 改密轮换正常会话", async () => {
  const db = getDb();
  // 重置前先有一个正常会话：重置必须把它一并撤销。
  const before = await authService.login(
    { qq: qq.member!, password: MEMBER_PASSWORD },
    ctx("10.2.0.1"),
  );
  assert.equal(before.mustChangePassword, false);

  const reset = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  assert.match(reset.initializationSecret!, /^\d{6}$/);
  assert.ok(reset.temporaryExpiresAt, "本次响应必须带明确到期时间");
  const ttl = new Date(reset.temporaryExpiresAt!).getTime() - Date.now();
  assert.ok(
    ttl > TEMPORARY_PASSWORD_TTL_MS - 5_000 && ttl <= TEMPORARY_PASSWORD_TTL_MS,
    `到期时间应约 1 小时，实际 ${ttl}ms`,
  );
  const secret = reset.initializationSecret!;

  // R03：旧密码与旧会话都失效。
  await expectCode(
    () => authService.login({ qq: qq.member!, password: MEMBER_PASSWORD }, ctx("10.2.0.2")),
    "AUTH_INVALID_CREDENTIALS",
  );
  await expectCode(() => authService.authenticate(before.token), "AUTH_SESSION_INVALID");

  // R02/R07：临时密码登录成功但进入受限态；即使请求保持登录也被强制 false、不越过 10 分钟。
  const tempLogin = await authService.login(
    { qq: qq.member!, password: secret, rememberMe: true },
    ctx("10.2.0.3"),
  );
  assert.equal(tempLogin.mustChangePassword, true);
  const session = await db.authSession.findUniqueOrThrow({ where: { id: tempLogin.sessionId } });
  assert.equal(session.rememberMe, false);
  assert.ok(session.expiresAt.getTime() - session.createdAt.getTime() <= TEMPORARY_SESSION_MAX_MS);
  assert.ok(session.expiresAt.getTime() <= new Date(reset.temporaryExpiresAt!).getTime());

  // 受限态：业务接口被集中门禁拦下；/me 放行且不延长到期时间。
  const gate = await authenticateRequest(
    new Request("http://localhost/api/v1/member/dashboard", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${tempLogin.token}` },
    }),
    "req_i113_gate",
  ).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(gate instanceof AppError);
  assert.equal(gate.code, "PASSWORD_CHANGE_REQUIRED");
  const meResponse = await meRoute(
    new Request("http://localhost/api/v1/me", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${tempLogin.token}` },
    }),
  );
  assert.equal(meResponse.status, 200);
  const afterMe = await db.authSession.findUniqueOrThrow({ where: { id: tempLogin.sessionId } });
  assert.equal(afterMe.expiresAt.getTime(), session.expiresAt.getTime(), "/me 不得续期");

  // 首次登录已原子消费：同一临时密码不能再登录。
  await expectCode(
    () => authService.login({ qq: qq.member!, password: secret }, ctx("10.2.0.4")),
    "AUTH_INVALID_CREDENTIALS",
  );

  // 恢复态禁止把新密码设回本次临时密码。
  await expectCode(
    () =>
      authService.changePassword(
        tempLogin.token,
        { currentPassword: secret, newPassword: secret, newPasswordConfirmation: secret },
        ctx("10.2.0.5"),
      ),
    "VALIDATION_FAILED",
  );

  // R08/R09：用临时密码完成改密，清除临时状态并轮换为正常 1 天会话。
  const changed = await authService.changePassword(
    tempLogin.token,
    {
      currentPassword: secret,
      newPassword: MEMBER_NEW_PASSWORD,
      newPasswordConfirmation: MEMBER_NEW_PASSWORD,
    },
    ctx("10.2.0.6"),
  );
  assert.equal(changed.mustChangePassword, false);
  await expectCode(() => authService.authenticate(tempLogin.token), "AUTH_SESSION_INVALID");
  const credential = await db.passwordCredential.findUniqueOrThrow({
    where: { userId: MEMBER_ID },
  });
  assert.equal(credential.temporaryExpiresAt, null);
  assert.equal(credential.temporaryConsumedAt, null);
  assert.equal(credential.mustChangePassword, false);
  // 代次：夹具 0 → 签发 +1 → 改密 +1。
  assert.equal(credential.credentialVersion, 2);
  const normal = await authService.login(
    { qq: qq.member!, password: MEMBER_NEW_PASSWORD },
    ctx("10.2.0.7"),
  );
  assert.equal(normal.mustChangePassword, false);

  // 明文不落审计、不落后续查询：重置审计只记「临时凭据 + 期限」。
  const resetAudits = await db.auditLog.findMany({
    where: { action: "auth.password.reset", targetId: PROFILE_MEMBER },
  });
  assert.equal(resetAudits.length, 1);
  const summary = JSON.stringify(resetAudits[0]!.afterSummary);
  assert.ok(!summary.includes(secret), "审计不得携带明文口令");
  assert.ok(summary.includes("temporary"));
  const detail = await memberService.getDetail(PROFILE_MEMBER, ADMIN_ACTOR);
  assert.ok(!JSON.stringify(detail).includes(secret), "详情查询不得携带明文口令");
});

/* ------------------------------------------------------------- R01/R12 权限 */

dbTest("账号恢复：成员与管理员（含无档案管理员）都可签发；自我与无效账号被拒", async () => {
  const memberLookup = await memberService.lookupAccount({ qq: qq.member! }, ADMIN_ACTOR);
  assert.equal(memberLookup.userId, MEMBER_ID);
  assert.equal(memberLookup.canReset, true);
  assert.equal(memberLookup.blockedReason, null);
  assert.deepEqual(memberLookup.roles, ["MEMBER"]);

  // 管理员可以没有成员档案：按 userId 恢复，不经过成员列表。
  const adminLookup = await memberService.lookupAccount({ qq: qq.adminTarget! }, ADMIN_ACTOR);
  assert.equal(adminLookup.userId, ADMIN_TARGET_ID);
  assert.equal(adminLookup.canReset, true);
  assert.deepEqual(adminLookup.roles, ["ADMIN"]);

  // 自我恢复被查询与签发两侧拒绝（不只是隐藏按钮）。
  const selfLookup = await memberService.lookupAccount({ qq: qq.admin! }, ADMIN_ACTOR);
  assert.equal(selfLookup.blockedReason, "SELF");
  assert.equal(selfLookup.canReset, false);
  await expectCode(() => memberService.resetAccountPassword(ADMIN_ID, ADMIN_ACTOR), "FORBIDDEN");
  await expectCode(() => memberService.resetPassword(PROFILE_ADMIN, ADMIN_ACTOR), "FORBIDDEN");

  // 禁用 / 软删 / 成员身份撤销：查询给出 blockedReason，签发被拒。
  const disabled = await memberService.lookupAccount({ qq: qq.disabled! }, ADMIN_ACTOR);
  assert.equal(disabled.blockedReason, "DISABLED");
  const revoked = await memberService.lookupAccount({ qq: qq.revoked! }, ADMIN_ACTOR);
  assert.equal(revoked.blockedReason, "MEMBER_INACTIVE");
  const deleted = await memberService.lookupAccount({ qq: qq.deleted! }, ADMIN_ACTOR);
  assert.equal(deleted.blockedReason, "DISABLED");
  await expectCode(
    () => memberService.resetAccountPassword(DISABLED_ID, ADMIN_ACTOR),
    "ACCOUNT_DISABLED",
  );
  await expectCode(
    () => memberService.resetAccountPassword(DELETED_ID, ADMIN_ACTOR),
    "ACCOUNT_DISABLED",
  );
  await expectCode(
    () => memberService.resetAccountPassword(REVOKED_ID, ADMIN_ACTOR),
    "MEMBER_PROFILE_INACTIVE",
  );
  await expectCode(
    () => memberService.lookupAccount({ qq: "1234" }, ADMIN_ACTOR),
    "VALIDATION_FAILED",
  );
  await expectCode(
    () => memberService.lookupAccount({ qq: "250000000" }, ADMIN_ACTOR),
    "RESOURCE_NOT_FOUND",
  );

  // 没有 member:manage 的成员：查询与签发都拒绝。
  await expectCode(
    () => memberService.lookupAccount({ qq: qq.member! }, PLAIN_MEMBER_ACTOR),
    "FORBIDDEN",
  );
  await expectCode(
    () => memberService.resetAccountPassword(MEMBER_ID, PLAIN_MEMBER_ACTOR),
    "FORBIDDEN",
  );

  // 无档案管理员签发成功：凭据不存在时走 upsert 建行，签发后以临时密码可登录。
  const issued = await memberService.resetAccountPassword(ADMIN_TARGET_ID, ADMIN_ACTOR);
  assert.match(issued.initializationSecret, /^\d{6}$/);
  assert.equal(issued.userId, ADMIN_TARGET_ID);
  const login = await authService.login(
    { qq: qq.adminTarget!, password: issued.initializationSecret },
    ctx("10.3.0.9"),
  );
  assert.equal(login.mustChangePassword, true);
});

/* ------------------------------------------------------------ R04/R07 到期 */

dbTest("到期即拒绝且不落普通密码分支；受限会话到期后不能再改密", async () => {
  const db = getDb();
  const reset = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  const secret = reset.initializationSecret!;

  // 确定性到期夹具：把到期时间回拨到过去（不等待真实一小时）。
  await db.passwordCredential.update({
    where: { userId: MEMBER_ID },
    data: { temporaryExpiresAt: new Date(Date.now() - 1_000) },
  });
  await expectCode(
    () => authService.login({ qq: qq.member!, password: secret }, ctx("10.4.0.1")),
    "AUTH_INVALID_CREDENTIALS",
  );
  // 关键点：到期凭据不得落回普通密码分支 —— 哈希仍匹配，但必须拒绝；
  // 且不消费、不建会话。
  const credential = await db.passwordCredential.findUniqueOrThrow({
    where: { userId: MEMBER_ID },
  });
  assert.equal(credential.temporaryConsumedAt, null);
  assert.equal(await db.authSession.count({ where: { userId: MEMBER_ID } }), 0);

  // 重新签发后（新代次）正常消费，再把受限会话回拨到期：改密必须失败。
  const reset2 = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  const tempLogin = await authService.login(
    { qq: qq.member!, password: reset2.initializationSecret! },
    ctx("10.4.0.2"),
  );
  await db.authSession.update({
    where: { id: tempLogin.sessionId },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });
  await expectCode(
    () =>
      authService.changePassword(
        tempLogin.token,
        {
          currentPassword: reset2.initializationSecret!,
          newPassword: MEMBER_NEW_PASSWORD,
          newPasswordConfirmation: MEMBER_NEW_PASSWORD,
        },
        ctx("10.4.0.3"),
      ),
    "AUTH_SESSION_EXPIRED",
  );
  // 会话过期后光记得临时密码也不行：凭据已消费，不能再登录。
  await expectCode(
    () =>
      authService.login(
        { qq: qq.member!, password: reset2.initializationSecret! },
        ctx("10.4.0.4"),
      ),
    "AUTH_INVALID_CREDENTIALS",
  );
});

/* --------------------------------------------------------------- R05 限流 */

dbTest("账号维度限流：跨 IP 累计、持久化阻断，且不被普通登录的清理误清", async () => {
  const db = getDb();
  const reset = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  // 错误密码不能恰好等于本次随机口令（百万分之一也不赌）：取相反的口令。
  const wrongPassword = reset.initializationSecret === "000000" ? "111111" : "000000";
  const accountKey = digestAccountThrottleKey(MEMBER_ID);
  const ips = ["10.5.0.1", "10.5.0.2", "10.5.0.3", "10.5.0.4", "10.5.0.5"];

  // 5 次错误密码分别来自 5 个 IP：全部通过（尚未达到阻断），账号桶累计到 5。
  for (const ip of ips) {
    await expectCode(
      () => authService.login({ qq: qq.member!, password: wrongPassword }, ctx(ip)),
      "AUTH_INVALID_CREDENTIALS",
    );
  }
  const accountRow = await db.loginThrottle.findUniqueOrThrow({ where: { keyDigest: accountKey } });
  assert.equal(accountRow.failedCount, 5);
  const blockedUntil = accountRow.blockedUntil;
  assert.ok(blockedUntil, "第 5 次失败必须写入阻断截止时间");
  const blockWindow = blockedUntil!.getTime() - Date.now();
  assert.ok(
    blockWindow > 14 * 60_000 && blockWindow <= 15 * 60_000,
    `阻断窗口异常：${blockWindow}`,
  );

  // 换 IP 也拦得住：第 6 次即使密码正确（此时凭据未消费）也直接 429。
  await expectCode(
    () =>
      authService.login({ qq: qq.member!, password: reset.initializationSecret! }, ctx("10.5.0.6")),
    "AUTH_RATE_LIMITED",
  );

  // (QQ, IP) 桶是 5 条独立行：跨 IP 不汇总，账号桶才是累计的。
  for (const ip of ips) {
    const row = await db.loginThrottle.findUnique({
      where: { keyDigest: digestLoginThrottleKey(qq.member!, ip) },
    });
    assert.equal(row?.failedCount, 1, `(${qq.member}, ${ip}) 桶应为 1 次`);
  }

  // 普通登录成功只清自己的 (QQ, IP) 键：账号桶不动。
  await authService.login(
    { qq: qq.plainMember!, password: PLAIN_MEMBER_PASSWORD },
    ctx("10.5.0.1"),
  );
  assert.equal(
    await db.loginThrottle.count({
      where: { keyDigest: digestLoginThrottleKey(qq.plainMember!, "10.5.0.1") },
    }),
    0,
  );
  assert.ok(
    await db.loginThrottle.findUnique({ where: { keyDigest: accountKey } }),
    "普通登录的清除不得误清账号桶",
  );
});

/* --------------------------------------------------------- R06/R10 并发 */

dbTest("同码并发登录最多一次成功：凭据只被消费一次、只建一个会话", async () => {
  const db = getDb();
  const reset = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  const secret = reset.initializationSecret!;

  const settled = await Promise.allSettled(
    ["10.6.0.1", "10.6.0.2", "10.6.0.3"].map((ip) =>
      authService.login({ qq: qq.member!, password: secret }, ctx(ip)),
    ),
  );
  const fulfilled = settled.filter((item) => item.status === "fulfilled");
  assert.equal(fulfilled.length, 1, "并发登录必须只有一次成功");
  for (const item of settled) {
    if (item.status === "rejected") {
      assert.ok(item.reason instanceof AppError);
      assert.equal(item.reason.code, "AUTH_INVALID_CREDENTIALS");
    }
  }
  const credential = await db.passwordCredential.findUniqueOrThrow({
    where: { userId: MEMBER_ID },
  });
  assert.ok(credential.temporaryConsumedAt, "成功的登录必须消费凭据");
  assert.equal(
    await db.authSession.count({ where: { userId: MEMBER_ID, revokedAt: null } }),
    1,
    "只允许建立一个受限会话",
  );
});

dbTest("再次签发使旧凭据与旧会话失效；过期代次的改密不能覆盖新重置", async () => {
  const db = getDb();
  const first = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  const session1 = await authService.login(
    { qq: qq.member!, password: first.initializationSecret! },
    ctx("10.7.0.1"),
  );

  // 再次签发：旧临时密码不能再用，旧受限会话被撤销。
  const second = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  await expectCode(
    () =>
      authService.login({ qq: qq.member!, password: first.initializationSecret! }, ctx("10.7.0.2")),
    "AUTH_INVALID_CREDENTIALS",
  );
  await expectCode(() => authService.authenticate(session1.token), "AUTH_SESSION_INVALID");
  await expectCode(
    () =>
      authService.changePassword(
        session1.token,
        {
          currentPassword: first.initializationSecret!,
          newPassword: MEMBER_NEW_PASSWORD,
          newPasswordConfirmation: MEMBER_NEW_PASSWORD,
        },
        ctx("10.7.0.3"),
      ),
    "AUTH_SESSION_INVALID",
  );

  // 新一轮受限登录 → 恢复态改密与管理员再次重置并发：
  // 无论时序如何，终态都必须是最后一次重置签发的临时凭据。
  const session2 = await authService.login(
    { qq: qq.member!, password: second.initializationSecret! },
    ctx("10.7.0.4"),
  );
  const settle = await Promise.allSettled([
    authService.changePassword(
      session2.token,
      {
        currentPassword: second.initializationSecret!,
        newPassword: MEMBER_NEW_PASSWORD,
        newPasswordConfirmation: MEMBER_NEW_PASSWORD,
      },
      ctx("10.7.0.5"),
    ),
    memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR),
  ]);
  const [changeResult, reissueResult] = settle;
  assert.equal(reissueResult.status, "fulfilled", "再次签发本身必须成功");
  if (changeResult.status === "rejected") {
    assert.ok(changeResult.reason instanceof AppError);
    assert.equal(changeResult.reason.code, "AUTH_SESSION_INVALID");
  }
  const finalSecret = (reissueResult as PromiseFulfilledResult<{ initializationSecret?: string }>)
    .value.initializationSecret!;
  const credential = await db.passwordCredential.findUniqueOrThrow({
    where: { userId: MEMBER_ID },
  });
  assert.ok(credential.temporaryExpiresAt, "终态必须是最新签发的临时凭据");
  assert.equal(credential.temporaryConsumedAt, null);
  // 旧改密写出的普通密码（若曾提交成功）不得可用；最终有效的只有最新临时密码。
  await expectCode(
    () => authService.login({ qq: qq.member!, password: MEMBER_NEW_PASSWORD }, ctx("10.7.0.6")),
    "AUTH_INVALID_CREDENTIALS",
  );
  const login = await authService.login({ qq: qq.member!, password: finalSecret }, ctx("10.7.0.7"));
  assert.equal(login.mustChangePassword, true);
});

/* --------------------------------------- 事务排队跨过期限 */

/** 在独立事务里按住某行锁一段时间：`locked` 拿到锁后兑现，`done` 释放后兑现。 */
function holdRowLock(acquire: (tx: Prisma.TransactionClient) => unknown, holdMs: number) {
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const done = getDb().$transaction(
    async (tx) => {
      await acquire(tx);
      signalLocked();
      await new Promise((resolve) => setTimeout(resolve, holdMs));
    },
    { isolationLevel: "Serializable" },
  );
  return { locked, done };
}

dbTest("事务在行锁等待中跨过口令期限：不得凭事务外旧时间消费过期临时密码", async () => {
  const db = getDb();
  const reset = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  // 期限设在很近的未来：登录会先通过事务外检查，然后在 FOR UPDATE 排队时跨过它。
  await db.passwordCredential.update({
    where: { userId: MEMBER_ID },
    data: { temporaryExpiresAt: new Date(Date.now() + 1_500) },
  });

  const { locked, done } = holdRowLock(
    (tx) =>
      tx.$queryRaw`SELECT user_id FROM password_credentials WHERE user_id = ${MEMBER_ID} FOR UPDATE`,
    2_500,
  );
  await locked;
  await expectCode(
    () =>
      authService.login(
        { qq: qq.member!, password: reset.initializationSecret! },
        ctx("10.10.0.1"),
      ),
    "AUTH_INVALID_CREDENTIALS",
  );
  await done;

  // 过期口令没有被消费、也没有建立任何会话。
  const credential = await db.passwordCredential.findUniqueOrThrow({
    where: { userId: MEMBER_ID },
  });
  assert.equal(credential.temporaryConsumedAt, null);
  assert.equal(await db.authSession.count({ where: { userId: MEMBER_ID } }), 0);
});

dbTest("事务在行锁等待中跨过受限会话期限：不得凭事务外旧时间完成改密", async () => {
  const db = getDb();
  const reset = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  const tempLogin = await authService.login(
    { qq: qq.member!, password: reset.initializationSecret! },
    ctx("10.11.0.1"),
  );
  // 会话期限设在很近的未来：改密会先通过 authenticate，再在会话行锁排队时跨过它。
  await db.authSession.update({
    where: { id: tempLogin.sessionId },
    data: { expiresAt: new Date(Date.now() + 1_500) },
  });

  const { locked, done } = holdRowLock(
    (tx) => tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${tempLogin.sessionId} FOR UPDATE`,
    2_500,
  );
  await locked;
  await expectCode(
    () =>
      authService.changePassword(
        tempLogin.token,
        {
          currentPassword: reset.initializationSecret!,
          newPassword: MEMBER_NEW_PASSWORD,
          newPasswordConfirmation: MEMBER_NEW_PASSWORD,
        },
        ctx("10.11.0.2"),
      ),
    "AUTH_SESSION_INVALID",
  );
  await done;

  // 改密整笔回滚：临时状态未被清除、强制改密仍在、没有轮换出新会话。
  const credential = await db.passwordCredential.findUniqueOrThrow({
    where: { userId: MEMBER_ID },
  });
  assert.ok(credential.temporaryExpiresAt, "临时期限未被清除");
  assert.ok(credential.temporaryConsumedAt, "消费状态未被改写");
  assert.equal(credential.mustChangePassword, true);
  assert.equal(await db.authSession.count({ where: { userId: MEMBER_ID, revokedAt: null } }), 1);
});

/* -------------------------------------------------- 改密落点贯通 */

dbTest("改密落点按角色贯通：无档案管理员回 /admin、成员回 /member", async () => {
  // 无成员档案的管理员：恢复 → 受限登录 → 走真实改密路由，响应必须给出 /admin。
  const adminReset = await memberService.resetAccountPassword(ADMIN_TARGET_ID, ADMIN_ACTOR);
  const adminLogin = await authService.login(
    { qq: qq.adminTarget!, password: adminReset.initializationSecret },
    ctx("10.12.0.1"),
  );
  const adminChange = await changePasswordRoute(
    new Request("http://localhost/api/v1/auth/password/change", {
      method: "POST",
      headers: {
        ...sameOriginHeaders(),
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE_NAME}=${adminLogin.token}`,
      },
      body: JSON.stringify({
        currentPassword: adminReset.initializationSecret,
        newPassword: "I113-Recovered-Admin-1",
        newPasswordConfirmation: "I113-Recovered-Admin-1",
      }),
    }),
  );
  assert.equal(adminChange.status, 200);
  const adminBody = (await adminChange.json()) as {
    data?: { changed?: boolean; mustChangePassword?: boolean; destination?: string };
  };
  assert.equal(adminBody.data?.changed, true);
  assert.equal(adminBody.data?.mustChangePassword, false);
  assert.equal(adminBody.data?.destination, "/admin", "无档案管理员改密后应回管理后台");

  // 成员：同一路由、同一份 loginDestination 规则，落点必须是 /member。
  const memberReset = await memberService.resetPassword(PROFILE_MEMBER, ADMIN_ACTOR);
  const memberLogin = await authService.login(
    { qq: qq.member!, password: memberReset.initializationSecret! },
    ctx("10.12.0.2"),
  );
  const memberChange = await changePasswordRoute(
    new Request("http://localhost/api/v1/auth/password/change", {
      method: "POST",
      headers: {
        ...sameOriginHeaders(),
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE_NAME}=${memberLogin.token}`,
      },
      body: JSON.stringify({
        currentPassword: memberReset.initializationSecret,
        newPassword: MEMBER_NEW_PASSWORD,
        newPasswordConfirmation: MEMBER_NEW_PASSWORD,
      }),
    }),
  );
  assert.equal(memberChange.status, 200);
  const memberBody = (await memberChange.json()) as { data?: { destination?: string } };
  assert.equal(memberBody.data?.destination, "/member");
});

/* ------------------------------------------------- R11 历史兼容（NULL 语义） */

dbTest("历史凭据（无临时字段）登录与改密不受影响", async () => {
  const db = getDb();
  const login = await authService.login(
    { qq: qq.member!, password: MEMBER_PASSWORD },
    ctx("10.8.0.1"),
  );
  assert.equal(login.mustChangePassword, false);
  const changed = await authService.changePassword(
    login.token,
    {
      currentPassword: MEMBER_PASSWORD,
      newPassword: MEMBER_NEW_PASSWORD,
      newPasswordConfirmation: MEMBER_NEW_PASSWORD,
    },
    ctx("10.8.0.2"),
  );
  assert.equal(changed.mustChangePassword, false);
  const credential = await db.passwordCredential.findUniqueOrThrow({
    where: { userId: MEMBER_ID },
  });
  // 普通改密不制造临时期限、也不残留临时状态。
  assert.equal(credential.temporaryExpiresAt, null);
  assert.equal(credential.temporaryConsumedAt, null);
  assert.equal(credential.credentialVersion, 1);
});

/* ------------------------------------------------------------- 路由级（R13） */

dbTest("两条新路由：权限、同源、private no-store 与自我恢复拒绝", async () => {
  const adminLogin = await authService.login(
    { qq: qq.admin!, password: ADMIN_PASSWORD },
    ctx("10.9.0.1"),
  );
  const adminCookie = { cookie: `${SESSION_COOKIE_NAME}=${adminLogin.token}` };

  const lookup = await accountLookupRoute(
    new Request("http://localhost/api/v1/admin/accounts/lookup", {
      method: "POST",
      headers: { ...sameOriginHeaders(), "content-type": "application/json", ...adminCookie },
      body: JSON.stringify({ qq: qq.member! }),
    }),
  );
  assert.equal(lookup.status, 200);
  assert.equal(lookup.headers.get("cache-control"), "private, no-store");
  const lookupBody = (await lookup.json()) as { data?: { userId?: string; canReset?: boolean } };
  assert.equal(lookupBody.data?.userId, MEMBER_ID);
  assert.equal(lookupBody.data?.canReset, true);

  const reset = await accountResetRoute(
    new Request(`http://localhost/api/v1/admin/accounts/${MEMBER_ID}/password-reset`, {
      method: "POST",
      headers: { ...sameOriginHeaders(), ...adminCookie },
    }),
    { params: Promise.resolve({ userId: MEMBER_ID }) },
  );
  assert.equal(reset.status, 200);
  assert.equal(reset.headers.get("cache-control"), "private, no-store");
  const resetBody = (await reset.json()) as {
    data?: { initializationSecret?: string; temporaryExpiresAt?: string };
  };
  assert.match(resetBody.data?.initializationSecret ?? "", /^\d{6}$/);
  assert.ok(resetBody.data?.temporaryExpiresAt);

  // 自我恢复：服务端拒绝，不只是隐藏按钮。
  const selfReset = await accountResetRoute(
    new Request(`http://localhost/api/v1/admin/accounts/${ADMIN_ID}/password-reset`, {
      method: "POST",
      headers: { ...sameOriginHeaders(), ...adminCookie },
    }),
    { params: Promise.resolve({ userId: ADMIN_ID }) },
  );
  assert.equal(selfReset.status, 403);

  // 非同源请求直接 403（写接口的 CSRF 防线）。
  const badOrigin = await accountLookupRoute(
    new Request("http://localhost/api/v1/admin/accounts/lookup", {
      method: "POST",
      headers: { ...adminCookie, origin: "https://evil.example" },
      body: JSON.stringify({ qq: qq.member! }),
    }),
  );
  assert.equal(badOrigin.status, 403);

  // 成员（无 member:manage）打这两条路由都被拒。
  const memberLogin = await authService.login(
    { qq: qq.plainMember!, password: PLAIN_MEMBER_PASSWORD },
    ctx("10.9.0.2"),
  );
  const memberLookup = await accountLookupRoute(
    new Request("http://localhost/api/v1/admin/accounts/lookup", {
      method: "POST",
      headers: {
        ...sameOriginHeaders(),
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE_NAME}=${memberLogin.token}`,
      },
      body: JSON.stringify({ qq: qq.member! }),
    }),
  );
  assert.equal(memberLookup.status, 403);
});
