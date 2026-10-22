import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import ExcelJS from "exceljs";

import { GET as listRoute } from "../../src/app/api/v1/admin/join-applications/route";
import { DELETE as deleteRoute } from "../../src/app/api/v1/admin/join-applications/[id]/route";
import { POST as reviewRoute } from "../../src/app/api/v1/admin/join-applications/[id]/reviews/route";
import { PATCH as emailRoute } from "../../src/app/api/v1/admin/join-applications/[id]/notification/email/route";
import { GET as exportRoute } from "../../src/app/api/v1/admin/join-applications/export/route";
import { accountProvisionService } from "../../src/features/accounts/account-provision-service";
import { joinApplicationExportService } from "../../src/features/admin/join-application-export-service";
import { AccountNotificationService } from "../../src/features/email/account-notification-service";
import { memberService } from "../../src/features/members/member-service";
import { joinApplicationService } from "../../src/features/recruitment/join-application-service";
import { AppError } from "../../src/lib/api/errors";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import type { AuthorizedActor, SubmitJoinApplicationInput } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";
import { callRoute, sessionCookie } from "./http-harness";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;
const adminId = "e1760000-0000-4000-8000-000000000001";
const prefix = "I176 ";
const actor: AuthorizedActor = {
  userId: adminId,
  actorType: "USER",
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_i176",
};
const reader: AuthorizedActor = { ...actor, permissions: ["join:read"] };
let sequence = 0;
let cookie = "";

function identity() {
  const n = String(++sequence).padStart(8, "0");
  return { qq: `976${n}`, phone: `136${n}` };
}

async function cleanup() {
  const db = getDb();
  const users = await db.user.findMany({
    where: { OR: [{ displayName: { startsWith: prefix } }, { id: adminId }] },
    select: { id: true },
  });
  const userIds = users.map((row) => row.id);
  const applications = await db.joinApplication.findMany({
    where: { recruitmentCycle: { startsWith: "I176-" } },
    select: { id: true },
  });
  const ids = applications.map((row) => row.id);
  const provisions = await db.accountProvision.findMany({
    where: { OR: [{ sourceId: { in: ids } }, { userId: { in: userIds } }] },
    select: { id: true },
  });
  const notifications = await db.accountNotification.findMany({
    where: { applicationId: { in: ids } },
    select: { id: true },
  });
  const profiles = await db.memberProfile.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: userIds } },
        {
          targetId: {
            in: [
              ...ids,
              ...provisions.map((r) => r.id),
              ...notifications.map((r) => r.id),
              ...profiles.map((r) => r.id),
            ],
          },
        },
      ],
    },
  });
  await db.accountNotification.deleteMany({ where: { applicationId: { in: ids } } });
  await db.accountProvision.deleteMany({ where: { id: { in: provisions.map((r) => r.id) } } });
  await db.joinApplicationReview.deleteMany({ where: { applicationId: { in: ids } } });
  await db.joinApplication.deleteMany({ where: { id: { in: ids } } });
  await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: userIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.userIdentity.deleteMany({ where: { userId: { in: userIds } } });
  await db.memberProfile.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeEach(async () => {
  if (!enabled) return;
  await cleanup();
  const now = new Date();
  await getDb().user.create({
    data: {
      id: adminId,
      displayName: `${prefix}管理员`,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    },
  });
  cookie = await sessionCookie(adminId);
});
after(async () => {
  if (!enabled) return;
  try {
    await cleanup();
  } finally {
    await disconnectDb();
  }
});

async function application(overrides: Partial<SubmitJoinApplicationInput> = {}) {
  const contact = identity();
  return joinApplicationService.submit(
    {
      ...contact,
      recruitmentCycle: "I176-current",
      realName: `${prefix}报名${sequence}`,
      studentId: `00176-${sequence}`,
      className: "计科176",
      email: `i176-${sequence}@example.com`,
      privacyConsent: true,
      ...overrides,
    },
    { requestId: "req_i176_submit" },
  );
}

async function member() {
  const contact = identity();
  const result = await memberService.create(
    {
      ...contact,
      realName: `${prefix}成员${sequence}`,
      studentId: `00176-${sequence}`,
      idempotencyKey: randomUUID(),
    },
    actor,
  );
  const now = new Date();
  const email = `member-${sequence}@example.com`;
  await getDb().userIdentity.create({
    data: {
      id: randomUUID(),
      userId: result.member.userId,
      type: "EMAIL",
      identifierNormalized: email,
      activeEmailKey: `email:${result.member.userId}`,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  return { ...result.member, ...contact, email, studentId: `00176-${sequence}` };
}

function reviewInput(id: string) {
  return {
    applicationId: id,
    result: "PASSED" as const,
    admittedDepartment: "OFFICE" as const,
    interviewedAt: new Date().toISOString(),
    idempotencyKey: `i176:${id}`,
  };
}
function code(expected: string) {
  return (error: unknown) => error instanceof AppError && error.code === expected;
}
async function untouched(id: string) {
  const row = await getDb().joinApplication.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, "SUBMITTED");
  assert.equal(row.provisionStatus, "NOT_REQUIRED");
  assert.equal(row.admittedDepartment, null);
  assert.equal(row.lastReviewedAt, null);
  assert.equal(await getDb().joinApplicationReview.count({ where: { applicationId: id } }), 0);
  assert.equal(await getDb().accountProvision.count({ where: { sourceId: id } }), 0);
  assert.equal(await getDb().accountNotification.count({ where: { applicationId: id } }), 0);
  assert.equal(
    await getDb().auditLog.count({ where: { targetId: id, action: "join.review.created" } }),
    0,
  );
}

dbTest("批次与组合筛选：历史批次、列表 / CSV / XLSX 同源，空结果和超长值", async () => {
  const historical = await application({ recruitmentCycle: "I176-history" });
  await application();
  const deleted = await application({ recruitmentCycle: "I176-history" });
  await joinApplicationService.softDelete(deleted.id, actor);
  const filters = {
    recruitmentCycle: " I176-history ",
    query: prefix,
    status: "SUBMITTED" as const,
    provisionStatus: "NOT_REQUIRED" as const,
  };
  const listed = await joinApplicationService.list({ ...filters, page: 1, pageSize: 100 }, actor);
  assert.deepEqual(
    listed.items.map((row) => row.id),
    [historical.id],
  );
  const params = new URLSearchParams(filters);
  const http = await callRoute(
    listRoute,
    `http://localhost/api/v1/admin/join-applications?${params}`,
    { headers: { cookie } },
  );
  assert.equal(http.status, 200);
  assert.deepEqual(
    (http.json.data as { id: string }[]).map((r) => r.id),
    [historical.id],
  );
  for (const format of ["CSV", "XLSX"] as const) {
    const result = await joinApplicationExportService.export(filters, format, actor);
    assert.equal(result.rowCount, 1);
    if (format === "CSV") {
      const csv = Buffer.from(result.body).toString("utf8");
      assert.ok(csv.includes(historical.ticketNo));
      assert.ok(!csv.includes(deleted.ticketNo));
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const sheet = workbook.getWorksheet("报名记录")!;
      assert.equal(sheet.rowCount, 2);
      assert.equal(sheet.getRow(2).getCell(1).value, historical.ticketNo);
    }
    const response = await exportRoute(
      new Request(
        `http://localhost/api/v1/admin/join-applications/export?${params}&format=${format}`,
        { headers: { cookie } },
      ),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Export-Row-Count"), "1");
  }
  assert.equal(
    (
      await joinApplicationService.list(
        { page: 1, pageSize: 20, recruitmentCycle: "I176-none" },
        actor,
      )
    ).items.length,
    0,
  );
  assert.equal(
    (await joinApplicationExportService.export({ recruitmentCycle: "I176-none" }, "CSV", actor))
      .rowCount,
    0,
  );
  for (const handler of [listRoute, exportRoute]) {
    const response = await handler(
      new Request(
        `http://localhost/api/v1/admin/join-applications?recruitmentCycle=${"x".repeat(33)}`,
        { headers: { cookie } },
      ),
    );
    assert.equal(response.status, 400);
  }
});

dbTest("软删除有权限 / 同源 / 审计，全部状态可删且不撤销已创建的成员", async () => {
  const passed = await application();
  await joinApplicationService.review(reviewInput(passed.id), actor);
  const provision = await getDb().accountProvision.findFirstOrThrow({
    where: { sourceId: passed.id },
  });
  const path = `http://localhost/api/v1/admin/join-applications/${passed.id}`;
  await assert.rejects(joinApplicationService.softDelete(passed.id, reader), code("FORBIDDEN"));
  const crossOrigin = await deleteRoute(
    new Request(path, { method: "DELETE", headers: { cookie, origin: "https://other.invalid" } }),
    { params: Promise.resolve({ id: passed.id }) },
  );
  assert.equal(crossOrigin.status, 403);
  const response = await callRoute(deleteRoute, path, {
    method: "DELETE",
    headers: { cookie },
    params: { id: passed.id },
  });
  assert.equal(response.status, 200);
  const profile = await getDb().memberProfile.findUniqueOrThrow({
    where: { id: provision.memberProfileId! },
  });
  assert.equal(profile.status, "ACTIVE");
  assert.equal(profile.deletedAt, null);
  assert.equal(
    await getDb().joinApplicationReview.count({ where: { applicationId: passed.id } }),
    1,
  );
  assert.equal(await getDb().accountNotification.count({ where: { applicationId: passed.id } }), 1);
  const audit = await getDb().auditLog.findFirstOrThrow({
    where: { targetId: passed.id, action: "join.application.deleted" },
  });
  assert.equal(audit.actorUserId, adminId);
  for (const operation of [
    () => joinApplicationService.get(passed.id, actor),
    () => joinApplicationService.review(reviewInput(passed.id), actor),
    () => joinApplicationService.provision(passed.id, actor),
    () => joinApplicationService.retryProvision(passed.id, actor),
    () => accountProvisionService.provisionFromApplication(passed.id, provision.idempotencyKey),
    () => new AccountNotificationService().retry(passed.id, actor),
    () => joinApplicationService.softDelete(passed.id, actor),
  ])
    await assert.rejects(operation(), code("RESOURCE_NOT_FOUND"));
  assert.equal(await new AccountNotificationService().get(passed.id, actor), null);
  let sent = 0;
  const worker = new AccountNotificationService({
    mailConfig: () => ({
      enabled: true,
      smtpHost: "unused.test",
      smtpPort: 465,
      smtpUser: "fake",
      smtpPassword: "fake",
      mailFrom: "fake@example.com",
      dailyBudget: 150,
      codePepper: "fake-pepper",
    }),
    sender: {
      async send() {
        sent++;
        return { status: "ACCEPTED" };
      },
    },
  });
  await worker.runBatch({ limit: 1 });
  assert.equal(sent, 0, "删除报名的通知不得交给 Sender");
  for (const status of ["SUBMITTED", "INTERVIEW_PENDING", "INTERVIEW_REJECTED", "WITHDRAWN"]) {
    const receipt = await application();
    await getDb().joinApplication.update({ where: { id: receipt.id }, data: { status } });
    await joinApplicationService.softDelete(receipt.id, actor);
  }
  for (const provisionStatus of ["PENDING", "FAILED"]) {
    const receipt = await application();
    await getDb().joinApplication.update({
      where: { id: receipt.id },
      data: { status: "INTERVIEW_PASSED", provisionStatus },
    });
    await joinApplicationService.softDelete(receipt.id, actor);
    await assert.rejects(
      accountProvisionService.provisionFromApplication(receipt.id, `i176:${receipt.id}`),
      code("RESOURCE_NOT_FOUND"),
    );
    assert.equal(
      (await getDb().joinApplication.findUniqueOrThrow({ where: { id: receipt.id } }))
        .provisionStatus,
      provisionStatus,
    );
  }
});

dbTest("删除后同批次 QQ / 手机号继续占用，明确提示且不泄露旧回执；其它批次可提交", async () => {
  const receipt = await application();
  const row = await getDb().joinApplication.findUniqueOrThrow({ where: { id: receipt.id } });
  await joinApplicationService.softDelete(receipt.id, actor);
  for (const duplicate of [{ qq: row.qqNormalized }, { phone: row.phoneNormalized }]) {
    await assert.rejects(application(duplicate), (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "JOIN_APPLICATION_DUPLICATE");
      assert.match(error.message, /联系管理员/);
      assert.ok(!error.message.includes(receipt.ticketNo));
      return true;
    });
  }
  assert.equal(
    (
      await application({
        recruitmentCycle: "I176-next",
        qq: row.qqNormalized,
        phone: row.phoneNormalized,
      })
    ).duplicate,
    false,
  );
});

dbTest("四字段任一重复都拦截首次通过，错误仅指出字段且全部审核 / 发放写入回滚", async () => {
  const existing = await member();
  const labels = { qq: "QQ 号", phone: "手机号", studentId: "学号", email: "邮箱" };
  for (const field of ["qq", "phone", "studentId", "email"] as const) {
    const receipt = await application({
      [field]: field === "email" ? ` ${existing.email.toUpperCase()} ` : existing[field],
    });
    const result = await callRoute(
      reviewRoute,
      `http://localhost/api/v1/admin/join-applications/${receipt.id}/reviews`,
      {
        method: "POST",
        headers: { cookie },
        params: { id: receipt.id },
        body: reviewInput(receipt.id),
      },
    );
    assert.equal(result.status, 409);
    const error = result.json.error as { code: string; message: string };
    assert.equal(error.code, "ACCOUNT_IDENTITY_CONFLICT");
    assert.ok(error.message.includes(labels[field]));
    for (const sensitive of [
      existing.qq,
      existing.phone,
      existing.studentId,
      existing.email,
      existing.id,
    ])
      assert.ok(!error.message.includes(sensitive));
    await untouched(receipt.id);
  }
  const accepted = await application();
  assert.equal(
    (await joinApplicationService.review(reviewInput(accepted.id), actor)).provisionStatus,
    "SUCCEEDED",
  );
  const provision = await getDb().accountProvision.findFirstOrThrow({
    where: { sourceId: accepted.id },
  });
  assert.equal(
    (await getDb().memberProfile.findUniqueOrThrow({ where: { id: provision.memberProfileId! } }))
      .department,
    "OFFICE",
  );
  await joinApplicationService.review(
    { ...reviewInput(accepted.id), admittedDepartment: "REPAIR" },
    actor,
  );
  assert.equal(
    await getDb().accountNotification.count({ where: { applicationId: accepted.id } }),
    1,
  );
});

dbTest("只匹配有效成员与有效身份；历史空值不判重，学号保留前导零", async () => {
  for (const inactive of [
    "disabled",
    "profileRevoked",
    "profileDeleted",
    "roleRevoked",
    "identityDeleted",
  ]) {
    const existing = await member();
    const db = getDb();
    if (inactive === "disabled")
      await db.user.update({ where: { id: existing.userId }, data: { status: "DISABLED" } });
    if (inactive === "profileRevoked")
      await db.memberProfile.update({ where: { id: existing.id }, data: { status: "REVOKED" } });
    if (inactive === "profileDeleted")
      await db.memberProfile.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
    if (inactive === "roleRevoked")
      await db.userRole.updateMany({
        where: { userId: existing.userId },
        data: { revokedAt: new Date(), activeKey: null },
      });
    if (inactive === "identityDeleted")
      await db.userIdentity.updateMany({
        where: { userId: existing.userId, type: "EMAIL" },
        data: { deletedAt: new Date(), activeEmailKey: null },
      });
    const receipt = await application({
      email: existing.email,
      ...(inactive !== "identityDeleted" ? { studentId: existing.studentId } : {}),
    });
    assert.equal(
      (await joinApplicationService.review(reviewInput(receipt.id), actor)).provisionStatus,
      "SUCCEEDED",
    );
  }
  const existing = await member();
  await getDb().memberProfile.update({ where: { id: existing.id }, data: { studentId: "000176" } });
  const different = await application({ studentId: "176" });
  await joinApplicationService.review(reviewInput(different.id), actor);
  for (const blank of [null, "   "]) {
    const old = await application();
    await getDb().joinApplication.update({
      where: { id: old.id },
      data: { studentId: blank, email: blank },
    });
    assert.equal(
      (await joinApplicationService.review(reviewInput(old.id), actor)).provisionStatus,
      "SUCCEEDED",
    );
  }
});

dbTest("并发首次通过相同学号：只录取一人，另一条仍未审核且没有任务 / 通知", async () => {
  const a = await application({ studentId: "00176-race" });
  const b = await application({ studentId: "00176-race" });
  const results = await Promise.allSettled(
    [a, b].map((row) => joinApplicationService.review(reviewInput(row.id), actor)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejectedIndex = results.findIndex((r) => r.status === "rejected");
  const rejected = results[rejectedIndex] as PromiseRejectedResult;
  assert.ok(code("ACCOUNT_IDENTITY_CONFLICT")(rejected.reason), String(rejected.reason));
  await untouched([a, b][rejectedIndex].id);
});

dbTest("首次发放仍保留身份冲突保护；失败不提交审核结论", async () => {
  const existing = await member();
  await getDb().user.update({ where: { id: existing.userId }, data: { status: "DISABLED" } });
  const receipt = await application({ qq: existing.qq, phone: existing.phone });
  await assert.rejects(
    joinApplicationService.review(reviewInput(receipt.id), actor),
    code("ACCOUNT_IDENTITY_CONFLICT"),
  );
  await untouched(receipt.id);
});

dbTest("删除与审核 / 发放并发：删除提交后不能再建档或补记通过", async () => {
  const receipt = await application();
  const results = await Promise.allSettled([
    joinApplicationService.softDelete(receipt.id, actor),
    joinApplicationService.review(reviewInput(receipt.id), actor),
  ]);
  assert.equal(results[0].status, "fulfilled");
  const row = await getDb().joinApplication.findUniqueOrThrow({ where: { id: receipt.id } });
  assert.ok(row.deletedAt);
  const count = await getDb().accountProvision.count({ where: { sourceId: receipt.id } });
  await assert.rejects(
    joinApplicationService.review(reviewInput(receipt.id), actor),
    code("RESOURCE_NOT_FOUND"),
  );
  await assert.rejects(
    accountProvisionService.provisionFromApplication(receipt.id, `i176:${receipt.id}`),
    code("RESOURCE_NOT_FOUND"),
  );
  assert.equal(await getDb().accountProvision.count({ where: { sourceId: receipt.id } }), count);
});

dbTest("通知邮箱更正（issue #161）：按任务状态同步地址，审计脱敏", async () => {
  const pending = await application();
  await joinApplicationService.review(reviewInput(pending.id), actor);
  const task = await getDb().accountNotification.findFirstOrThrow({
    where: { applicationId: pending.id },
  });
  assert.equal(task.status, "PENDING");

  // 待发送：报名记录与任务收件地址一起改；输入按 normalizeEmail 归一。
  const result = await joinApplicationService.correctNotificationEmail(
    pending.id,
    { email: " I176-CORRECTED@Example.com " },
    actor,
  );
  assert.equal(result.email, "i176-corrected@example.com");
  assert.equal(result.notification?.status, "PENDING");
  assert.equal(
    (await getDb().joinApplication.findUniqueOrThrow({ where: { id: pending.id } })).email,
    "i176-corrected@example.com",
  );
  assert.equal(
    (await getDb().accountNotification.findUniqueOrThrow({ where: { id: task.id } }))
      .recipientEmail,
    "i176-corrected@example.com",
  );
  const audit = await getDb().auditLog.findFirstOrThrow({
    where: { targetId: pending.id, action: "join.application.notification_email.updated" },
  });
  const summary = JSON.stringify(audit.afterSummary);
  assert.ok(summary.includes("i***@example.com"), summary);
  assert.ok(!summary.includes("i176-corrected@example.com"), "审计摘要不得写完整邮箱");

  // 同一地址重复保存是幂等空操作，不再写审计。
  await joinApplicationService.correctNotificationEmail(
    pending.id,
    { email: "i176-corrected@example.com" },
    actor,
  );
  assert.equal(
    await getDb().auditLog.count({
      where: { targetId: pending.id, action: "join.application.notification_email.updated" },
    }),
    1,
  );

  // 明确失败：同步地址但保持 FAILED —— 由管理员手动「重试通知」。
  await getDb().accountNotification.update({
    where: { id: task.id },
    data: { status: "FAILED", lastErrorCode: "INVALID_RECIPIENT" },
  });
  const failed = await joinApplicationService.correctNotificationEmail(
    pending.id,
    { email: "i176-failed@example.com" },
    actor,
  );
  assert.equal(failed.notification?.status, "FAILED");
  assert.equal(failed.notification?.canRetry, true);
  assert.equal(
    (await getDb().accountNotification.findUniqueOrThrow({ where: { id: task.id } }))
      .recipientEmail,
    "i176-failed@example.com",
  );

  // 发送中：在途任务无法改地址，拒绝且报名记录 / 任务都不变。
  await getDb().accountNotification.update({ where: { id: task.id }, data: { status: "SENDING" } });
  await assert.rejects(
    joinApplicationService.correctNotificationEmail(
      pending.id,
      { email: "i176-sending@example.com" },
      actor,
    ),
    code("STATE_TRANSITION_INVALID"),
  );
  assert.equal(
    (await getDb().joinApplication.findUniqueOrThrow({ where: { id: pending.id } })).email,
    "i176-failed@example.com",
  );
  assert.equal(
    (await getDb().accountNotification.findUniqueOrThrow({ where: { id: task.id } }))
      .recipientEmail,
    "i176-failed@example.com",
  );

  // 已交发信服务 / 结果未知：只更新报名记录，任务地址与状态保持原样（不重发）。
  for (const status of ["ACCEPTED", "UNCERTAIN"] as const) {
    await getDb().accountNotification.update({ where: { id: task.id }, data: { status } });
    const correctedEmail = `i176-${status.toLowerCase()}@example.com`;
    const next = await joinApplicationService.correctNotificationEmail(
      pending.id,
      { email: correctedEmail },
      actor,
    );
    assert.equal(next.notification?.status, status);
    assert.equal(
      (await getDb().joinApplication.findUniqueOrThrow({ where: { id: pending.id } })).email,
      correctedEmail,
    );
    assert.equal(
      (await getDb().accountNotification.findUniqueOrThrow({ where: { id: task.id } }))
        .recipientEmail,
      "i176-failed@example.com",
      `${status} 的任务不得改地址`,
    );
  }
});

dbTest("通知邮箱更正的边界：HTTP 校验 / 权限 / 无任务 / 删除后", async () => {
  const base = `http://localhost/api/v1/admin/join-applications`;
  const receipt = await application();
  const invalid = await callRoute(emailRoute, `${base}/${receipt.id}/notification/email`, {
    method: "PATCH",
    headers: { cookie },
    params: { id: receipt.id },
    body: { email: "not-an-email" },
  });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.json.error as { code: string }).code, "VALIDATION_FAILED");
  await assert.rejects(
    joinApplicationService.correctNotificationEmail(
      receipt.id,
      { email: "i176-reader@example.com" },
      reader,
    ),
    code("FORBIDDEN"),
  );
  const crossOrigin = await callRoute(emailRoute, `${base}/${receipt.id}/notification/email`, {
    method: "PATCH",
    headers: { cookie, origin: "https://other.invalid" },
    params: { id: receipt.id },
    body: { email: "i176-cross@example.com" },
  });
  assert.equal(crossOrigin.status, 403);
  // 尚未通过 / 建档：没有通知任务，只更新报名记录。
  const saved = await joinApplicationService.correctNotificationEmail(
    receipt.id,
    { email: "i176-notask@example.com" },
    actor,
  );
  assert.equal(saved.notification, null);
  // HTTP happy path：返回归一化后的邮箱。
  const http = await callRoute(emailRoute, `${base}/${receipt.id}/notification/email`, {
    method: "PATCH",
    headers: { cookie },
    params: { id: receipt.id },
    body: { email: "I176-HTTP@Example.com" },
  });
  assert.equal(http.status, 200);
  assert.equal((http.json.data as { email: string }).email, "i176-http@example.com");
  await joinApplicationService.softDelete(receipt.id, actor);
  await assert.rejects(
    joinApplicationService.correctNotificationEmail(
      receipt.id,
      { email: "i176-late@example.com" },
      actor,
    ),
    code("RESOURCE_NOT_FOUND"),
  );
});
