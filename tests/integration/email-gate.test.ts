import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { POST as loginRoute } from "../../src/app/api/v1/auth/login/route";
import { POST as passwordChangeRoute } from "../../src/app/api/v1/auth/password/change/route";
import { POST as logoutRoute } from "../../src/app/api/v1/auth/logout/route";
import { POST as accountLookupRoute } from "../../src/app/api/v1/admin/accounts/lookup/route";
import { GET as adminMembersRoute } from "../../src/app/api/v1/admin/members/route";
import { GET as auditLogsRoute } from "../../src/app/api/v1/admin/audit-logs/route";
import { GET as meRoute } from "../../src/app/api/v1/me/route";
import { GET as skillsRoute } from "../../src/app/api/v1/skills/route";
import { authService } from "../../src/features/auth/auth-service";
import { resolveAccountAccess } from "../../src/lib/auth/account-access";
import { SESSION_COOKIE_NAME } from "../../src/lib/auth/request";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { resetServerEnvForTests, type EmailGateMode } from "../../src/lib/env";
import { digestSessionToken, hashPassword } from "../../src/lib/security/secrets";
import { integrationTestsEnabled } from "./db-guard";
import { callRoute, sameOriginHeaders } from "./http-harness";

/**
 * 统一账号门禁与分阶段启用。
 *
 * 打的是**贯通**而不是纯函数复述：夹具建真实用户 / 角色 / 身份 / 豁免 / 会话，再经由
 * 真实路由处理函数（业务 API `GET /api/v1/skills`、`GET /api/v1/admin/members`、
 * `GET /api/v1/admin/audit-logs`，以及 `/me`、登出、窄例外恢复端点、登录落点）观察
 * 服务端按**当次数据库状态**的判定。纯判定表驱动在 `tests/unit/account-access.test.ts`。
 *
 * 档位只从 `EMAIL_GATE_MODE` 注入（不入库、不由请求参数或前端标志决定），切换时重建
 * 配置缓存 = 模拟「改档位要重启全部实例」。本文件全程不设 `MAIL_ENABLED`：
 * 邮件通道关闭既不能让门禁放行，也不能让它失效 —— 门禁只看模式 / 资格 / 邮箱 / 豁免。
 */

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

const ID = (suffix: string) => `e1466000-0000-4000-8006-0000000000${suffix}`;
const ADMIN_ID = ID("01");
const PENDING_MEMBER_ID = ID("02");
const DUAL_ID = ID("03");
const VERIFIED_ID = ID("04");
const HISTORICAL_ID = ID("05");
const CONFLICT_ID = ID("06");
const EXEMPT_ID = ID("07");
const FORCED_ID = ID("08");
const USER_IDS = [
  ADMIN_ID,
  PENDING_MEMBER_ID,
  DUAL_ID,
  VERIFIED_ID,
  HISTORICAL_ID,
  CONFLICT_ID,
  EXEMPT_ID,
  FORCED_ID,
];
const PROFILE = (suffix: string) => `e1466000-0000-4000-8007-0000000000${suffix}`;
const ROW = (suffix: string) => `e1466000-0000-4000-8008-0000000000${suffix}`;
const EXEMPTION_ID = ROW("ex");
const LOGIN_PASSWORD = "I146-Gate-Password-1";
const CHAINED_PASSWORD = "I146-Chain-Password-2";
const ADMIN_QQ = "991460001";
const MEMBER_QQ = "991460002";
/** 链条用例要**真的登录**那个「首次必须改密」的账号，所以给它一个 QQ 身份。 */
const FORCED_QQ = "991460003";

async function createUser(id: string, name: string) {
  const now = new Date();
  await getDb().user.create({
    data: { id, status: "ACTIVE", displayName: name, createdAt: now, updatedAt: now },
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

async function attachCredential(userId: string, mustChangePassword = false) {
  const now = new Date();
  await getDb().passwordCredential.create({
    data: {
      userId,
      passwordHash: await hashPassword(LOGIN_PASSWORD),
      mustChangePassword,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

/**
 * 身份夹具。EMAIL 的 `activeEmailKey` 缺省按现行口径写入；传 `null` 造历史行
 * （`verifiedAt` 有值但那把唯一键为空）。QQ 行不写该列。
 */
async function attachIdentity(
  id: string,
  userId: string,
  type: "QQ" | "EMAIL",
  value: string,
  options: { verified?: boolean; activeKey?: string | null } = {},
) {
  const now = new Date();
  await getDb().userIdentity.create({
    data: {
      id,
      userId,
      type,
      identifierNormalized: value,
      verifiedAt: options.verified === false ? null : now,
      activeEmailKey:
        type === "EMAIL"
          ? options.activeKey === undefined
            ? `email:${userId}`
            : options.activeKey
          : null,
      createdAt: now,
      updatedAt: now,
    },
  });
}

/** 只造会话：角色与凭据由夹具准备，避免与 `userRole.activeKey` 唯一约束打架。 */
async function sessionFor(userId: string): Promise<string> {
  const now = new Date();
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  await getDb().authSession.create({
    data: {
      id: randomUUID(),
      userId,
      tokenDigest: digestSessionToken(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    },
  });
  return token;
}

/**
 * 只删不建。`after` 用它：门禁夹具会写 `email_exemptions`，而那张表的外键是
 * `created_by_user_id` + RESTRICT，`m0-database` 的全表清空不认识任务 4 之后新增的
 * 邮箱表 —— 留着就把它整文件卡在 FK 上。所以本文件结束时**彻底撤掉**夹具，
 * 不像任务 3 那样"重建一份留在库里"。
 */
async function dropFixtures(): Promise<void> {
  const db = getDb();
  await db.auditLog.deleteMany({
    where: {
      OR: [{ actorUserId: { in: USER_IDS } }, { targetId: { in: USER_IDS } }],
    },
  });
  await db.emailExemption.deleteMany({
    where: { OR: [{ userId: { in: USER_IDS } }, { createdByUserId: { in: USER_IDS } }] },
  });
  await db.emailChallenge.deleteMany({ where: { userId: { in: USER_IDS } } });
  await db.authSession.deleteMany({ where: { userId: { in: USER_IDS } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: USER_IDS } } });
  await db.userRole.deleteMany({ where: { userId: { in: USER_IDS } } });
  await db.memberProfile.deleteMany({ where: { userId: { in: USER_IDS } } });
  await db.userIdentity.deleteMany({ where: { userId: { in: USER_IDS } } });
  await db.user.deleteMany({ where: { id: { in: USER_IDS } } });
}

async function prepareFixtures(): Promise<void> {
  await dropFixtures();

  const db = getDb();
  const names = [
    [ADMIN_ID, "I146 门禁管理员"],
    [PENDING_MEMBER_ID, "I146 待验证成员"],
    [DUAL_ID, "I146 双角色"],
    [VERIFIED_ID, "I146 已验证"],
    [HISTORICAL_ID, "I146 历史身份"],
    [CONFLICT_ID, "I146 多条身份"],
    [EXEMPT_ID, "I146 豁免中"],
    [FORCED_ID, "I146 待改密"],
  ] as const;
  for (const [id, name] of names) await createUser(id, name);

  await attachRole(ADMIN_ID, "ADMIN");
  await attachCredential(ADMIN_ID);
  await attachIdentity(ROW("q1"), ADMIN_ID, "QQ", ADMIN_QQ);

  await attachProfile(PROFILE("a2"), PENDING_MEMBER_ID, "I146 待验证成员");
  await attachRole(PENDING_MEMBER_ID, "MEMBER");
  await attachCredential(PENDING_MEMBER_ID);
  await attachIdentity(ROW("q2"), PENDING_MEMBER_ID, "QQ", MEMBER_QQ);

  await attachRole(DUAL_ID, "ADMIN");
  await attachRole(DUAL_ID, "MEMBER");
  await attachCredential(DUAL_ID);

  for (const [id, profile, emailRow, email] of [
    [VERIFIED_ID, PROFILE("a4"), ROW("v4"), "gate-verified@example.com"],
    [HISTORICAL_ID, PROFILE("a5"), ROW("v5"), "gate-historical@example.com"],
  ] as const) {
    await attachProfile(profile, id, id === VERIFIED_ID ? "I146 已验证" : "I146 历史身份");
    await attachRole(id, "MEMBER");
    await attachCredential(id);
    // 历史口径：`verifiedAt` 有值但 `activeEmailKey` 为空（当年没写那把唯一键）。
    await attachIdentity(emailRow, id, "EMAIL", email, {
      activeKey: id === HISTORICAL_ID ? null : undefined,
    });
  }

  await attachProfile(PROFILE("a6"), CONFLICT_ID, "I146 多条身份");
  await attachRole(CONFLICT_ID, "MEMBER");
  await attachCredential(CONFLICT_ID);
  // 多条身份的真实形态：都不持有那把「当前邮箱」唯一键（历史漂移留下的行）。
  await attachIdentity(ROW("61"), CONFLICT_ID, "EMAIL", "gate-conflict-a@example.com", {
    activeKey: null,
  });
  await attachIdentity(ROW("62"), CONFLICT_ID, "EMAIL", "gate-conflict-b@example.com", {
    activeKey: null,
  });

  await attachProfile(PROFILE("a7"), EXEMPT_ID, "I146 豁免中");
  await attachRole(EXEMPT_ID, "MEMBER");
  await attachCredential(EXEMPT_ID);

  await attachProfile(PROFILE("a8"), FORCED_ID, "I146 待改密");
  await attachRole(FORCED_ID, "MEMBER");
  await attachCredential(FORCED_ID, true);
  // 链条用例从**真实登录**起步，所以这个「首次必须改密」账号也要有 QQ 身份。
  await attachIdentity(ROW("q8"), FORCED_ID, "QQ", FORCED_QQ);

  const now = new Date();
  await db.emailExemption.create({
    data: {
      id: EXEMPTION_ID,
      userId: EXEMPT_ID,
      reason: "门禁集成夹具：管理员授予的临时豁免",
      createdByUserId: ADMIN_ID,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    },
  });
}

/** 档位只从环境变量来（切换即重建配置缓存，等价于「重启实例」）。 */
async function withMode<T>(mode: EmailGateMode | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.EMAIL_GATE_MODE;
  if (mode === undefined) delete process.env.EMAIL_GATE_MODE;
  else process.env.EMAIL_GATE_MODE = mode;
  resetServerEnvForTests();
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EMAIL_GATE_MODE;
    else process.env.EMAIL_GATE_MODE = previous;
    resetServerEnvForTests();
  }
}

beforeEach(async () => {
  if (!enabled) return;
  await prepareFixtures();
});

after(async () => {
  if (!enabled) return;
  try {
    await dropFixtures();
  } finally {
    // 夹具清理失败也必须放掉连接池，否则 node 进程不会退出。
    await disconnectDb();
  }
});

const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
const code = (json: Record<string, unknown>) =>
  ((json.error ?? {}) as { code?: string }).code ?? "";
const accessOf = (json: Record<string, unknown>) =>
  (json.data as { accountAccess: Record<string, string | null> }).accountAccess;
const get = (handler: Parameters<typeof callRoute>[0], token: string, path: string) =>
  callRoute(handler, `http://localhost${path}`, { headers: cookie(token) });

dbTest("off 档（含未配置）保持既有行为：异常邮箱状态也不拦业务 API", async () => {
  for (const mode of [undefined, "off"] as const) {
    await withMode(mode, async () => {
      assert.equal(
        (await get(skillsRoute, await sessionFor(PENDING_MEMBER_ID), "/api/v1/skills")).status,
        200,
      );
      assert.equal(
        (
          await get(
            adminMembersRoute,
            await sessionFor(ADMIN_ID),
            "/api/v1/admin/members?page=1&pageSize=10",
          )
        ).status,
        200,
      );
      // 多条身份也不参与判定：`off` 连邮箱表都不读。
      assert.equal(
        (await get(skillsRoute, await sessionFor(CONFLICT_ID), "/api/v1/skills")).status,
        200,
      );
    });
  }
});

dbTest("all 档：已有会话的下一次业务请求被拒，403 而不是会话失效", async () => {
  await withMode("all", async () => {
    const token = await sessionFor(PENDING_MEMBER_ID);
    const blocked = await get(skillsRoute, token, "/api/v1/skills");
    assert.equal(blocked.status, 403);
    assert.equal(code(blocked.json), "EMAIL_VERIFICATION_REQUIRED");
    // `/me` 与登出在受限态仍可用：一个报告状态，一个清理会话，都不被门禁挡住。
    const me = await get(meRoute, token, "/api/v1/me");
    assert.equal(me.status, 200);
    assert.deepEqual(accessOf(me.json), {
      state: "EMAIL_VERIFICATION_REQUIRED",
      destination: "/account/email",
      exemptionExpiresAt: null,
    });
    assert.equal(
      (
        await callRoute(logoutRoute, "http://localhost/api/v1/auth/logout", {
          method: "POST",
          body: {},
          headers: cookie(token),
        })
      ).status,
      200,
    );
  });
});

dbTest("改密优先于邮箱；同一会话改完密立即改判为邮箱步骤（#113 顺序）", async () => {
  await withMode("all", async () => {
    const token = await sessionFor(FORCED_ID);
    const blocked = await get(skillsRoute, token, "/api/v1/skills");
    assert.equal(blocked.status, 403);
    assert.equal(code(blocked.json), "PASSWORD_CHANGE_REQUIRED");
    const principal = await authService.authenticate(token);
    assert.equal((await resolveAccountAccess({ principal })).state, "PASSWORD_CHANGE_REQUIRED");
    await getDb().passwordCredential.update({
      where: { userId: FORCED_ID },
      data: { mustChangePassword: false },
    });
    // 同一个 Session：判定只看**当次**从库里读到的状态，不拿上一次认证出来的快照。
    const changed = await authService.authenticate(token);
    assert.equal(changed.mustChangePassword, false);
    assert.equal(
      (await resolveAccountAccess({ principal: changed })).state,
      "EMAIL_VERIFICATION_REQUIRED",
    );
    assert.equal(
      code((await get(skillsRoute, token, "/api/v1/skills")).json),
      "EMAIL_VERIFICATION_REQUIRED",
    );
  });
});

dbTest("admin 档只约束当次管理员；双角色从成员侧接口也绕不过去", async () => {
  await withMode("admin", async () => {
    assert.equal(
      (await get(skillsRoute, await sessionFor(PENDING_MEMBER_ID), "/api/v1/skills")).status,
      200,
    );
    const admin = await sessionFor(ADMIN_ID);
    assert.equal(
      code((await get(adminMembersRoute, admin, "/api/v1/admin/members?page=1&pageSize=10")).json),
      "EMAIL_VERIFICATION_REQUIRED",
    );
    // 双角色即使打的是成员侧业务接口，`roles` 里有 ADMIN 就仍受 admin 档约束。
    const dual = await sessionFor(DUAL_ID);
    const dualBlocked = await get(skillsRoute, dual, "/api/v1/skills");
    assert.equal(dualBlocked.status, 403);
    assert.equal(code(dualBlocked.json), "EMAIL_VERIFICATION_REQUIRED");
  });
});

dbTest("已验证 / 有效豁免放行；撤销与到期在下一次请求即刻生效，不靠登录快照", async () => {
  await withMode("all", async () => {
    assert.equal(
      (await get(skillsRoute, await sessionFor(VERIFIED_ID), "/api/v1/skills")).status,
      200,
    );
    // 历史 activeEmailKey 为空但 verifiedAt 有值：仍算有效，不回填也不误判。
    assert.equal(
      (await get(skillsRoute, await sessionFor(HISTORICAL_ID), "/api/v1/skills")).status,
      200,
    );
    // 多条身份不猜选：既不算已验证，也不放行业务 API。
    assert.equal(
      code((await get(skillsRoute, await sessionFor(CONFLICT_ID), "/api/v1/skills")).json),
      "EMAIL_VERIFICATION_REQUIRED",
    );

    const exempt = await sessionFor(EXEMPT_ID);
    assert.equal((await get(skillsRoute, exempt, "/api/v1/skills")).status, 200);
    const me = await get(meRoute, exempt, "/api/v1/me");
    assert.equal(accessOf(me.json).state, "READY");
    assert.ok(accessOf(me.json).exemptionExpiresAt, "有效豁免要报出到期时间，供客户端提前复查");
    await getDb().emailExemption.update({
      where: { id: EXEMPTION_ID },
      data: { revokedAt: new Date(), revokedByUserId: ADMIN_ID },
    });
    assert.equal(
      code((await get(skillsRoute, exempt, "/api/v1/skills")).json),
      "EMAIL_VERIFICATION_REQUIRED",
    );
  });
});

dbTest("窄例外：恢复端点在门禁下可达，其余后台接口与权限边界不变", async () => {
  await withMode("admin", async () => {
    const admin = await sessionFor(ADMIN_ID);
    // 允许清单内的恢复入口：邮箱未验证的管理员仍要能查账号、签发临时口令。
    const lookup = await callRoute(
      accountLookupRoute,
      "http://localhost/api/v1/admin/accounts/lookup",
      {
        method: "POST",
        body: { qq: ADMIN_QQ },
        headers: cookie(admin),
      },
    );
    assert.equal(lookup.status, 200);
    assert.equal((lookup.json.data as { userId: string }).userId, ADMIN_ID);
    // 不按前缀通放：同在 `/admin/*` 下的成员名单与审计照样受门禁。
    assert.equal(
      code((await get(adminMembersRoute, admin, "/api/v1/admin/members?page=1&pageSize=10")).json),
      "EMAIL_VERIFICATION_REQUIRED",
    );
    assert.equal(
      code((await get(auditLogsRoute, admin, "/api/v1/admin/audit-logs?page=1&pageSize=10")).json),
      "EMAIL_VERIFICATION_REQUIRED",
    );
  });
  // 豁免不授予权限：成员拿着有效豁免打恢复端点，撞到的是权限而不是门禁。
  await withMode("all", async () => {
    const exempt = await sessionFor(EXEMPT_ID);
    const denied = await callRoute(
      accountLookupRoute,
      "http://localhost/api/v1/admin/accounts/lookup",
      {
        method: "POST",
        body: { qq: ADMIN_QQ },
        headers: cookie(exempt),
      },
    );
    assert.equal(denied.status, 403);
    assert.equal(code(denied.json), "FORBIDDEN");
  });
});

dbTest("登录落点由服务端统一编排，returnTo 沿链带上并受白名单约束", async () => {
  await withMode("all", async () => {
    const login = (body: Record<string, unknown>) =>
      callRoute(loginRoute, "http://localhost/api/v1/auth/login", { method: "POST", body });
    const destinationOf = (json: Record<string, unknown>) =>
      (json.data as { destination: string }).destination;
    const plain = await login({ qq: MEMBER_QQ, password: LOGIN_PASSWORD });
    assert.equal(plain.status, 200);
    assert.equal(accessOf(plain.json).state, "EMAIL_VERIFICATION_REQUIRED");
    assert.equal(destinationOf(plain.json), "/account/email");

    const chained = await login({
      qq: MEMBER_QQ,
      password: LOGIN_PASSWORD,
      returnTo: "/member/repairs",
    });
    assert.equal(destinationOf(chained.json), "/account/email?returnTo=%2Fmember%2Frepairs");
    // 外部目标不进链条：落点回默认步骤页，不带任何查询串。
    const evil = await login({
      qq: MEMBER_QQ,
      password: LOGIN_PASSWORD,
      returnTo: "https://evil.invalid",
    });
    assert.equal(destinationOf(evil.json), "/account/email");
  });
});

/**
 * 链条用例要走**真实会话**：登录与改密都会换发新 Session，而 `callRoute` 只回状态码与
 * JSON。这里直接调路由处理函数并把 Set-Cookie 里的会话取回来（同源头仍由
 * `sameOriginHeaders()` 给，行为与 `callRoute` 一致）。
 */
async function postChain(
  handler: Parameters<typeof callRoute>[0],
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown>; token: string }> {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        ...sameOriginHeaders(),
        "content-type": "application/json",
        ...(token ? cookie(token) : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  const json = (await response.json()) as Record<string, unknown>;
  const raw =
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
  return {
    status: response.status,
    json,
    token: decodeURI(raw.split(";")[0].slice(SESSION_COOKIE_NAME.length + 1)),
  };
}

const destinationOf = (json: Record<string, unknown>) =>
  (json.data as { destination: string }).destination;
/** `/me` 的载荷没有顶层 `destination`，落点在 `accountAccess` 里。 */
const meDestinationOf = (json: Record<string, unknown>) =>
  (json.data as { accountAccess: { destination: string } }).accountAccess.destination;

dbTest("返修 F4：一条完整链条 —— 业务原目标 → 登录 → 必须改密 → 邮箱 → 原目标", async () => {
  await withMode("all", async () => {
    const original = "/member/repairs";
    // 1) 未登录时页面守卫把当前业务页作为**候选**带去 /login（`?reason=expired&returnTo=…`），
    //    登录接口接住它：改密优先于邮箱，且步骤页的查询串里挂着原目标。
    const login = await postChain(loginRoute, "/api/v1/auth/login", {
      qq: FORCED_QQ,
      password: LOGIN_PASSWORD,
      returnTo: original,
    });
    assert.equal(login.status, 200);
    assert.equal(accessOf(login.json).state, "PASSWORD_CHANGE_REQUIRED");
    assert.equal(
      destinationOf(login.json),
      "/account/change-password?returnTo=%2Fmember%2Frepairs",
      "链条第一步：改密步骤带着候选原目标",
    );
    // 业务接口此时仍被拦（门禁不因「有候选」而放行）。
    assert.equal(
      code((await get(skillsRoute, login.token, "/api/v1/skills")).json),
      "PASSWORD_CHANGE_REQUIRED",
    );

    // 2) 改密接口沿用同一条链：改完密的下一步是邮箱步骤，原目标继续挂在查询串上。
    //    会话由这一步换发，后面的请求都用新会话（`changed.token`）。
    const changed = await postChain(
      passwordChangeRoute,
      "/api/v1/auth/password/change",
      {
        currentPassword: LOGIN_PASSWORD,
        newPassword: CHAINED_PASSWORD,
        newPasswordConfirmation: CHAINED_PASSWORD,
        returnTo: original,
      },
      login.token,
    );
    assert.equal(changed.status, 200, "改密接口不能因为带 returnTo 而拒绝");
    assert.equal(accessOf(changed.json).state, "EMAIL_VERIFICATION_REQUIRED");
    assert.equal(destinationOf(changed.json), "/account/email?returnTo=%2Fmember%2Frepairs");

    // 3) 邮箱这一步解决（夹具按现行口径写入「已验证」身份；真实收码仍是上线前待联调）。
    await attachIdentity(ROW("c1"), FORCED_ID, "EMAIL", "gate-chain@example.com");
    // 4) 跟随器 / 步骤页带着候选请求服务端：终点就是最初那个业务页 —— 链条闭合。
    const done = await get(
      meRoute,
      changed.token,
      `/api/v1/me?returnTo=${encodeURIComponent(original)}`,
    );
    assert.equal(accessOf(done.json).state, "READY");
    assert.equal(meDestinationOf(done.json), original, "链条最后一步回到业务原目标");

    // 候选不是绕过标志：伪造的外部地址与当前角色无权的目标都只回角色默认页，判定不变。
    for (const forged of ["https://evil.invalid", "/admin/members"]) {
      const denied = await get(
        meRoute,
        changed.token,
        `/api/v1/me?returnTo=${encodeURIComponent(forged)}`,
      );
      assert.equal(accessOf(denied.json).state, "READY");
      assert.equal(meDestinationOf(denied.json), "/member", `不该接受候选：${forged}`);
    }
    // 没有候选时同样回角色默认页（`/me` 的编排不依赖请求自带任何放行标志）。
    assert.equal(meDestinationOf((await get(meRoute, changed.token, "/api/v1/me")).json), "/member");
  });
});

dbTest("返修 F4：仅邮箱受限不拦改密接口，且 /me 给出的步骤落点仍带着链条", async () => {
  await withMode("all", async () => {
    const login = await postChain(loginRoute, "/api/v1/auth/login", {
      qq: MEMBER_QQ,
      password: LOGIN_PASSWORD,
      returnTo: "/member/repairs",
    });
    assert.equal(accessOf(login.json).state, "EMAIL_VERIFICATION_REQUIRED");
    assert.equal(destinationOf(login.json), "/account/email?returnTo=%2Fmember%2Frepairs");
    // 业务接口被邮箱门禁拦住。
    assert.equal(
      code((await get(skillsRoute, login.token, "/api/v1/skills")).json),
      "EMAIL_VERIFICATION_REQUIRED",
    );
    // 但改密接口/页面必须照常可用（任务书：邮箱受限不剥夺改密能力）。
    const changed = await postChain(
      passwordChangeRoute,
      "/api/v1/auth/password/change",
      {
        currentPassword: LOGIN_PASSWORD,
        newPassword: CHAINED_PASSWORD,
        newPasswordConfirmation: CHAINED_PASSWORD,
        returnTo: "/member/repairs",
      },
      login.token,
    );
    assert.equal(changed.status, 200);
    assert.equal(accessOf(changed.json).state, "EMAIL_VERIFICATION_REQUIRED");
    assert.equal(
      destinationOf(changed.json),
      "/account/email?returnTo=%2Fmember%2Frepairs",
      "改密之后仍回到挂着原目标的邮箱步骤",
    );
  });
});
