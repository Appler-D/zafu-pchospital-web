import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import ExcelJS from "exceljs";

import { POST as inviteRegistrationRoute } from "../../src/app/api/v1/member-registrations/invite/route";
import { POST as joinApplicationRoute } from "../../src/app/api/v1/join-applications/route";
import { joinApplicationExportService } from "../../src/features/admin/join-application-export-service";
import { inviteCodeService } from "../../src/features/invitations/invite-code-service";
import { joinApplicationService } from "../../src/features/recruitment/join-application-service";
import { AppError } from "../../src/lib/api/errors";
import { redactAuditSummary } from "../../src/lib/audit/redaction";
import { resetRateLimitsForTests } from "../../src/lib/api/rate-limit";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import type { AuthorizedActor } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";
import { sameOriginHeaders } from "./http-harness";
import { sessionCookie } from "./http-harness";
import { accountProvisionService } from "../../src/features/accounts/account-provision-service";
import { AccountNotificationService } from "../../src/features/email/account-notification-service";
import {
  preoccupyEmailSendQuota,
  emailBucketKeys,
} from "../../src/features/email/email-rate-limit";
import { inSerializableTransaction } from "../../src/lib/db/transaction";
import { digestEmailBucketKey } from "../../src/lib/security/email-security";
import { hashPassword } from "../../src/lib/security/secrets";
import type { MailConfig } from "../../src/lib/env";
import type { EmailMessage, EmailDeliveryOutcome } from "../../src/lib/email/mailer";
import { POST as retryNotificationRoute } from "../../src/app/api/v1/admin/join-applications/[id]/notification/retry/route";

/**
 * 学号 / 班级贯通：邀请码注册与公开招募两个入口的前后端、存储、
 * 详情、导出与发放建档。
 *
 * 命名空间：`realName` 前缀 `I147 `、招募批次前缀 `I147-`、管理员 UUID `e1470000-…`；
 * 清理只按这些前缀与 `EXACT_NAME_FIXTURES` 精确清单限定，绝不触碰库里其它测试与开发数据。
 *
 * F01 / F04 从**真实路由**打进（`callRoute` 同款的最小装置，但这里需要读
 * `Set-Cookie`，所以自己组 Request）；其余走 Service，与 m0 / m6 系列保持一致。
 */
const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

const NAME_PREFIX = "I147 ";
const CYCLE_PREFIX = "I147-";

/**
 * 精确长度姓名**不带**命名空间前缀 —— 长度本身就是断言对象，
 * 只能按清单精确匹配清理；清单里只放本文件会写入的姓名。
 */
const EXACT_NAME_FIXTURES = ["I1"];

/** 本文件数据的作用域：姓名带 `I147 ` 前缀，或命中精确长度清单。 */
function nameScope() {
  return {
    OR: [{ realName: { startsWith: NAME_PREFIX } }, { realName: { in: EXACT_NAME_FIXTURES } }],
  };
}
const INVITE_PATH = "/api/v1/member-registrations/invite";
const JOIN_PATH = "/api/v1/join-applications";
const ADMIN_USER_ID = "e1470000-0000-4000-8000-000000000001";

const ADMIN_ACTOR: AuthorizedActor = {
  actorType: "USER",
  userId: ADMIN_USER_ID,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_i147_admin",
};

/** 只持有 MEMBER 权限：用来钉住「没有 data:export 就不能导出」。 */
const MEMBER_ACTOR: AuthorizedActor = {
  actorType: "USER",
  userId: "e1470000-0000-4000-8000-000000000099",
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["MEMBER"]),
  requestId: "req_i147_member",
};

/** 按前缀清掉本文件建的一切（顺序满足 RESTRICT 外键），再重建管理员。 */
async function prepareFixtures(): Promise<void> {
  const db = getDb();
  const profiles = await db.memberProfile.findMany({
    where: nameScope(),
    select: { id: true, userId: true },
  });
  const userIds = [...new Set(profiles.map((row) => row.userId))];
  const profileIds = profiles.map((row) => row.id);
  const applications = await db.joinApplication.findMany({
    where: nameScope(),
    select: { id: true },
  });
  const applicationIds = applications.map((row) => row.id);
  const provisions = await db.accountProvision.findMany({
    where: { OR: [{ userId: { in: userIds } }, { memberProfileId: { in: profileIds } }] },
    select: { id: true },
  });
  const notifications = await db.accountNotification.findMany({
    where: { applicationId: { in: applicationIds } },
    select: { id: true },
  });

  // 审计对 User 是 Restrict 外键，必须先于用户删除；再按 target 清掉 SYSTEM 动作留下的行。
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: [...userIds, ADMIN_USER_ID] } },
        {
          targetId: {
            in: [
              ...applicationIds,
              ...profileIds,
              ...provisions.map((row) => row.id),
              ...notifications.map((row) => row.id),
            ],
          },
        },
      ],
    },
  });
  await db.accountNotification.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await db.accountProvision.deleteMany({
    where: { OR: [{ userId: { in: userIds } }, { memberProfileId: { in: profileIds } }] },
  });
  await db.inviteCodeRedemption.deleteMany({ where: { userId: { in: userIds } } });
  await db.joinApplicationReview.deleteMany({
    where: { applicationId: { in: applicationIds } },
  });
  await db.joinApplication.deleteMany({ where: nameScope() });
  await db.inviteCode.deleteMany({ where: { createdByUserId: ADMIN_USER_ID } });
  await db.authSession.deleteMany({ where: { userId: { in: [...userIds, ADMIN_USER_ID] } } });
  await db.passwordCredential.deleteMany({
    where: { userId: { in: [...userIds, ADMIN_USER_ID] } },
  });
  await db.userRole.deleteMany({ where: { userId: { in: [...userIds, ADMIN_USER_ID] } } });
  await db.userIdentity.deleteMany({ where: { userId: { in: userIds } } });
  await db.memberProfile.deleteMany({ where: { id: { in: profileIds } } });
  await db.user.deleteMany({ where: { id: { in: [...userIds, ADMIN_USER_ID] } } });

  const now = new Date();
  await db.user.create({
    data: {
      id: ADMIN_USER_ID,
      status: "ACTIVE",
      displayName: "I147 Admin",
      createdAt: now,
      updatedAt: now,
    },
  });
  // 限流桶是进程内的：上一用例耗掉的额度不能影响下一用例。
  resetRateLimitsForTests();
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

/* ------------------------------------------------------------------ 装置 */

type ErrorPayload = { code: string; message: string; fieldErrors?: Record<string, string[]> };

let seq = 0;
/** 本文件内唯一的 QQ / 手机号尾段（同库串行跑，删除干净后仍避免同毫秒重复）。 */
function serial(): string {
  seq += 1;
  return `${Date.now()}`.slice(-5) + String(seq).padStart(3, "0");
}

function joinBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = serial();
  return {
    realName: `${NAME_PREFIX}报名者`,
    qq: `8${value}`.slice(0, 11),
    phone: `139${value}`.slice(0, 11),
    email: "applicant@example.com",
    studentId: "001234",
    className: "计算机 233",
    privacyConsent: true,
    ...overrides,
  };
}

function omit(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[key];
  return copy;
}

/**
 * 直接调用路由处理函数（`callRoute` 的变体：这里要看 `Set-Cookie`，
 * 且需要逐请求换 `x-real-ip` 避开公开写限流 —— 同 IP 连打 12 次会被 429）。
 */
async function postJson(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: Record<string, unknown>,
  ip: string,
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      ...sameOriginHeaders(),
      "content-type": "application/json",
      "x-real-ip": ip,
    },
    body: JSON.stringify(body),
  });
  const response = await handler(request);
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: json, response };
}

function errorOf(json: Record<string, unknown>): ErrorPayload {
  const error = json.error;
  assert.ok(error, `响应缺少 error 字段：${JSON.stringify(json)}`);
  return error as ErrorPayload;
}

async function createInviteCode(maxUses = 1) {
  return inviteCodeService.create({ maxUses }, ADMIN_ACTOR);
}

function countMyApplications(): Promise<number> {
  return getDb().joinApplication.count({ where: { realName: { startsWith: NAME_PREFIX } } });
}

/** 模拟迁移前的历史报名：两列为 NULL（或只填其一），直接落库，不走应用层。 */
async function createHistoricalApplication(input: {
  realName: string;
  qq: string;
  phone: string;
  studentId?: string | null;
  className?: string | null;
}) {
  const now = new Date();
  return getDb().joinApplication.create({
    data: {
      id: randomUUID(),
      ticketNo: `JA-${randomBytes(12).toString("hex").toUpperCase()}`,
      recruitmentCycle: `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`,
      realName: input.realName,
      studentId: input.studentId ?? null,
      className: input.className ?? null,
      qqNormalized: input.qq.replace(/\D/g, ""),
      phoneNormalized: input.phone.replace(/\D/g, ""),
      status: "SUBMITTED",
      provisionStatus: "NOT_REQUIRED",
      privacyConsentAt: now,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

async function provisionHistoricalPass(applicationId: string, keyPrefix: string) {
  await getDb().joinApplication.update({
    where: { id: applicationId },
    data: { status: "INTERVIEW_PASSED", provisionStatus: "PENDING" },
  });
  return accountProvisionService.provisionFromApplication(
    applicationId,
    `${keyPrefix}-${applicationId}`,
  );
}

function reviewPassed(applicationId: string, keyPrefix: string) {
  return joinApplicationService.review(
    {
      applicationId,
      result: "PASSED",
      admittedDepartment: "REPAIR",
      interviewedAt: new Date().toISOString(),
      idempotencyKey: `${keyPrefix}-${applicationId}`,
    },
    ADMIN_ACTOR,
  );
}

async function profileOfUser(userId: string) {
  return getDb().memberProfile.findUniqueOrThrow({ where: { userId } });
}

function csvLines(bytes: Uint8Array): string[] {
  return new TextDecoder("utf-8", { ignoreBOM: true })
    .decode(bytes)
    .split("\r\n")
    .filter((line) => line.length > 0);
}

async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  // exceljs 的 d.ts 自己声明了 `interface Buffer extends ArrayBuffer`，与 Node 的 Buffer
  // 在类型上互不兼容（运行时完全一致，`load` 原样传给 unzip）。
  // 这里对齐它声明的参数类型做一次显式转换。
  type LoadInput = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as LoadInput);
  return workbook;
}

function columnIndex(row: ExcelJS.Row, header: string): number {
  for (let index = 1; index <= row.cellCount; index += 1) {
    if (row.getCell(index).value === header) return index;
  }
  throw new Error(`未找到列头：${header}`);
}

/* ------------------------------------------------------ F01 字段校验（HTTP） */

dbTest("F01 邀请码注册：缺失 / 空串 / 纯空白 / 非字符串 / 超长都返回字段错误且不写入", async () => {
  const code = await createInviteCode(5);
  const base = {
    code: code.plainCode,
    idempotencyKey: randomUUID(),
    realName: `${NAME_PREFIX}校验者`,
    qq: "801470001",
    phone: "13901470001",
    studentId: "202310120101",
    className: "计算机 233",
    password: "I147-Password",
    passwordConfirmation: "I147-Password",
  };
  const cases: Array<{
    label: string;
    body: Record<string, unknown>;
    field: "studentId" | "className";
  }> = [
    { label: "studentId 缺失", body: omit(base, "studentId"), field: "studentId" },
    { label: "studentId 空串", body: { ...base, studentId: "" }, field: "studentId" },
    { label: "studentId 纯空白", body: { ...base, studentId: "   " }, field: "studentId" },
    { label: "studentId 数字", body: { ...base, studentId: 20231012 }, field: "studentId" },
    { label: "studentId 对象", body: { ...base, studentId: { id: 1 } }, field: "studentId" },
    {
      label: "studentId 33 字符",
      body: { ...base, studentId: "1".repeat(33) },
      field: "studentId",
    },
    { label: "className 缺失", body: omit(base, "className"), field: "className" },
    { label: "className 空串", body: { ...base, className: "" }, field: "className" },
    { label: "className 纯空白", body: { ...base, className: "   " }, field: "className" },
    {
      label: "className 数组",
      body: { ...base, className: ["计算机 233"] },
      field: "className",
    },
    {
      label: "className 81 字符",
      body: { ...base, className: "班".repeat(81) },
      field: "className",
    },
  ];

  const usersBefore = await getDb().user.count();
  const redemptionsBefore = await getDb().inviteCodeRedemption.count();

  let requestIndex = 0;
  for (const item of cases) {
    requestIndex += 1;
    const result = await postJson(
      inviteRegistrationRoute,
      INVITE_PATH,
      item.body,
      `10.147.1.${requestIndex}`,
    );
    assert.equal(result.status, 400, `${item.label} 应返回 400`);
    const error = errorOf(result.body);
    assert.equal(error.code, "VALIDATION_FAILED", `${item.label} 的错误码`);
    assert.ok(
      error.fieldErrors?.[item.field]?.length,
      `${item.label} 应带 ${item.field} 字段错误，实际：${JSON.stringify(error.fieldErrors)}`,
    );
  }

  assert.equal(await getDb().user.count(), usersBefore, "非法输入不得创建用户");
  assert.equal(
    await getDb().inviteCodeRedemption.count(),
    redemptionsBefore,
    "非法输入不得写兑换记录",
  );
  const untouched = await getDb().inviteCode.findUniqueOrThrow({ where: { id: code.id } });
  assert.equal(untouched.usedCount, 0, "非法输入不得消耗邀请码次数");

  // 对照：同一邀请码的合法输入成功（说明上面的 400 全部来自字段本身，而不是码的问题）。
  const accepted = await postJson(inviteRegistrationRoute, INVITE_PATH, base, "10.147.1.99");
  assert.equal(accepted.status, 201, `合法输入应成功：${JSON.stringify(accepted.body)}`);
  const consumed = await getDb().inviteCode.findUniqueOrThrow({ where: { id: code.id } });
  assert.equal(consumed.usedCount, 1);
});

dbTest(
  "F01 公开招募：缺失 / 空串 / 纯空白 / 非字符串 / 超长都返回字段错误且不创建报名",
  async () => {
    const base = joinBody({ realName: `${NAME_PREFIX}校验者` });
    const cases: Array<{
      label: string;
      body: Record<string, unknown>;
      field: "studentId" | "className";
    }> = [
      { label: "studentId 缺失", body: omit(base, "studentId"), field: "studentId" },
      { label: "studentId 空串", body: { ...base, studentId: "" }, field: "studentId" },
      { label: "studentId 纯空白", body: { ...base, studentId: "\t \n" }, field: "studentId" },
      { label: "studentId 数字", body: { ...base, studentId: 20231012 }, field: "studentId" },
      { label: "studentId 布尔", body: { ...base, studentId: true }, field: "studentId" },
      {
        label: "studentId 33 字符",
        body: { ...base, studentId: "1".repeat(33) },
        field: "studentId",
      },
      { label: "className 缺失", body: omit(base, "className"), field: "className" },
      { label: "className 空串", body: { ...base, className: "" }, field: "className" },
      { label: "className 纯空白", body: { ...base, className: "   " }, field: "className" },
      {
        label: "className 对象",
        body: { ...base, className: { name: "计算机 233" } },
        field: "className",
      },
      {
        label: "className 81 字符",
        body: { ...base, className: "班".repeat(81) },
        field: "className",
      },
    ];

    const countBefore = await countMyApplications();
    let requestIndex = 0;
    for (const item of cases) {
      requestIndex += 1;
      const result = await postJson(
        joinApplicationRoute,
        JOIN_PATH,
        item.body,
        `10.147.2.${requestIndex}`,
      );
      assert.equal(result.status, 400, `${item.label} 应返回 400`);
      const error = errorOf(result.body);
      assert.equal(error.code, "VALIDATION_FAILED", `${item.label} 的错误码`);
      assert.ok(
        error.fieldErrors?.[item.field]?.length,
        `${item.label} 应带 ${item.field} 字段错误，实际：${JSON.stringify(error.fieldErrors)}`,
      );
    }
    assert.equal(await countMyApplications(), countBefore, "非法输入不得创建报名");

    // 对照：合法输入成功。
    const accepted = await postJson(joinApplicationRoute, JOIN_PATH, base, "10.147.2.99");
    assert.equal(accepted.status, 201, `合法输入应成功：${JSON.stringify(accepted.body)}`);
    assert.equal(await countMyApplications(), countBefore + 1);
  },
);

/* ------------------------------------------------- F02 规范化与边界长度 */

dbTest(
  "F02 trim 后 1 / 32 位学号、1 / 80 字符班级可提交；001234 读取、发放后仍为字符串",
  async () => {
    const value = serial();
    const receipt = await joinApplicationService.submit(
      {
        recruitmentCycle: `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`,
        realName: `${NAME_PREFIX}前导零`,
        qq: `8${value}`.slice(0, 11),
        phone: `139${value}`.slice(0, 11),
        email: "applicant@example.com",
        studentId: "  001234  ",
        className: " 计算机 233 ",
        privacyConsent: true,
      },
      { requestId: "req_i147_f02" },
    );

    const row = await getDb().joinApplication.findUniqueOrThrow({ where: { id: receipt.id } });
    assert.equal(row.studentId, "001234", "trim 后落库且保留前导零");
    assert.equal(typeof row.studentId, "string");
    assert.equal(row.className, "计算机 233");

    const detail = await joinApplicationService.get(receipt.id, ADMIN_ACTOR);
    assert.equal(detail.studentId, "001234");
    assert.equal(detail.className, "计算机 233");

    const reviewed = await reviewPassed(receipt.id, "i147-f02");
    assert.equal(reviewed.provisionStatus, "SUCCEEDED");
    const provision = await getDb().accountProvision.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: receipt.id } },
    });
    const profile = await profileOfUser(provision.userId!);
    assert.equal(profile.studentId, "001234", "发放后档案里仍为字符串 001234");
    assert.equal(typeof profile.studentId, "string");
    assert.equal(profile.className, "计算机 233");

    // 边界：1 位学号 / 1 字符班级
    const minValue = serial();
    const minimum = await joinApplicationService.submit(
      {
        recruitmentCycle: `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`,
        realName: `${NAME_PREFIX}边界最小`,
        qq: `8${minValue}`.slice(0, 11),
        phone: `139${minValue}`.slice(0, 11),
        email: "applicant@example.com",
        studentId: " 1 ",
        className: "A",
        privacyConsent: true,
      },
      { requestId: "req_i147_f02_min" },
    );
    const minRow = await getDb().joinApplication.findUniqueOrThrow({ where: { id: minimum.id } });
    assert.equal(minRow.studentId, "1");
    assert.equal(minRow.className, "A");

    // 边界：32 位学号 / 80 字符班级
    const maxValue = serial();
    const maximum = await joinApplicationService.submit(
      {
        recruitmentCycle: `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`,
        realName: `${NAME_PREFIX}边界最大`,
        qq: `8${maxValue}`.slice(0, 11),
        phone: `139${maxValue}`.slice(0, 11),
        email: "applicant@example.com",
        studentId: "1".repeat(32),
        className: "班".repeat(80),
        privacyConsent: true,
      },
      { requestId: "req_i147_f02_max" },
    );
    const maxRow = await getDb().joinApplication.findUniqueOrThrow({ where: { id: maximum.id } });
    assert.equal(maxRow.studentId, "1".repeat(32));
    assert.equal(maxRow.className, "班".repeat(80));
  },
);

/* ------------------------------------------- F03 学号非唯一 / 联系方式规则 */

dbTest("F03 相同学号可属不同账号；QQ / 手机号去重与归一化保持正常", async () => {
  const s1 = serial();
  const s2 = serial();
  const codeA = await createInviteCode(1);
  const codeB = await createInviteCode(1);
  const first = await inviteCodeService.redeem(
    {
      code: codeA.plainCode,
      idempotencyKey: randomUUID(),
      realName: `${NAME_PREFIX}同号一`,
      qq: `8${s1}`.slice(0, 11),
      phone: `139${s1}`.slice(0, 11),
      studentId: "001234",
      className: "计算机 233",
      password: "I147-Password",
    },
    { requestId: "req_i147_f03_a" },
  );
  const second = await inviteCodeService.redeem(
    {
      code: codeB.plainCode,
      idempotencyKey: randomUUID(),
      realName: `${NAME_PREFIX}同号二`,
      qq: `8${s2}`.slice(0, 11),
      phone: `139${s2}`.slice(0, 11),
      studentId: "001234",
      className: "计算机 234",
      password: "I147-Password",
    },
    { requestId: "req_i147_f03_b" },
  );
  assert.notEqual(first.userId, second.userId);
  assert.equal((await profileOfUser(first.userId)).studentId, "001234");
  assert.equal((await profileOfUser(second.userId)).studentId, "001234");

  // QQ / 手机号归一化 + 同批次去重不受新增字段影响。
  const cycle = `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`;
  const s3 = serial();
  const submitted = await joinApplicationService.submit(
    {
      recruitmentCycle: cycle,
      realName: `${NAME_PREFIX}归一化`,
      qq: `80 ${s3.slice(0, 3)} ${s3.slice(3)}`,
      phone: `139 ${s3.slice(0, 4)} ${s3.slice(4)}`,
      email: "applicant@example.com",
      studentId: "001234",
      className: "计算机 235",
      privacyConsent: true,
    },
    { requestId: "req_i147_f03_norm" },
  );
  const stored = await getDb().joinApplication.findUniqueOrThrow({ where: { id: submitted.id } });
  assert.equal(stored.qqNormalized, `80${s3}`.replace(/\D/g, ""));
  assert.equal(stored.phoneNormalized, `139${s3}`.replace(/\D/g, ""));

  const replay = await joinApplicationService.submit(
    {
      recruitmentCycle: cycle,
      realName: `${NAME_PREFIX}归一化`,
      qq: `80${s3}`,
      phone: `139${s3}`,
      email: "applicant@example.com",
      studentId: "001234",
      className: "计算机 235",
      privacyConsent: true,
    },
    { requestId: "req_i147_f03_dup" },
  );
  assert.equal(replay.duplicate, true, "同一批次相同 QQ 应识别为重复报名");
  assert.equal(replay.id, submitted.id);
});

/* --------------------------------------------------- F04 密码与会话链路 */

dbTest("F04 注册密码边界 / 确认不一致 / 合法注册建会话；招募接口不要求密码", async () => {
  const code = await createInviteCode(2);
  const base = {
    code: code.plainCode,
    idempotencyKey: randomUUID(),
    realName: `${NAME_PREFIX}密码`,
    qq: "801470004",
    phone: "13901470004",
    studentId: "001234",
    className: "计算机 233",
    password: "123456",
    passwordConfirmation: "123456",
  };

  // 5 位口令被服务端密码策略拒绝（现策略下限 6）。
  const shortPassword = await postJson(
    inviteRegistrationRoute,
    INVITE_PATH,
    { ...base, idempotencyKey: randomUUID(), password: "12345", passwordConfirmation: "12345" },
    "10.147.4.1",
  );
  assert.equal(shortPassword.status, 400);
  assert.equal(errorOf(shortPassword.body).code, "VALIDATION_FAILED");

  // 确认不一致在路由层拦截。
  const mismatch = await postJson(
    inviteRegistrationRoute,
    INVITE_PATH,
    { ...base, idempotencyKey: randomUUID(), passwordConfirmation: "654321" },
    "10.147.4.2",
  );
  assert.equal(mismatch.status, 400);
  assert.equal(errorOf(mismatch.body).code, "PASSWORD_CONFIRMATION_MISMATCH");

  // 合法注册：201 + 会话 Cookie（自动登录）。
  const accepted = await postJson(
    inviteRegistrationRoute,
    INVITE_PATH,
    { ...base, idempotencyKey: randomUUID() },
    "10.147.4.3",
  );
  assert.equal(accepted.status, 201, `合法注册应成功：${JSON.stringify(accepted.body)}`);
  const cookie = accepted.response.headers.get("set-cookie") ?? "";
  assert.ok(cookie.includes("pc_hospital_session="), `应设置会话 Cookie：${cookie}`);
  const data = accepted.body.data as { userId: string };
  assert.equal(await getDb().authSession.count({ where: { userId: data.userId } }), 1);

  // 招募接口不要求密码：带学号 / 班级即可提交。
  const joined = await postJson(joinApplicationRoute, JOIN_PATH, joinBody(), "10.147.4.4");
  assert.equal(joined.status, 201, `招募提交不要求密码：${JSON.stringify(joined.body)}`);
});

/* ---------------------------------------- F05 新报名全链路（含两种导出） */

dbTest("F05 新报名 → 详情 → CSV / XLSX 导出 → 审核通过 → 成员档案，两字段全程一致", async () => {
  const value = serial();
  const receipt = await joinApplicationService.submit(
    {
      recruitmentCycle: `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`,
      realName: `${NAME_PREFIX}全链路`,
      qq: `8${value}`.slice(0, 11),
      phone: `139${value}`.slice(0, 11),
      email: "applicant@example.com",
      studentId: "001234",
      className: "计算机 233",
      privacyConsent: true,
    },
    { requestId: "req_i147_f05" },
  );

  const detail = await joinApplicationService.get(receipt.id, ADMIN_ACTOR);
  assert.equal(detail.studentId, "001234");
  assert.equal(detail.className, "计算机 233");

  const csv = await joinApplicationExportService.export(
    { query: receipt.ticketNo },
    "CSV",
    ADMIN_ACTOR,
  );
  assert.equal(csv.rowCount, 1);
  const csvRow = csvLines(csv.body)[1]!;
  const csvCells = csvRow.split(",");
  assert.equal(csvCells[3], "001234", "CSV 学号列（姓名后）保留前导零");
  assert.equal(csvCells[4], "计算机 233");

  const xlsx = await joinApplicationExportService.export(
    { query: receipt.ticketNo },
    "XLSX",
    ADMIN_ACTOR,
  );
  const workbook = await loadWorkbook(xlsx.body);
  const sheet = workbook.getWorksheet("报名记录");
  assert.ok(sheet, "缺少「报名记录」工作表");
  const header = sheet.getRow(1);
  const nameColumn = columnIndex(header, "姓名");
  const studentColumn = columnIndex(header, "学号");
  const classColumn = columnIndex(header, "班级");
  assert.equal(studentColumn, nameColumn + 1, "学号列应紧跟姓名列");
  assert.equal(classColumn, studentColumn + 1, "班级列应紧跟学号列");
  const dataRow = sheet.getRow(2);
  assert.equal(dataRow.getCell(studentColumn).value, "001234");
  assert.equal(typeof dataRow.getCell(studentColumn).value, "string");
  assert.equal(dataRow.getCell(classColumn).value, "计算机 233");

  const reviewed = await reviewPassed(receipt.id, "i147-f05");
  assert.equal(reviewed.provisionStatus, "SUCCEEDED");
  const provision = await getDb().accountProvision.findUniqueOrThrow({
    where: { sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: receipt.id } },
  });
  const profile = await profileOfUser(provision.userId!);
  assert.equal(profile.studentId, "001234");
  assert.equal(profile.className, "计算机 233");
});

/* ----------------------------------------------- F06 历史报名兼容与发放 */

dbTest(
  "F06 历史报名两字段均为空 / 仅一项为空：可查询、导出、发放，且不清空档案有效值",
  async () => {
    // 用户 A：先注册建档（有效值），再有一条第「两列均 NULL」的历史报名 → 发放不得清空档案。
    const sA = serial();
    const codeA = await createInviteCode(1);
    const regA = await inviteCodeService.redeem(
      {
        code: codeA.plainCode,
        idempotencyKey: randomUUID(),
        realName: `${NAME_PREFIX}历史空`,
        qq: `8${sA}`.slice(0, 11),
        phone: `139${sA}`.slice(0, 11),
        studentId: "KEEP-A1",
        className: "KEEP-A2",
        password: "I147-Password",
      },
      { requestId: "req_i147_f06_a" },
    );
    const appA = await createHistoricalApplication({
      realName: `${NAME_PREFIX}历史空`,
      qq: `8${sA}`.slice(0, 11),
      phone: `139${sA}`.slice(0, 11),
    });
    const detailA = await joinApplicationService.get(appA.id, ADMIN_ACTOR);
    assert.equal(detailA.studentId, null);
    assert.equal(detailA.className, null);

    const csvA = await joinApplicationExportService.export(
      { query: appA.ticketNo },
      "CSV",
      ADMIN_ACTOR,
    );
    const rowA = csvLines(csvA.body)[1]!;
    const cellsA = rowA.split(",");
    assert.equal(cellsA[3], "", "历史学号导出空字符串");
    assert.equal(cellsA[4], "", "历史班级导出空字符串");
    assert.ok(!rowA.includes("null") && !rowA.includes("undefined"), `不得导出字面量：${rowA}`);

    await provisionHistoricalPass(appA.id, "i147-f06-a");
    const profileA = await profileOfUser(regA.userId);
    assert.equal(profileA.studentId, "KEEP-A1", "历史空值不得清空档案学号");
    assert.equal(profileA.className, "KEEP-A2", "历史空值不得清空档案班级");

    // 用户 B：历史报名仅一项为空（学号 NULL、班级有值）→ 有效新值写入、空项保留。
    const sB = serial();
    const codeB = await createInviteCode(1);
    const regB = await inviteCodeService.redeem(
      {
        code: codeB.plainCode,
        idempotencyKey: randomUUID(),
        realName: `${NAME_PREFIX}历史半空`,
        qq: `8${sB}`.slice(0, 11),
        phone: `139${sB}`.slice(0, 11),
        studentId: "KEEP-B1",
        className: "KEEP-B2",
        password: "I147-Password",
      },
      { requestId: "req_i147_f06_b" },
    );
    const appB = await createHistoricalApplication({
      realName: `${NAME_PREFIX}历史半空`,
      qq: `8${sB}`.slice(0, 11),
      phone: `139${sB}`.slice(0, 11),
      studentId: null,
      className: "老班级 B",
    });
    await provisionHistoricalPass(appB.id, "i147-f06-b");
    const profileB = await profileOfUser(regB.userId);
    assert.equal(profileB.studentId, "KEEP-B1", "仅一项为空时，已有有效学号保留");
    assert.equal(profileB.className, "老班级 B", "有效新值沿用既有发放更新语义写入");
  },
);

/* --------------------------------------------- F07 幂等与重复提交 */

dbTest("F07 重复报名 / 邀请码重放 / 发放重试不重复计数、不重新发密码、不覆盖已有凭据", async () => {
  // 1) 重复报名沿用原回执，不改写原记录。
  const cycle = `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`;
  const s1 = serial();
  const first = await joinApplicationService.submit(
    {
      recruitmentCycle: cycle,
      realName: `${NAME_PREFIX}重复`,
      qq: `8${s1}`.slice(0, 11),
      phone: `139${s1}`.slice(0, 11),
      email: "applicant@example.com",
      studentId: "001234",
      className: "计算机 233",
      privacyConsent: true,
    },
    { requestId: "req_i147_f07_dup_a" },
  );
  const duplicate = await joinApplicationService.submit(
    {
      recruitmentCycle: cycle,
      realName: `${NAME_PREFIX}重复`,
      qq: `8${s1}`.slice(0, 11),
      phone: `139${s1}`.slice(0, 11),
      email: "applicant@example.com",
      studentId: "888888",
      className: "另一个班",
      privacyConsent: true,
    },
    { requestId: "req_i147_f07_dup_b" },
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, first.id);
  const original = await getDb().joinApplication.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(original.studentId, "001234", "重复提交不得静默改写原记录");
  assert.equal(await getDb().joinApplication.count({ where: { recruitmentCycle: cycle } }), 1);

  // 2) 邀请码幂等重放：不重复消耗、不重复建号、不改写档案。
  const code = await createInviteCode(1);
  const idempotencyKey = randomUUID();
  const s2 = serial();
  const redeemBody = {
    code: code.plainCode,
    idempotencyKey,
    realName: `${NAME_PREFIX}重放`,
    qq: `8${s2}`.slice(0, 11),
    phone: `139${s2}`.slice(0, 11),
    studentId: "001234",
    className: "计算机 233",
    password: "I147-Password",
  };
  const accepted = await inviteCodeService.redeem(redeemBody, { requestId: "req_i147_f07_a" });
  const replay = await inviteCodeService.redeem(
    { ...redeemBody, studentId: "999999" },
    { requestId: "req_i147_f07_b" },
  );
  assert.equal(replay.redemptionId, accepted.redemptionId);
  assert.equal(replay.userId, accepted.userId);
  const codeRow = await getDb().inviteCode.findUniqueOrThrow({ where: { id: code.id } });
  assert.equal(codeRow.usedCount, 1, "幂等重放不重复消耗");
  assert.equal(await getDb().inviteCodeRedemption.count({ where: { inviteCodeId: code.id } }), 1);
  assert.equal((await profileOfUser(accepted.userId)).studentId, "001234", "重放不改写档案");
  assert.equal(await getDb().passwordCredential.count({ where: { userId: accepted.userId } }), 1);

  // 3) 发放重试：不重复计数、不重新发密码、不覆盖已有凭据。
  const s3 = serial();
  const receipt = await joinApplicationService.submit(
    {
      recruitmentCycle: `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`,
      realName: `${NAME_PREFIX}重试`,
      qq: `8${s3}`.slice(0, 11),
      phone: `139${s3}`.slice(0, 11),
      email: "applicant@example.com",
      studentId: "001234-retry",
      className: "计算机 233",
      privacyConsent: true,
    },
    { requestId: "req_i147_f07_retry_submit" },
  );
  await reviewPassed(receipt.id, "i147-f07-retry-a");
  const provision = await getDb().accountProvision.findUniqueOrThrow({
    where: { sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: receipt.id } },
  });
  const credentialBefore = await getDb().passwordCredential.findUniqueOrThrow({
    where: { userId: provision.userId! },
  });

  const again = await joinApplicationService.provision(receipt.id, ADMIN_ACTOR);
  assert.equal(again.status, "SUCCEEDED");
  assert.equal(again.attemptCount, 1, "已成功的发放任务不重复计数");
  assert.equal(
    (again as { initializationSecret?: string }).initializationSecret,
    undefined,
    "已成功的发放任务不重新发密码",
  );
  const credentialAfter = await getDb().passwordCredential.findUniqueOrThrow({
    where: { userId: provision.userId! },
  });
  assert.deepEqual(
    Buffer.from(credentialAfter.passwordHash),
    Buffer.from(credentialBefore.passwordHash),
    "已有凭据不得被覆盖",
  );
  assert.equal(await getDb().memberProfile.count({ where: { userId: provision.userId! } }), 1);

  // 已通过的报名再次登记「通过」：状态不回流、不重复建发放任务。
  const replayReview = await reviewPassed(receipt.id, "i147-f07-retry-b");
  assert.equal(replayReview.provisionStatus, "SUCCEEDED");
  assert.equal(
    await getDb().accountProvision.count({
      where: { sourceType: "JOIN_APPLICATION", sourceId: receipt.id },
    }),
    1,
  );
});

/* ------------------------------------------------------ F08 导出细节 */

dbTest("F08 导出：学号文本单元格、历史空单元格、公式前缀防护、筛选范围、权限与审计", async () => {
  const s1 = serial();
  const target = await joinApplicationService.submit(
    {
      recruitmentCycle: `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`,
      realName: `${NAME_PREFIX}导出甲`,
      qq: `8${s1}`.slice(0, 11),
      phone: `139${s1}`.slice(0, 11),
      email: "applicant@example.com",
      studentId: "001234",
      className: "=1+1",
      privacyConsent: true,
    },
    { requestId: "req_i147_f08_target" },
  );
  const s2 = serial();
  const other = await joinApplicationService.submit(
    {
      recruitmentCycle: `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`,
      realName: `${NAME_PREFIX}导出乙`,
      qq: `8${s2}`.slice(0, 11),
      phone: `139${s2}`.slice(0, 11),
      email: "applicant@example.com",
      studentId: "777777",
      className: "计算机 999",
      privacyConsent: true,
    },
    { requestId: "req_i147_f08_other" },
  );
  const historical = await createHistoricalApplication({
    realName: `${NAME_PREFIX}导出历史`,
    qq: "801479999",
    phone: "13914799999",
  });

  const auditsBefore = await getDb().auditLog.count({
    where: { action: "join.applications.exported" },
  });

  // 筛选范围：`query` 与列表同源，只导出命中行。
  const csv = await joinApplicationExportService.export(
    { query: target.ticketNo },
    "CSV",
    ADMIN_ACTOR,
  );
  assert.equal(csv.rowCount, 1);
  const rows = csvLines(csv.body);
  assert.equal(rows.length, 2, "表头 + 1 行数据");
  const targetRow = rows[1]!;
  assert.ok(targetRow.includes(target.ticketNo));
  assert.ok(!targetRow.includes(other.ticketNo), "筛选范围外的行不得导出");
  assert.ok(targetRow.includes("001234"), "CSV 学号保留前导零");
  assert.ok(targetRow.includes("'=1+1"), "自由文本班级经过公式注入防护");

  // XLSX：学号是文本单元格（值、类型、numFmt 都对）。
  const xlsx = await joinApplicationExportService.export(
    { query: target.ticketNo },
    "XLSX",
    ADMIN_ACTOR,
  );
  const workbook = await loadWorkbook(xlsx.body);
  const sheet = workbook.getWorksheet("报名记录");
  assert.ok(sheet);
  const studentColumn = columnIndex(sheet.getRow(1), "学号");
  const studentCell = sheet.getRow(2).getCell(studentColumn);
  assert.equal(studentCell.value, "001234");
  assert.equal(typeof studentCell.value, "string");
  assert.equal(studentCell.numFmt, "@", "学号列应按文本格式写入");

  // 历史空值：空单元格，而不是字面量 "null" / "undefined"。
  const historyXlsx = await joinApplicationExportService.export(
    { query: historical.ticketNo },
    "XLSX",
    ADMIN_ACTOR,
  );
  const historySheet = (await loadWorkbook(historyXlsx.body)).getWorksheet("报名记录");
  assert.ok(historySheet);
  const historyCell = historySheet.getRow(2).getCell(columnIndex(historySheet.getRow(1), "学号"));
  assert.ok(
    historyCell.value == null || historyCell.value === "",
    `历史空学号应为空单元格，实际 ${JSON.stringify(historyCell.value)}`,
  );

  // 权限：无 data:export 的成员不能导出。
  await assert.rejects(
    () => joinApplicationExportService.export({}, "CSV", MEMBER_ACTOR),
    (error) => error instanceof AppError && error.code === "FORBIDDEN",
  );

  // 审计：3 次成功导出各留一条，被拒的那次不留痕。
  const auditsAfter = await getDb().auditLog.count({
    where: { action: "join.applications.exported" },
  });
  assert.equal(auditsAfter - auditsBefore, 3);
});

/* ------------------------------------------------ 姓名（只 trim，2–64） */

dbTest("返修：姓名 trim 后 1 / 2 / 21 / 64 / 65 字符与内部空格，两入口规则一致", async () => {
  const NAME_MESSAGE = "姓名长度应为 2–64 个字符";
  const rejectCases = [
    { label: "1 字符", name: "张" },
    { label: "65 字符", name: "张".repeat(65) },
  ];
  const acceptCases = [
    { label: "2 字符", name: "I1" },
    { label: "21 字符（旧上限 20 之外）", name: `I147 ${"张".repeat(16)}` },
    { label: "64 字符", name: `I147 ${"张".repeat(59)}` },
  ];
  const spacedInput = "  I147 张 三  ";
  const spacedStored = "I147 张 三";
  let ip = 0;

  // —— 公开招募入口 ——
  const joinCountBefore = await countMyApplications();
  for (const item of rejectCases) {
    ip += 1;
    const result = await postJson(
      joinApplicationRoute,
      JOIN_PATH,
      joinBody({ realName: item.name }),
      `10.147.4.${ip}`,
    );
    assert.equal(result.status, 400, `招募：${item.label} 应 400`);
    const error = errorOf(result.body);
    assert.equal(error.code, "VALIDATION_FAILED", `招募：${item.label} 错误码`);
    assert.equal(
      error.fieldErrors?.realName?.[0],
      NAME_MESSAGE,
      `招募：${item.label} 字段错误文案`,
    );
  }
  assert.equal(await countMyApplications(), joinCountBefore, "招募：非法姓名不得创建报名");

  for (const item of acceptCases) {
    ip += 1;
    const result = await postJson(
      joinApplicationRoute,
      JOIN_PATH,
      joinBody({ realName: item.name }),
      `10.147.4.${ip}`,
    );
    assert.equal(result.status, 201, `招募：${item.label} 应 201：${JSON.stringify(result.body)}`);
    const { ticketNo } = result.body.data as { ticketNo: string };
    const row = await getDb().joinApplication.findUniqueOrThrow({ where: { ticketNo } });
    assert.equal(row.realName, item.name, `招募：${item.label} 落库姓名`);
  }

  ip += 1;
  const spacedJoin = await postJson(
    joinApplicationRoute,
    JOIN_PATH,
    joinBody({ realName: spacedInput }),
    `10.147.4.${ip}`,
  );
  assert.equal(
    spacedJoin.status,
    201,
    `招募：含内部空格应 201：${JSON.stringify(spacedJoin.body)}`,
  );
  const spacedRow = await getDb().joinApplication.findUniqueOrThrow({
    where: { ticketNo: (spacedJoin.body.data as { ticketNo: string }).ticketNo },
  });
  assert.equal(spacedRow.realName, spacedStored, "招募：只去首尾空白，内部空格保留");

  // —— 邀请码注册入口（同一批用例，断言与招募逐项一致）——
  const code = await createInviteCode(acceptCases.length + 2);
  const codeInput = (realName: string) => ({
    code: code.plainCode,
    idempotencyKey: randomUUID(),
    realName,
    qq: `7${serial()}`.slice(0, 11),
    phone: `138${serial()}`.slice(0, 11),
    studentId: "001234",
    className: "计算机 233",
    password: "I147-Password",
    passwordConfirmation: "I147-Password",
  });

  const usersBefore = await getDb().user.count();
  for (const item of rejectCases) {
    ip += 1;
    const result = await postJson(
      inviteRegistrationRoute,
      INVITE_PATH,
      codeInput(item.name),
      `10.147.4.${ip}`,
    );
    assert.equal(result.status, 400, `注册：${item.label} 应 400`);
    const error = errorOf(result.body);
    assert.equal(error.code, "VALIDATION_FAILED", `注册：${item.label} 错误码`);
    assert.equal(
      error.fieldErrors?.realName?.[0],
      NAME_MESSAGE,
      `注册：${item.label} 字段错误文案`,
    );
  }
  assert.equal(await getDb().user.count(), usersBefore, "注册：非法姓名不得创建用户");
  const untouched = await getDb().inviteCode.findUniqueOrThrow({ where: { id: code.id } });
  assert.equal(untouched.usedCount, 0, "注册：非法姓名不得消耗邀请码次数");

  for (const item of acceptCases) {
    ip += 1;
    const result = await postJson(
      inviteRegistrationRoute,
      INVITE_PATH,
      codeInput(item.name),
      `10.147.4.${ip}`,
    );
    assert.equal(result.status, 201, `注册：${item.label} 应 201：${JSON.stringify(result.body)}`);
    const profile = await profileOfUser((result.body.data as { userId: string }).userId);
    assert.equal(profile.realName, item.name, `注册：${item.label} 建档姓名`);
  }

  ip += 1;
  const spacedInvite = await postJson(
    inviteRegistrationRoute,
    INVITE_PATH,
    codeInput(spacedInput),
    `10.147.4.${ip}`,
  );
  assert.equal(
    spacedInvite.status,
    201,
    `注册：含内部空格应 201：${JSON.stringify(spacedInvite.body)}`,
  );
  const spacedProfile = await profileOfUser((spacedInvite.body.data as { userId: string }).userId);
  assert.equal(spacedProfile.realName, spacedStored, "注册：只去首尾空白，内部空格保留");
});

/* ------------------------------------- 通知邮箱，不是验证身份 */
dbTest("I158 新报名邮箱必填 / 严格类型与格式，规范化持久化；公开回执不披露地址", async () => {
  const beforeCount = await countMyApplications();
  for (const email of [undefined, { address: "person@example.com" }, "bad..local@example.com"]) {
    const rejected = await postJson(
      joinApplicationRoute,
      JOIN_PATH,
      joinBody({ email }),
      "10.158.1.1",
    );
    assert.equal(rejected.status, 400);
    assert.equal(errorOf(rejected.body).code, "VALIDATION_FAILED");
    assert.ok(errorOf(rejected.body).fieldErrors?.email?.length);
  }
  assert.equal(await countMyApplications(), beforeCount);
  const created = await postJson(
    joinApplicationRoute,
    JOIN_PATH,
    joinBody({ email: "  Applicant+notice@Example.COM  " }),
    "10.158.1.2",
  );
  assert.equal(created.status, 201);
  const receipt = created.body.data as { id: string };
  assert.deepEqual(Object.keys(created.body.data as object).sort(), [
    "duplicate",
    "id",
    "status",
    "submittedAt",
    "ticketNo",
  ]);
  const row = await getDb().joinApplication.findUniqueOrThrow({ where: { id: receipt.id } });
  assert.equal(row.email, "applicant+notice@example.com");
  assert.equal(JSON.stringify(created.body).includes("@"), false);
});

dbTest("I158 重复提交不改邮箱，共用邮箱不判重；只在授权审计详情可见，导出保留原列", async () => {
  const body = joinBody({ email: "private-notice@example.com" });
  const first = await postJson(joinApplicationRoute, JOIN_PATH, body, "10.158.2.1");
  const receipt = first.body.data as { id: string; ticketNo: string };
  const duplicate = await postJson(
    joinApplicationRoute,
    JOIN_PATH,
    { ...body, email: "replacement@example.com" },
    "10.158.2.2",
  );
  assert.equal(duplicate.status, 200);
  assert.equal((duplicate.body.data as { id: string }).id, receipt.id);
  assert.equal((duplicate.body.data as { duplicate: boolean }).duplicate, true);
  assert.equal(
    (await getDb().joinApplication.findUniqueOrThrow({ where: { id: receipt.id } })).email,
    body.email,
  );
  const shared = await postJson(
    joinApplicationRoute,
    JOIN_PATH,
    joinBody({ email: body.email }),
    "10.158.2.3",
  );
  assert.equal(shared.status, 201);
  assert.notEqual((shared.body.data as { id: string }).id, receipt.id);

  await assert.rejects(
    () => joinApplicationService.get(receipt.id, MEMBER_ACTOR),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
  const detail = await joinApplicationService.get(receipt.id, ADMIN_ACTOR);
  assert.equal(detail.email, body.email);
  assert.equal(
    await getDb().auditLog.count({
      where: {
        action: "join.application.detail.viewed",
        targetId: receipt.id,
        actorUserId: ADMIN_USER_ID,
      },
    }),
    1,
  );
  const listed = await joinApplicationService.list(
    { page: 1, pageSize: 20, query: receipt.ticketNo },
    ADMIN_ACTOR,
  );
  assert.equal(listed.items.length, 1);
  assert.equal("email" in listed.items[0], false);
  const csv = await joinApplicationExportService.export(
    { query: receipt.ticketNo },
    "CSV",
    ADMIN_ACTOR,
  );
  const xlsx = await joinApplicationExportService.export(
    { query: receipt.ticketNo },
    "XLSX",
    ADMIN_ACTOR,
  );
  const headers = [
    "报名编号",
    "招募批次",
    "姓名",
    "学号",
    "班级",
    "QQ 号",
    "手机号",
    "报名状态",
    "账号发放",
    "意向方向",
    "提交时间",
    "最近面试时间",
    "报名记录 ID",
  ];
  assert.deepEqual(
    csvLines(csv.body)[0]
      .replace(/^\uFEFF/, "")
      .split(","),
    headers,
  );
  assert.equal(Buffer.from(csv.body).toString("utf8").includes(String(body.email)), false);
  const workbook = await loadWorkbook(xlsx.body);
  assert.deepEqual(
    (workbook.getWorksheet("报名记录")!.getRow(1).values as unknown[]).slice(1),
    headers,
  );
  const audits = await getDb().auditLog.findMany({ where: { targetId: receipt.id } });
  assert.equal(JSON.stringify(audits).includes(String(body.email)), false);
  assert.deepEqual(redactAuditSummary({ email: body.email }), { email: "p***@example.com" });
});

dbTest("I158 历史无邮箱详情 / 重复回执与审核建档保持可用，不生成 EMAIL 身份", async () => {
  const old = await createHistoricalApplication({
    realName: `${NAME_PREFIX}历史通知邮箱`,
    qq: "801580001",
    phone: "13901580001",
  });
  assert.equal(old.email, null);
  assert.equal((await joinApplicationService.get(old.id, ADMIN_ACTOR)).email, null);
  // 招募批次仍取服务端配置，不通过公开 body 覆盖；Service 输入仍须有效。
  const duplicate = await joinApplicationService.submit(
    {
      recruitmentCycle: old.recruitmentCycle,
      realName: old.realName,
      qq: old.qqNormalized,
      phone: old.phoneNormalized,
      studentId: "001234",
      className: "计算机 233",
      email: "not-backfilled@example.com",
      privacyConsent: true,
    },
    { requestId: "req_i158_historical" },
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ticketNo, old.ticketNo);
  assert.equal(
    (await getDb().joinApplication.findUniqueOrThrow({ where: { id: old.id } })).email,
    null,
  );
  assert.equal((await reviewPassed(old.id, "i158-history")).provisionStatus, "SUCCEEDED");
  const provision = await getDb().accountProvision.findUniqueOrThrow({
    where: { sourceType_sourceId: { sourceType: "JOIN_APPLICATION", sourceId: old.id } },
  });
  assert.equal(
    await getDb().userIdentity.count({ where: { userId: provision.userId!, type: "EMAIL" } }),
    0,
  );
});

/* ------------------- N158：复用上述报名 / 建档夹具，Fake Sender + 可控时钟 */
const notificationMail: Extract<MailConfig, { enabled: true }> = {
  enabled: true,
  smtpHost: "unused.test",
  smtpPort: 465,
  smtpUser: "fake",
  smtpPassword: "fake",
  mailFrom: "fake@example.com",
  dailyBudget: 150,
  codePepper: "fake-pepper",
};
async function notificationFixture(
  overrides: { qq?: string; phone?: string; email?: string } = {},
) {
  const body = joinBody(overrides) as unknown as Parameters<
    typeof joinApplicationService.submit
  >[0];
  const receipt = await joinApplicationService.submit(
    {
      ...body,
      studentId: `N158-${body.qq}`,
      recruitmentCycle: `${CYCLE_PREFIX}${randomUUID().slice(0, 8)}`,
    },
    { requestId: "req_n158" },
  );
  if (overrides.phone) {
    // 旧版本复用已有账号的历史已通过任务，仍须覆盖无密码通知模板。
    await provisionHistoricalPass(receipt.id, "n158");
  } else {
    await reviewPassed(receipt.id, "n158");
  }
  return getDb().accountNotification.findFirstOrThrow({ where: { applicationId: receipt.id } });
}
async function clearNotificationBudget() {
  await getDb().emailSecurityCounter.deleteMany({
    where: {
      bucketKeyDigest: {
        in: [emailBucketKeys.budgetDay(), emailBucketKeys.budgetMinute()].map(digestEmailBucketKey),
      },
    },
  });
}
function notificationWorker(
  outcome: EmailDeliveryOutcome = { status: "ACCEPTED", messageId: "<fake@test>" },
) {
  let at = new Date("2027-01-10T02:00:00Z");
  const messages: EmailMessage[] = [];
  const service = new AccountNotificationService({
    now: () => at,
    mailConfig: () => notificationMail,
    sender: {
      async send(message) {
        messages.push(message);
        return outcome;
      },
    },
  });
  return {
    service,
    messages,
    setTime(value: Date) {
      at = value;
    },
  };
}

dbTest("N158 入队与建档幂等；失败不入队；历史无邮箱 / 已成功任务不补发", async () => {
  const row = await notificationFixture();
  const provision = await getDb().accountProvision.findUniqueOrThrow({
    where: { id: row.provisionId },
  });
  await Promise.all([
    reviewPassed(row.applicationId, "n158"),
    accountProvisionService.provisionFromApplication(row.applicationId, provision.idempotencyKey),
  ]);
  assert.equal(
    await getDb().accountNotification.count({ where: { provisionId: row.provisionId } }),
    1,
  );
  assert.equal(provision.status, "SUCCEEDED");
  assert.equal(row.credentialCreated, true);
  // 模拟旧版本已经成功建档但没有通知；幂等重入不得补历史队列。
  await getDb().auditLog.deleteMany({ where: { targetId: row.id } });
  await getDb().accountNotification.delete({ where: { id: row.id } });
  await accountProvisionService.provisionFromApplication(
    row.applicationId,
    provision.idempotencyKey,
  );
  assert.equal(
    await getDb().accountNotification.count({ where: { provisionId: row.provisionId } }),
    0,
  );
  const historical = await createHistoricalApplication({
    realName: `${NAME_PREFIX}无邮箱通知`,
    qq: "81580001",
    phone: "13915800001",
  });
  await reviewPassed(historical.id, "n158-old");
  assert.equal((await joinApplicationService.get(historical.id, ADMIN_ACTOR)).notification, null);
  const rejected = await createHistoricalApplication({
    realName: `${NAME_PREFIX}未通过`,
    qq: "81580002",
    phone: "13915800002",
  });
  await assert.rejects(
    accountProvisionService.provisionFromApplication(rejected.id, "n158-rejected"),
  );
  assert.equal(
    await getDb().accountNotification.count({ where: { applicationId: rejected.id } }),
    0,
  );
  const concurrent = await createHistoricalApplication({
    realName: `${NAME_PREFIX}并发入队`,
    qq: "81580003",
    phone: "13915800003",
  });
  await getDb().joinApplication.update({
    where: { id: concurrent.id },
    data: {
      status: "INTERVIEW_PASSED",
      provisionStatus: "PENDING",
      email: "concurrent@example.com",
    },
  });
  await Promise.all(
    [1, 2].map(() =>
      accountProvisionService.provisionFromApplication(concurrent.id, "n158-concurrent"),
    ),
  );
  assert.equal(
    await getDb().accountNotification.count({ where: { applicationId: concurrent.id } }),
    1,
  );
  // 唯一键插入失败必须回滚同事务中的档案更新，而非留下半成功建档。
  const job = await getDb().accountNotification.findFirstOrThrow({
    where: { applicationId: concurrent.id },
  });
  const profile = await getDb().memberProfile.findUniqueOrThrow({ where: { userId: job.userId } });
  await getDb().accountProvision.update({
    where: { id: job.provisionId },
    data: { status: "PENDING" },
  });
  await getDb().joinApplication.update({
    where: { id: concurrent.id },
    data: { realName: `${NAME_PREFIX}必须回滚`, provisionStatus: "PENDING" },
  });
  await assert.rejects(
    accountProvisionService.provisionFromApplication(concurrent.id, "n158-concurrent"),
  );
  assert.equal(
    (await getDb().memberProfile.findUniqueOrThrow({ where: { id: profile.id } })).realName,
    profile.realName,
  );
  assert.equal(
    await getDb().accountNotification.count({ where: { applicationId: concurrent.id } }),
    1,
  );
});

dbTest(
  "N158 暂时拒绝一轮 4 次与 1/5/30 分钟；人工新轮保留累计及审计；SMTP 不污染建档",
  async () => {
    await clearNotificationBudget();
    const row = await notificationFixture();
    const worker = notificationWorker({ status: "FAILED", retryable: true });
    for (let i = 1; i <= 4; i++) {
      await worker.service.runBatch({ limit: 1 });
      const current = await getDb().accountNotification.findUniqueOrThrow({
        where: { id: row.id },
      });
      assert.equal(current.attemptCount, i);
      assert.equal(current.roundAttemptCount, i);
      assert.equal(current.status, i < 4 ? "PENDING" : "FAILED");
      if (i < 4) {
        assert.equal(
          current.nextAttemptAt.getTime() - current.lastAttemptAt!.getTime(),
          [60000, 300000, 1800000][i - 1],
        );
        worker.setTime(current.nextAttemptAt);
      }
    }
    const retry = await worker.service.retry(row.applicationId, ADMIN_ACTOR);
    assert.equal(retry.attemptCount, 4);
    assert.equal(retry.roundAttemptCount, 0);
    await worker.service.retry(row.applicationId, ADMIN_ACTOR);
    assert.equal(
      await getDb().auditLog.count({
        where: {
          targetId: row.id,
          action: "account.notification.retry_requested",
          actorUserId: ADMIN_USER_ID,
        },
      }),
      1,
    );
    await worker.service.runBatch({ limit: 1 });
    assert.equal(worker.messages.length, 5);
    assert.equal(
      (await getDb().accountProvision.findUniqueOrThrow({ where: { id: row.provisionId } })).status,
      "SUCCEEDED",
    );
    assert.equal(
      (await getDb().joinApplication.findUniqueOrThrow({ where: { id: row.applicationId } }))
        .provisionStatus,
      "SUCCEEDED",
    );
  },
);

dbTest("N158 凭据发送前复核：5 位 QQ 初始口令；已改密和已有凭据用无密码模板", async () => {
  await clearNotificationBudget();
  await notificationFixture({ qq: "81583" });
  const worker = notificationWorker();
  await worker.service.runBatch({ limit: 1 });
  assert.match(worker.messages[0].text, /初始密码：81583/);
  assert.match(worker.messages[0].text, /https:\/\/pczafu.cn\/login/);
  const changed = await notificationFixture();
  const currentHash = await hashPassword("changed-password");
  await getDb().passwordCredential.update({
    where: { userId: changed.userId },
    data: {
      passwordHash: currentHash,
      mustChangePassword: false,
      credentialVersion: { increment: 1 },
    },
  });
  await worker.service.runBatch({ limit: 1 });
  assert.doesNotMatch(worker.messages[1].text, /初始密码：/);
  // 同一个已有 QQ / 电话的新批次报名，建档不能覆盖已有密码。
  const app = await getDb().joinApplication.findUniqueOrThrow({
    where: { id: changed.applicationId },
  });
  const existing = await notificationFixture({
    qq: app.qqNormalized,
    ...{ phone: app.phoneNormalized },
  });
  assert.equal(existing.credentialCreated, false);
  await worker.service.runBatch({ limit: 1 });
  assert.doesNotMatch(worker.messages[2].text, /初始密码：/);
  assert.equal(
    (await getDb().passwordCredential.findUniqueOrThrow({ where: { userId: changed.userId } }))
      .passwordHash,
    currentHash,
  );
});

dbTest("N158 双 worker 仅调用一次；重建领取持久任务；过期领取和迟到结果保持未知", async () => {
  await clearNotificationBudget();
  const row = await notificationFixture();
  let start!: () => void, release!: (outcome: EmailDeliveryOutcome) => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let calls = 0;
  const at = new Date("2027-01-11T02:00:00Z");
  const service = new AccountNotificationService({
    now: () => at,
    mailConfig: () => notificationMail,
    sender: {
      send() {
        calls++;
        start();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const running = service.runBatch({ limit: 1 });
  await started;
  const second = notificationWorker();
  second.setTime(at);
  assert.equal((await second.service.runBatch({ limit: 1 })).claimed, 0);
  // 用持久化领取到期模拟发送后进程中断；不需要杀进程矩阵。
  const later = new Date(at.getTime() + 120001);
  second.setTime(later);
  assert.equal((await second.service.runBatch({ limit: 1 })).uncertain, 1);
  release({ status: "ACCEPTED" });
  await running;
  assert.equal(calls, 1);
  assert.equal(
    (await getDb().accountNotification.findUniqueOrThrow({ where: { id: row.id } })).status,
    "UNCERTAIN",
  );
  await assert.rejects(
    second.service.retry(row.applicationId, ADMIN_ACTOR),
    (error: unknown) => error instanceof AppError && error.code === "STATE_TRANSITION_INVALID",
  );
  assert.equal((await second.service.runBatch({ limit: 1 })).claimed, 0);
});

dbTest("N158 邮件关闭零尝试；通知与验证码竞争同一预算，耗尽延后不占用户桶", async () => {
  await clearNotificationBudget();
  const row = await notificationFixture();
  const disabled = new AccountNotificationService({ mailConfig: () => ({ enabled: false }) });
  assert.equal((await disabled.runBatch()).disabled, true);
  assert.equal(
    (await getDb().accountNotification.findUniqueOrThrow({ where: { id: row.id } })).attemptCount,
    0,
  );
  const worker = notificationWorker();
  const at = new Date("2027-01-10T02:00:00Z");
  const shared = new AccountNotificationService({
    now: () => at,
    mailConfig: () => ({ ...notificationMail, dailyBudget: 1 }),
    sender: {
      async send(message) {
        worker.messages.push(message);
        return { status: "ACCEPTED" };
      },
    },
  });
  const quotaInput = {
    userId: row.userId,
    emailNormalized: row.recipientEmail,
    ipAddress: "10.158.0.1",
    now: () => at,
    dailyBudget: 1,
  };
  const outcomes = await Promise.allSettled([
    shared.runBatch({ limit: 1 }),
    inSerializableTransaction((tx) => preoccupyEmailSendQuota(tx, quotaInput)),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  const day = await getDb().emailSecurityCounter.findUniqueOrThrow({
    where: { bucketKeyDigest: digestEmailBucketKey(emailBucketKeys.budgetDay()) },
  });
  assert.equal(day.counter, 1);
  const current = await getDb().accountNotification.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(worker.messages.length + (outcomes[1].status === "fulfilled" ? 1 : 0), 1);
  if (!worker.messages.length) {
    assert.equal(current.status, "PENDING");
    assert.equal(current.attemptCount, 0);
    assert.equal(current.nextAttemptAt.getTime(), day.windowExpiresAt.getTime());
    assert.equal(current.lastErrorCode, "BUDGET_DEFERRED");
  } else {
    assert.equal(
      await getDb().emailSecurityCounter.count({
        where: {
          bucketKeyDigest: digestEmailBucketKey(emailBucketKeys.sendCooldownUser(row.userId)),
        },
      }),
      0,
    );
  }
  const deferred = current.status === "PENDING" ? current : await notificationFixture();
  await shared.runBatch({ limit: 1 });
  const waiting = await getDb().accountNotification.findUniqueOrThrow({
    where: { id: deferred.id },
  });
  assert.equal(waiting.status, "PENDING");
  assert.equal(waiting.attemptCount, 0);
  assert.equal(waiting.lastErrorCode, "BUDGET_DEFERRED");
  assert.equal(waiting.nextAttemptAt.getTime(), day.windowExpiresAt.getTime());
  const keys = [
    emailBucketKeys.sendCooldownUser(row.userId),
    emailBucketKeys.sendCooldownEmail(row.recipientEmail),
    emailBucketKeys.sendDailyUser(row.userId),
    emailBucketKeys.sendDailyEmail(row.recipientEmail),
    emailBucketKeys.sendDailyIp("10.158.0.1"),
  ];
  await getDb().emailSecurityCounter.deleteMany({
    where: { bucketKeyDigest: { in: keys.map(digestEmailBucketKey) } },
  });
});

dbTest("N158 详情 / 重试权限与 HTTP 披露边界；永久拒绝停止，未知无强制补发", async () => {
  await clearNotificationBudget();
  const row = await notificationFixture();
  const worker = notificationWorker({ status: "FAILED" });
  await worker.service.runBatch({ limit: 1 });
  assert.equal((await worker.service.runBatch({ limit: 1 })).claimed, 0);
  const detail = await joinApplicationService.get(row.applicationId, ADMIN_ACTOR);
  assert.equal(detail.notification?.status, "FAILED");
  assert.equal(detail.notification?.canRetry, true);
  await assert.rejects(worker.service.get(row.applicationId, MEMBER_ACTOR));
  await assert.rejects(worker.service.retry(row.applicationId, MEMBER_ACTOR));
  const cookie = await sessionCookie(ADMIN_USER_ID);
  const route = (origin: string) =>
    retryNotificationRoute(
      new Request(
        `http://localhost/api/v1/admin/join-applications/${row.applicationId}/notification/retry`,
        { method: "POST", headers: { origin, cookie } },
      ),
      { params: Promise.resolve({ id: row.applicationId }) },
    );
  const denied = await route("https://untrusted.test");
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("cache-control")!, /private.*no-store/);
  const response = await route(sameOriginHeaders().origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /private.*no-store/);
  const json = JSON.stringify(await response.json());
  assert.doesNotMatch(
    json,
    /recipientEmail|qqNormalized|credential|password|claimId|applicant@example.com/,
  );
  const audits = await getDb().auditLog.findMany({ where: { targetId: row.id } });
  assert.doesNotMatch(JSON.stringify(audits), /applicant@example.com|初始密码|passwordHash/);
  const uncertain = notificationWorker({ status: "UNCERTAIN" });
  await uncertain.service.runBatch({ limit: 1 });
  assert.equal((await uncertain.service.runBatch({ limit: 1 })).claimed, 0);
  await assert.rejects(uncertain.service.retry(row.applicationId, ADMIN_ACTOR));
  assert.equal(
    (await getDb().accountProvision.findUniqueOrThrow({ where: { id: row.provisionId } })).status,
    "SUCCEEDED",
  );
});
