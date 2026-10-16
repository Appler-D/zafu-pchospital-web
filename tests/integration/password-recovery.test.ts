import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, test } from "node:test";
import { PasswordRecoveryService } from "../../src/features/email/password-recovery-service";
import { EmailChallengeService } from "../../src/features/email/email-challenge-service";
import { PasswordResetService } from "../../src/features/email/password-reset-service";
import { emailBucketKeys } from "../../src/features/email/email-rate-limit";
import { memberService } from "../../src/features/members/member-service";
import { authService } from "../../src/features/auth/auth-service";
import { getDb, disconnectDb } from "../../src/lib/db/client";
import { resetServerEnvForTests } from "../../src/lib/env";
import {
  digestEmailBucketKey,
  digestPasswordResetToken,
} from "../../src/lib/security/email-security";
import {
  hashPassword,
  digestSessionToken,
  verifyPassword,
  digestLoginThrottleKey,
} from "../../src/lib/security/secrets";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import {
  passwordRecoveryRoute,
  passwordResetCookie,
  PASSWORD_RESET_COOKIE_NAME,
} from "../../src/lib/api/password-recovery-routes";
import type { AuthorizedActor } from "../../src/types/contracts";
import type { EmailDeliveryOutcome, EmailMessage } from "../../src/lib/email/mailer";
import { integrationTestsEnabled } from "./db-guard";

const enabled = integrationTestsEnabled(),
  dbTest = enabled ? test : test.skip;
Object.assign(process.env, {
  MAIL_ENABLED: "true",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "465",
  SMTP_USER: "test@example.com",
  SMTP_PASSWORD: "fake-password",
  MAIL_FROM: "test@example.com",
  EMAIL_CODE_PEPPER: "recovery-test-pepper-at-least-32-characters",
});
resetServerEnvForTests();
const ids = [1, 2, 3, 4, 5].map((n) => `e1465555-0000-4000-8000-00000000000${n}`);
const [a, b, c, d, e] = ids as [string, string, string, string, string];
const qq = (n: number) => `5155500${n}`;
const address = (n: number) => `recovery146-${n}@example.com`;
const initial = "Original-146-password";
const ctx = { requestId: "email-recovery-test", ipAddress: "10.146.5.1" };
const otherCtx = { ...ctx, ipAddress: "10.146.5.2" };
const actor: AuthorizedActor = {
  ...ctx,
  actorType: "USER",
  userId: b,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
};
let now: number,
  challenges: EmailChallengeService,
  reset: PasswordResetService,
  service: PasswordRecoveryService,
  outcome: EmailDeliveryOutcome,
  messages: EmailMessage[];
async function rejectCode(run: () => Promise<unknown>, code: string) {
  await assert.rejects(
    run,
    (error: unknown) =>
      !!error && typeof error === "object" && "code" in error && error.code === code,
  );
}
function counterKeys() {
  const keys = [emailBucketKeys.budgetDay(), emailBucketKeys.budgetMinute()];
  for (const ip of [ctx.ipAddress, otherCtx.ipAddress])
    keys.push(
      emailBucketKeys.sendDailyIp(ip),
      emailBucketKeys.verifyIp(ip),
      emailBucketKeys.recoveryRequestIp(ip),
    );
  for (let n = 1; n <= 12; n++)
    keys.push(
      emailBucketKeys.recoveryRequestQqCooldown(qq(n)),
      emailBucketKeys.recoveryRequestQqDaily(qq(n)),
      emailBucketKeys.sendCooldownEmail(address(n)),
      emailBucketKeys.sendDailyEmail(address(n)),
    );
  for (const id of ids) {
    keys.push(emailBucketKeys.sendCooldownUser(id), emailBucketKeys.sendDailyUser(id));
    for (const purpose of ["PASSWORD_RESET", "EMAIL_BIND"])
      keys.push(emailBucketKeys.verifyFailure(id, purpose));
  }
  return keys;
}
async function cleanup() {
  const db = getDb();
  await db.emailExemption.deleteMany({ where: { userId: { in: ids } } });
  await db.emailAssistance.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetAuthorization.deleteMany({ where: { userId: { in: ids } } });
  await db.emailChallenge.deleteMany({ where: { userId: { in: ids } } });
  await db.loginThrottle.deleteMany({
    where: {
      keyDigest: { in: ids.map((_, i) => digestLoginThrottleKey(qq(i + 1), ctx.ipAddress)) },
    },
  });
  await db.authSession.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: {
      OR: [{ actorUserId: { in: ids } }, { targetId: { in: ids } }, { requestId: ctx.requestId }],
    },
  });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.userRole.deleteMany({ where: { userId: { in: ids } } });
  await db.memberProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.userIdentity.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.emailSecurityCounter.deleteMany({
    where: { bucketKeyDigest: { in: counterKeys().map(digestEmailBucketKey) } },
  });
}
before(async () => {
  if (!enabled) return;
  for (const code of ["ADMIN", "MEMBER"])
    await getDb().role.upsert({
      where: { code },
      create: { id: randomUUID(), code, name: code, createdAt: new Date() },
      update: {},
    });
});
beforeEach(async () => {
  if (!enabled) return;
  await cleanup();
  now = Date.now();
  messages = [];
  outcome = { status: "ACCEPTED" };
  process.env.MAIL_ENABLED = "true";
  resetServerEnvForTests();
  challenges = new EmailChallengeService({
    now: () => new Date(now),
    codeFactory: () => "123456",
    sender: {
      send: async (message) => {
        messages.push(message);
        return outcome;
      },
    },
  });
  reset = new PasswordResetService({ challengeService: challenges, now: () => new Date(now) });
  service = new PasswordRecoveryService({ challenges, reset, now: () => new Date(now) });
  const db = getDb(),
    at = new Date(now),
    passwordHash = await hashPassword(initial);
  for (const [index, id] of ids.entries()) {
    await db.user.create({
      data: {
        id,
        status: id === d ? "DISABLED" : "ACTIVE",
        displayName: "找回测试",
        createdAt: at,
        updatedAt: at,
      },
    });
    const role = await db.role.findUniqueOrThrow({
      where: { code: id === e ? "MEMBER" : "ADMIN" },
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
    if (id === e)
      await db.memberProfile.create({
        data: {
          id: randomUUID(),
          userId: id,
          realName: "失效成员",
          status: "REVOKED",
          joinedAt: at,
          createdAt: at,
          updatedAt: at,
        },
      });
    await db.passwordCredential.create({
      data: {
        userId: id,
        passwordHash,
        mustChangePassword: id === a,
        temporaryExpiresAt: id === a ? new Date(now + 3600000) : null,
        temporaryConsumedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    });
    for (const data of [
      { type: "QQ", identifierNormalized: qq(index + 1), verifiedAt: null },
      { type: "EMAIL", identifierNormalized: address(index + 1), verifiedAt: id === c ? null : at },
    ])
      await db.userIdentity.create({
        data: { id: randomUUID(), userId: id, ...data, createdAt: at, updatedAt: at },
      });
    await db.authSession.create({
      data: {
        id: randomUUID(),
        userId: id,
        tokenDigest: digestSessionToken(`recovery-old-session-${id}`),
        createdAt: at,
        lastSeenAt: at,
        expiresAt: new Date(now + 86400000),
      },
    });
  }
  await db.emailExemption.create({
    data: {
      id: randomUUID(),
      userId: c,
      reason: "测试豁免不授予找回资格",
      createdByUserId: b,
      createdAt: at,
      expiresAt: new Date(now + 86400000),
    },
  });
});
after(async () => {
  if (enabled) {
    await cleanup();
    await disconnectDb();
  }
});
async function grant() {
  const requested = await service.request({ qq: qq(1) }, ctx);
  return service.verify({ challengeId: requested.challengeId, code: "123456" }, ctx);
}
const request = (action: string, body: unknown, cookie = "", origin = process.env.APP_BASE_URL!) =>
  new Request(`${process.env.APP_BASE_URL}/api/v1/auth/password-reset/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-request-id": ctx.requestId, origin, cookie },
    body: JSON.stringify(body),
  });

dbTest(
  "匿名主链路：强制改密的无档案管理员可恢复，字段错误保留授权，Cookie 清理仅撤销目标 Session",
  async () => {
    const db = getDb();
    let authorized = await grant();
    now += 61000;
    authorized = await grant();
    assert.equal(
      await db.passwordResetAuthorization.count({ where: { userId: a, status: "INVALIDATED" } }),
      1,
    );
    now += 61000;
    const binding = await challenges.requestEmailChallenge(
      { userId: a, purpose: "EMAIL_BIND", targetEmail: address(10) },
      ctx,
    );
    const cookie = `${PASSWORD_RESET_COOKIE_NAME}=${authorized.token}; pc_hospital_session=recovery-old-session-${b}`;
    const invalid = await passwordRecoveryRoute(
      request("confirm", { newPassword: "short", newPasswordConfirmation: "different" }, cookie),
      "confirm",
      service,
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get("set-cookie"), null);
    assert.equal(
      (
        await db.passwordResetAuthorization.findUniqueOrThrow({
          where: { tokenDigest: digestPasswordResetToken(authorized.token) },
        })
      ).status,
      "ISSUED",
    );
    process.env.MAIL_ENABLED = "false";
    resetServerEnvForTests();
    const changed = await passwordRecoveryRoute(
      request(
        "confirm",
        {
          newPassword: "  new recovered password  ",
          newPasswordConfirmation: "  new recovered password  ",
        },
        cookie,
      ),
      "confirm",
      service,
    );
    assert.equal(changed.status, 200);
    assert.deepEqual((await changed.json()).data, { changed: true, destination: "/login" });
    assert.equal(changed.headers.get("cache-control"), "private, no-store");
    const cookies = changed.cookies.getAll();
    assert.ok(cookies.find((c) => c.name === PASSWORD_RESET_COOKIE_NAME && c.value === ""));
    assert.ok(cookies.find((c) => c.name === "pc_hospital_session" && c.value === ""));
    assert.equal(await db.authSession.count({ where: { userId: a, revokedAt: null } }), 0);
    assert.equal(await db.authSession.count({ where: { userId: b, revokedAt: null } }), 1);
    assert.equal(await db.authSession.count({ where: { userId: a } }), 1); // 没有自动建立会话。
    assert.equal(
      (await db.emailChallenge.findUniqueOrThrow({ where: { id: binding.challengeId } })).status,
      "INVALIDATED",
    );
    const credential = await db.passwordCredential.findUniqueOrThrow({ where: { userId: a } });
    assert.equal(credential.temporaryExpiresAt, null);
    assert.equal(credential.temporaryConsumedAt, null);
    assert.equal(credential.mustChangePassword, false);
    assert.equal(credential.credentialVersion, 1);
    await rejectCode(
      () => authService.authenticate(`recovery-old-session-${a}`),
      "AUTH_SESSION_INVALID",
    );
    await rejectCode(
      () => authService.login({ qq: qq(1), password: initial }, ctx),
      "AUTH_INVALID_CREDENTIALS",
    );
    const login = await authService.login(
      { qq: qq(1), password: "  new recovered password  " },
      ctx,
    );
    assert.equal(login.mustChangePassword, false);
    assert.equal(login.memberProfileId, null);
    assert.equal(
      await db.auditLog.count({
        where: { action: "auth.password.recovered", actorUserId: a, targetId: a },
      }),
      1,
    );
  },
);

dbTest(
  "请求响应一致：真实、未知、未验证含豁免、禁用、失效成员、SMTP 失败；意外错误不伪装成功",
  async (t) => {
    const outputs = [];
    for (const n of [1, 9, 3, 4, 5]) {
      const response = await passwordRecoveryRoute(
        request("request", { qq: qq(n) }),
        "request",
        service,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      outputs.push((await response.json()).data);
    }
    assert.equal(messages.length, 1);
    now += 61000;
    outcome = { status: "FAILED" };
    outputs.push(await service.request({ qq: qq(2) }, ctx));
    assert.equal(messages.length, 2);
    for (const output of outputs) {
      assert.deepEqual(Object.keys(output).sort(), ["challengeId", "expiresAt", "message"]);
      assert.match(output.challengeId, /^[a-f0-9-]{36}$/);
      assert.equal(output.message, outputs[0].message);
      assert.equal(
        output.expiresAt,
        outputs[0].expiresAt === output.expiresAt
          ? outputs[0].expiresAt
          : new Date(now + 600000).toISOString(),
      );
      assert.equal(JSON.stringify(output).includes("@"), false);
    }
    const logs = await getDb().auditLog.findMany({
      where: {
        requestId: ctx.requestId,
        action: { in: ["email.challenge.requested", "email.recovery.request.accepted"] },
      },
    });
    assert.ok(logs.every((row) => row.actorType === "SYSTEM" && row.actorUserId === null));
    now += 61000;
    t.mock.method(challenges, "requestEmailChallenge", async () => {
      throw new Error("unexpected program fault");
    });
    const failure = await passwordRecoveryRoute(
      request("request", { qq: qq(1) }),
      "request",
      service,
    );
    assert.equal(failure.status, 500);
    assert.equal((await failure.json()).error.code, "INTERNAL_ERROR");
  },
);

dbTest("未知 QQ 查询前计数持久化：跨 IP 冷却、每日上限、IP 上限", async () => {
  const db = getDb();
  await service.request({ qq: ` ${qq(9)} ` }, ctx);
  await rejectCode(() => service.request({ qq: qq(9) }, otherCtx), "EMAIL_RATE_LIMITED");
  const dailyKey = digestEmailBucketKey(emailBucketKeys.recoveryRequestQqDaily(qq(9)));
  assert.equal(
    (await db.emailSecurityCounter.findUniqueOrThrow({ where: { bucketKeyDigest: dailyKey } }))
      .counter,
    1,
  );
  await db.emailSecurityCounter.update({
    where: { bucketKeyDigest: dailyKey },
    data: { counter: 9 },
  });
  now += 61000;
  await service.request({ qq: qq(9) }, ctx);
  now += 61000;
  await rejectCode(() => service.request({ qq: qq(9) }, otherCtx), "EMAIL_RATE_LIMITED");
  const ipKey = digestEmailBucketKey(emailBucketKeys.recoveryRequestIp(ctx.ipAddress));
  await db.emailSecurityCounter.update({
    where: { bucketKeyDigest: ipKey },
    data: { counter: 29 },
  });
  await service.request({ qq: qq(10) }, ctx);
  await rejectCode(() => service.request({ qq: qq(11) }, ctx), "EMAIL_RATE_LIMITED");
  assert.equal(
    (await db.emailSecurityCounter.findUniqueOrThrow({ where: { bucketKeyDigest: ipKey } }))
      .counter,
    30,
  );
  assert.equal(messages.length, 0);
});

dbTest("同一授权并发仅成功一次；旧代次授权被管理员重置拒绝", async () => {
  const authorized = await grant();
  const choices = ["Recovery-choice-one", "Recovery-choice-two"];
  const results = await Promise.allSettled(
    choices.map((newPassword) =>
      service.confirm(authorized.token, { newPassword, newPasswordConfirmation: newPassword }, ctx),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const winner = results.findIndex((r) => r.status === "fulfilled");
  const stored = await getDb().passwordCredential.findUniqueOrThrow({ where: { userId: a } });
  assert.equal(await verifyPassword(choices[winner]!, stored.passwordHash), true);
  await rejectCode(
    () =>
      service.confirm(
        authorized.token,
        { newPassword: "replay-password", newPasswordConfirmation: "replay-password" },
        ctx,
      ),
    "EMAIL_RESET_AUTHORIZATION_INVALID",
  );
  now += 61000;
  const next = await grant();
  await memberService.resetAccountPassword(a, actor);
  await rejectCode(
    () =>
      service.confirm(
        next.token,
        { newPassword: "stale-password", newPasswordConfirmation: "stale-password" },
        ctx,
      ),
    "EMAIL_RESET_AUTHORIZATION_INVALID",
  );
  assert.equal(
    (await getDb().passwordCredential.findUniqueOrThrow({ where: { userId: a } }))
      .mustChangePassword,
    true,
  );
});

dbTest("薄 Route：严格输入、同源、专用 Cookie、验证无 token JSON、无效授权清 Cookie", async () => {
  assert.equal(
    (
      await passwordRecoveryRoute(
        request("request", { qq: qq(1) }, "", "https://evil.invalid"),
        "request",
        service,
      )
    ).status,
    403,
  );
  for (const body of [
    { qq: 12345 },
    { qq: qq(1), targetEmail: "override@example.com" },
    { qq: qq(1), userId: a },
  ])
    assert.equal(
      (await passwordRecoveryRoute(request("request", body), "request", service)).status,
      400,
    );
  const issued = await service.request({ qq: qq(1) }, ctx);
  const verified = await passwordRecoveryRoute(
    request("verify", { challengeId: issued.challengeId, code: "123456" }),
    "verify",
    service,
  );
  assert.equal(verified.status, 200);
  const json = await verified.json();
  assert.deepEqual(Object.keys(json.data).sort(), ["authorized", "expiresAt"]);
  const cookie = verified.cookies.get(PASSWORD_RESET_COOKIE_NAME)!;
  assert.ok(cookie);
  const header = verified.headers.get("set-cookie")!;
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=strict/i);
  assert.match(header, /Path=\/api\/v1\/auth\/password-reset/);
  assert.equal(header.includes("pc_hospital_session"), false);
  assert.equal(
    cookie.expires instanceof Date ? cookie.expires.toISOString() : String(cookie.expires),
    json.data.expiresAt,
  );
  const original = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  try {
    assert.equal(passwordResetCookie("x", json.data.expiresAt).secure, true);
  } finally {
    if (original === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Object.assign(process.env, { NODE_ENV: original });
  }
  const invalid = await passwordRecoveryRoute(
    request(
      "confirm",
      { newPassword: "valid-password", newPasswordConfirmation: "valid-password" },
      `${PASSWORD_RESET_COOKIE_NAME}=invalid`,
    ),
    "confirm",
    service,
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.cookies.get(PASSWORD_RESET_COOKIE_NAME)?.value, "");
  assert.equal(await getDb().authSession.count({ where: { userId: a } }), 1);
});
