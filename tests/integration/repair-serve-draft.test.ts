import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { memberService } from "../../src/features/members/member-service";
import { shanghaiCalendarDay } from "../../src/features/repair-activities/repair-activity-validation";
import { repairActivityStaffService } from "../../src/features/repair-activities/repair-activity-staff-service";
import { repairAdminService } from "../../src/features/repairs/repair-admin-service";
import { repairQueryService } from "../../src/features/repairs/repair-query-service";
import { repairReviewService } from "../../src/features/repairs/repair-review-service";
import { repairService } from "../../src/features/repairs/repair-service";
import { AppError, type ApiErrorCode } from "../../src/lib/api/errors";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import type { AuthorizedActor } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";

/* 集成测试的统一闸门：指向非测试库时**在加载阶段就抛错**（`db-guard.ts` 里写了两次
   实际事故）。未开启时返回 false，各文件照常走 test.skip。 */
const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

/**
 * 「接待落草稿 + 机主字段 + 全局拦截」的集成测试（issue #79 第 6 项，真实 GreatSQL）。
 *
 * 覆盖任务书 §6.2：迁移后两列可写可读、旧记录为 NULL 且 content 保留；
 * serve → DRAFT（预填）→ 提交（不带照片）→ 审核通过；期间拦截生效；
 * 管理端 PATCH 修改其它字段时 ownerPhone 不被清空；
 * 另含分类映射降级与看板 served / pendingServeDraft、机主电话可见性。
 *
 * 独立的 UUID 段 `e7a00000-…` 与姓名前缀 "SERVE79 " —— 清理一律按这两者限定，
 * 绝不触碰库里已有的活动、报名与成员（那是开发者/生产同源的开发数据）。
 */
const ACTIVITY_ID = "e7a00000-0000-4000-8000-000000000001";
const ACTIVITY_TITLE = "SERVE79 接待落草稿集成测试活动";
const STAFF_USER_ID = "e7a00000-0000-4000-8000-000000000002";
const STAFF_PROFILE_ID = "e7a00000-0000-4000-8000-000000000003";
const ADMIN_USER_ID = "e7a00000-0000-4000-8000-000000000004";
const PREFIX = "SERVE79 ";

let activityAt = new Date();
let systemCategoryId = "";

const staffActor: AuthorizedActor = {
  actorType: "USER",
  userId: STAFF_USER_ID,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_serve79_staff",
};

const adminActor: AuthorizedActor = {
  actorType: "USER",
  userId: ADMIN_USER_ID,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_serve79_admin",
};

function memberActor(userId: string, requestId: string): AuthorizedActor {
  return {
    actorType: "USER",
    userId,
    userStatus: "ACTIVE",
    permissions: permissionsForRoles(["MEMBER"]),
    requestId,
  };
}

/** 失败断言：既核对错误码，也保证是 `AppError`（不是别的异常）。 */
async function expectCode(run: () => Promise<unknown>, code: ApiErrorCode): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.equal(error instanceof AppError, true, `期望 AppError，实际 ${String(error)}`);
    assert.equal((error as AppError).code, code);
    return true;
  });
}

/**
 * 清理本文件产生的全部行（顺序由外键决定）。
 *
 * 成员由 `memberService.create` 建档，会连带 user / userIdentity / audit；
 * 接待台动作另写审计、时间线与通知 —— 都必须先于记录与用户删除。
 */
async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  const profiles = await db.memberProfile.findMany({
    where: { realName: { startsWith: PREFIX } },
    select: { id: true, userId: true },
  });
  const profileIds = [STAFF_PROFILE_ID, ...profiles.map((row) => row.id)];
  const userIds = [STAFF_USER_ID, ADMIN_USER_ID, ...profiles.map((row) => row.userId)];
  const registrations = await db.repairActivityRegistration.findMany({
    where: { activityId: ACTIVITY_ID },
    select: { id: true },
  });
  const registrationIds = registrations.map((row) => row.id);
  const records = await db.repairRecord.findMany({
    where: {
      OR: [
        { memberProfileId: { in: profileIds } },
        { createRequestKey: { startsWith: "activity-serve:" } },
        { createRequestKey: { startsWith: "serve79-" } },
      ],
    },
    select: { id: true },
  });
  const recordIds = records.map((row) => row.id);

  await db.notification.deleteMany({
    where: {
      OR: [{ repairRecordId: { in: recordIds } }, { recipientMemberProfileId: { in: profileIds } }],
    },
  });
  await db.repairTimelineEvent.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.repairReview.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await db.auditLog.deleteMany({
    where: { targetType: "RepairRecord", targetId: { in: recordIds } },
  });
  await db.auditLog.deleteMany({
    where: { targetType: "RepairActivityRegistration", targetId: { in: registrationIds } },
  });
  await db.repairActivityRegistration.deleteMany({ where: { activityId: ACTIVITY_ID } });
  const attendanceIds = (
    await db.repairActivityAttendance.findMany({
      where: { activityId: ACTIVITY_ID },
      select: { id: true },
    })
  ).map((row) => row.id);
  await db.auditLog.deleteMany({
    where: { targetType: "RepairActivityAttendance", targetId: { in: attendanceIds } },
  });
  await db.repairActivityAttendance.deleteMany({ where: { activityId: ACTIVITY_ID } });
  // 参与行（issue #114）与照片先于记录删除：两者都是 RESTRICT 外键。
  // 评论 / 收藏同样 RESTRICT 引用记录（撤销用例会给草稿挂上它们），先清再删记录。
  await db.commentMention.deleteMany({
    where: { comment: { repairRecordId: { in: recordIds } } },
  });
  await db.repairComment.deleteMany({
    where: { repairRecordId: { in: recordIds }, parentCommentId: { not: null } },
  });
  await db.repairComment.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.repairFavorite.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.repairRecordParticipant.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.repairPhoto.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.repairRecord.deleteMany({ where: { id: { in: recordIds } } });
  await db.repairActivity.deleteMany({ where: { id: ACTIVITY_ID } });

  await db.userSkill.deleteMany({ where: { memberProfileId: { in: profileIds } } });
  await db.accountProvision.deleteMany({
    where: { OR: [{ userId: { in: userIds } }, { memberProfileId: { in: profileIds } }] },
  });
  await db.inviteCodeRedemption.deleteMany({ where: { userId: { in: userIds } } });
  await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: userIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.userIdentity.deleteMany({ where: { userId: { in: userIds } } });
  await db.memberProfile.deleteMany({ where: { id: { in: profileIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** 出勤 → 签到由用例负责；这里只建「已签到排队」的报名行。 */
async function createCheckedInRegistration(
  name: string,
  phone: string,
  issueType = "SOFTWARE_SYSTEM",
  deviceModel: string | null = null,
): Promise<{ id: string }> {
  const now = new Date();
  return getDb().repairActivityRegistration.create({
    data: {
      id: randomUUID(),
      activityId: ACTIVITY_ID,
      name: `${PREFIX}${name}`,
      phone,
      phoneLast4: phone.slice(-4),
      issueType,
      deviceModel,
      status: "CHECKED_IN",
      checkedInAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

/** 软删除本文件全部接待草稿：连续接待下一位客户前清掉上一条未提交草稿。 */
async function discardServeDrafts(): Promise<void> {
  await getDb().repairRecord.updateMany({
    where: {
      memberProfileId: STAFF_PROFILE_ID,
      createRequestKey: { startsWith: "activity-serve:" },
      status: "DRAFT",
      deletedAt: null,
    },
    data: { deletedAt: new Date() },
  });
}

let memberSeq = 0;
/** 直建一个有效成员（QQ / 手机号按进程内序号唯一）。 */
async function createMember(label: string) {
  memberSeq += 1;
  const tail = `${Date.now()}`.slice(-5);
  const serial = `${tail}${String(memberSeq).padStart(3, "0")}`.slice(-8);
  const result = await memberService.create(
    {
      realName: `${PREFIX}${label}`,
      qq: `6${serial}`,
      phone: `137${serial}`,
      idempotencyKey: randomUUID(),
    },
    adminActor,
  );
  return { ...result, owner: memberActor(result.member.userId, `req_serve79_${label}`) };
}

/** 走完整 M2 闭环产出已通过记录（**不带照片**：附件是选填，issue #79 第 6 项）。 */
async function createApprovedRepair(owner: AuthorizedActor, ownerLabel: string) {
  const category = await getDb().repairCategory.findUniqueOrThrow({ where: { code: "SYSTEM" } });
  const draft = await repairService.createDraft({ idempotencyKey: randomUUID() }, owner);
  const updated = await repairService.update(
    draft.id,
    {
      version: draft.version,
      repairDate: new Date().toISOString().slice(0, 10),
      durationMinutes: 30,
      categoryId: category.id,
      ownerName: `${PREFIX}${ownerLabel}机主`,
      ownerPhone: "13800139001",
      result: "COMPLETED",
    },
    owner,
  );
  const submitted = await repairService.submit(
    draft.id,
    { version: updated.version, idempotencyKey: randomUUID() },
    owner,
  );
  assert.equal(submitted.status, "PENDING");
  return repairReviewService.review(
    draft.id,
    { decision: "APPROVED", idempotencyKey: randomUUID() },
    adminActor,
  );
}

async function prepareFixtures(): Promise<void> {
  await cleanupFixtures();
  const db = getDb();
  const now = new Date();
  const hour = 60 * 60 * 1000;
  // 活动放在今天且报名已截止：现场操作仍开放，repairDate 也不晚于今天，
  // 后续「补齐字段并提交」可沿用提交校验（不允许未来日期）。
  activityAt = new Date(now);
  await db.user.create({
    data: {
      id: STAFF_USER_ID,
      status: "ACTIVE",
      displayName: "SERVE79 接待员",
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.memberProfile.create({
    data: {
      id: STAFF_PROFILE_ID,
      userId: STAFF_USER_ID,
      realName: "SERVE79 接待员",
      status: "ACTIVE",
      joinedAt: now,
      createdAt: now,
    },
  });
  await db.user.create({
    data: {
      id: ADMIN_USER_ID,
      status: "ACTIVE",
      displayName: "SERVE79 管理员",
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.repairActivity.create({
    data: {
      id: ACTIVITY_ID,
      title: ACTIVITY_TITLE,
      activityAt,
      capacity: 30,
      signupOpensAt: new Date(activityAt.getTime() - 2 * hour),
      signupClosesAt: new Date(activityAt.getTime() - hour),
      createdAt: now,
      updatedAt: now,
    },
  });
  const system = await db.repairCategory.findFirst({ where: { code: "SYSTEM" } });
  if (!system) {
    // 兜底：未跑 seed 的空库也认；与其它集成测试同一做法。
    systemCategoryId = "e7a00000-0000-4000-8000-000000000005";
    await db.repairCategory.create({
      data: {
        id: systemCategoryId,
        code: "SYSTEM",
        name: "系统问题",
        sortOrder: 91,
        createdAt: now,
      },
    });
  } else {
    systemCategoryId = system.id;
  }
  // 上一轮异常中断可能留下停用状态（本文件有停用/恢复的用例）：先恢复成启用。
  await db.repairCategory.updateMany({
    where: { id: systemCategoryId },
    data: { isActive: true },
  });
  await repairActivityStaffService.markAttendance(ACTIVITY_ID, staffActor);
}

before(async () => {
  if (!enabled) return;
  await prepareFixtures();
});

after(async () => {
  if (!enabled) return;
  await cleanupFixtures();
  await disconnectDb();
});

/* ------------------------------------------------------------ 迁移与旧数据 */

dbTest("机主两列可写可读；旧记录为 NULL 且 content 原样保留", async () => {
  const db = getDb();
  const now = new Date();
  const legacyId = randomUUID();
  await db.repairRecord.create({
    data: {
      id: legacyId,
      memberProfileId: STAFF_PROFILE_ID,
      status: "APPROVED",
      content: "历史数据的正文要原样保留。",
      createRequestKey: `serve79-legacy-${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    },
  });
  const legacy = await db.repairRecord.findUniqueOrThrow({ where: { id: legacyId } });
  assert.equal(legacy.ownerName, null, "旧记录没有机主姓名，不回填");
  assert.equal(legacy.ownerPhone, null, "旧记录没有机主电话，不回填");
  assert.equal(legacy.content, "历史数据的正文要原样保留。");
});

/* ------------------------------------------------------------ serve 产出草稿 */

dbTest("接待落单生成 DRAFT：预填机主 / 日期 / 分类 / 机型，正文与时长留空", async () => {
  await discardServeDrafts();
  const registration = await createCheckedInRegistration(
    "甲",
    "13900002001",
    "SOFTWARE_SYSTEM",
    "小新 Pro 14",
  );
  const served = await repairActivityStaffService.serve(ACTIVITY_ID, registration.id, staffActor);
  const record = await getDb().repairRecord.findUniqueOrThrow({
    where: { id: served.repairRecordId },
    include: { timeline: { orderBy: { createdAt: "asc" } } },
  });

  assert.equal(record.status, "DRAFT", "接待落单改为草稿，由成员补齐后提交");
  assert.equal(record.ownerName, `${PREFIX}甲`);
  assert.equal(record.ownerPhone, "13900002001", "完整号入库；可见性收口在视图层");
  assert.equal(record.deviceModel, "小新 Pro 14");
  assert.equal(record.repairDate?.toISOString().slice(0, 10), shanghaiCalendarDay(activityAt));
  assert.equal(record.categoryId, systemCategoryId, "故障类型 SOFTWARE_SYSTEM 映射到 SYSTEM");
  assert.equal(record.content, null, "不再写模板正文");
  assert.equal(record.durationMinutes, null, "不再写 1 分钟占位");
  assert.equal(record.remark, null, "不再写「活动接待自动落单」");
  assert.equal(record.submittedAt, null, "草稿不置提交时间");
  assert.equal(record.result, "COMPLETED", "成员端不填结果，缺省已完成（口径不变）");

  assert.deepEqual(
    record.timeline.map((event) => event.eventType),
    ["CREATED"],
    "只写 CREATED，不再写 SUBMITTED",
  );
  // 接待落单也落创建人参与行（issue #114 不变量：每条记录恒有 ≥1 参与行）。
  assert.deepEqual(
    await getDb().repairRecordParticipant.findMany({
      where: { repairRecordId: record.id },
      select: { memberProfileId: true, sortOrder: true },
    }),
    [{ memberProfileId: STAFF_PROFILE_ID, sortOrder: 0 }],
  );
  const summary = record.timeline[0]!.summary as {
    source?: string;
    registrationId?: string;
    activityId?: string;
  };
  assert.equal(summary.source, "repair_activity_serve");
  assert.equal(summary.registrationId, registration.id);
  assert.equal(summary.activityId, ACTIVITY_ID);

  const audit = await getDb().auditLog.findFirst({
    where: { action: "repair.created_from_activity_serve", targetId: record.id },
  });
  assert.ok(audit, "审计 repair.created_from_activity_serve 保留");
  assert.equal((audit!.afterSummary as { status?: string } | null)?.status, "DRAFT");
});

dbTest("分类映射不到 / 已停用时降级为 null，接待本身必须成功", async () => {
  await discardServeDrafts();
  const db = getDb();
  // 不依赖 seed 里的其它分类：m0 的 before 会整表清空 repair_categories。
  // 直接把映射目标（SYSTEM）停用，等价于「映射到已停用分类」；用完立即恢复，
  // 后面的用例仍要拿它做提交与统计。
  await db.repairCategory.update({
    where: { id: systemCategoryId },
    data: { isActive: false },
  });
  try {
    const registration = await createCheckedInRegistration("乙", "13900002002", "SOFTWARE_SYSTEM");
    const served = await repairActivityStaffService.serve(ACTIVITY_ID, registration.id, staffActor);
    const record = await db.repairRecord.findUniqueOrThrow({
      where: { id: served.repairRecordId },
    });
    assert.equal(record.status, "DRAFT");
    assert.equal(record.categoryId, null, "映射不到启用分类时置空，由成员在表单里补选");
  } finally {
    await db.repairCategory.update({
      where: { id: systemCategoryId },
      data: { isActive: true },
    });
  }
});

/* ------------------------------------------------------------ 全局拦截矩阵 */

dbTest("全局拦截：存在接待草稿时任何活动都不能再接单（409，消息含客户名）", async () => {
  await discardServeDrafts();
  const first = await createCheckedInRegistration("丙", "13900002003");
  const served = await repairActivityStaffService.serve(ACTIVITY_ID, first.id, staffActor);

  const second = await createCheckedInRegistration("丁", "13900002004");
  await assert.rejects(
    () => repairActivityStaffService.serve(ACTIVITY_ID, second.id, staffActor),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, "ACTIVITY_SERVE_DRAFT_PENDING");
      assert.equal((error as AppError).status, 409);
      assert.match((error as AppError).message, new RegExp(`${PREFIX}丙`), "消息要点名客户");
      return true;
    },
  );
  const notServed = await getDb().repairActivityRegistration.findUniqueOrThrow({
    where: { id: second.id },
  });
  assert.equal(notServed.status, "CHECKED_IN", "被拦截的接待不得改动报名状态");

  // 软删除草稿后放行；看板对已软删除记录给出 recordStatus = null。
  await getDb().repairRecord.update({
    where: { id: served.repairRecordId },
    data: { deletedAt: new Date() },
  });
  const servedAgain = await repairActivityStaffService.serve(ACTIVITY_ID, second.id, staffActor);
  assert.ok(servedAgain.repairRecordId);

  const board = await repairActivityStaffService.getBoard(ACTIVITY_ID, staffActor);
  const firstRow = board.served.find((row) => row.id === first.id);
  assert.equal(firstRow?.recordStatus, null, "记录缺失或已软删除 → recordStatus 为 null");
  const secondRow = board.served.find((row) => row.id === second.id);
  assert.equal(secondRow?.recordStatus, "DRAFT");
});

dbTest("提交后（PENDING）不拦截；手工草稿（非接待产生）也不拦截", async () => {
  await discardServeDrafts();
  // 1) 接待草稿 → 补齐字段 → 提交（不带照片）→ PENDING。
  const first = await createCheckedInRegistration("戊", "13900002005");
  const served = await repairActivityStaffService.serve(ACTIVITY_ID, first.id, staffActor);
  const draft = await getDb().repairRecord.findUniqueOrThrow({
    where: { id: served.repairRecordId },
  });
  const filled = await repairService.update(
    draft.id,
    { version: draft.version, durationMinutes: 45 },
    staffActor,
  );
  assert.equal(filled.ownerPhone, "13900002005", "serve 的回归视图对归属人下发完整号");
  const submitted = await repairService.submit(
    draft.id,
    { version: filled.version, idempotencyKey: randomUUID() },
    staffActor,
  );
  assert.equal(submitted.status, "PENDING", "无正文、无照片也能提交（issue #79 第 6 项）");

  // 2) PENDING 不拦截。
  const second = await createCheckedInRegistration("己", "13900002006");
  await repairActivityStaffService.serve(ACTIVITY_ID, second.id, staffActor);
  await discardServeDrafts();

  // 3) 手工草稿（`activityRegistration` 为空）不拦截。
  const manual = await repairService.createDraft({ idempotencyKey: randomUUID() }, staffActor);
  assert.equal(manual.status, "DRAFT");
  const third = await createCheckedInRegistration("庚", "13900002007");
  const servedThird = await repairActivityStaffService.serve(ACTIVITY_ID, third.id, staffActor);
  assert.ok(servedThird.repairRecordId, "手工草稿不属于接待落单，不应拦截");

  // 4) 端到端收尾：审核通过这条接待产生的记录。
  const approved = await repairReviewService.review(
    draft.id,
    { decision: "APPROVED", idempotencyKey: randomUUID() },
    adminActor,
  );
  assert.equal(approved.status, "APPROVED");
});

/* ------------------------------------------------------------ 看板 */

dbTest("看板 served 与 pendingServeDraft：草稿提交前非空、提交后为 null", async () => {
  await discardServeDrafts();
  const registration = await createCheckedInRegistration("辛", "13900002008");
  const served = await repairActivityStaffService.serve(ACTIVITY_ID, registration.id, staffActor);

  let board = await repairActivityStaffService.getBoard(ACTIVITY_ID, staffActor);
  assert.equal(board.pendingServeDraft?.repairRecordId, served.repairRecordId);
  assert.equal(board.pendingServeDraft?.ownerName, `${PREFIX}辛`);
  assert.equal(board.pendingServeDraft?.activityTitle, ACTIVITY_TITLE);
  const row = board.served.find((item) => item.id === registration.id);
  assert.equal(row?.recordStatus, "DRAFT");
  assert.equal(row?.phoneMasked.includes("****"), true, "看板行仍用掩码电话");

  const draft = await getDb().repairRecord.findUniqueOrThrow({
    where: { id: served.repairRecordId },
  });
  const filled = await repairService.update(
    draft.id,
    { version: draft.version, durationMinutes: 20 },
    staffActor,
  );
  await repairService.submit(
    draft.id,
    { version: filled.version, idempotencyKey: randomUUID() },
    staffActor,
  );

  board = await repairActivityStaffService.getBoard(ACTIVITY_ID, staffActor);
  assert.equal(board.pendingServeDraft, null, "提交后不再有未完成的接待草稿");
  assert.equal(board.served.find((item) => item.id === registration.id)?.recordStatus, "PENDING");
});

/* ------------------------------------------------------------ 可见性 */

dbTest("机主电话可见性：归属人与重审权限拿完整号，其他人一律 null", async () => {
  const owner = await createMember("机主");
  const other = await createMember("旁观");
  const approved = await createApprovedRepair(owner.owner, "可见性");

  // 归属人读自己的记录详情 → 完整号。
  const ownDetail = await repairQueryService.getById(approved.id, owner.owner);
  assert.equal(ownDetail.ownerPhone, "13800139001");
  assert.equal(ownDetail.ownerName, `${PREFIX}可见性机主`);

  // 其他普通成员读已通过记录 → 可读，但电话为 null（不下发掩码，也不下发完整号）。
  const otherDetail = await repairQueryService.getById(approved.id, other.owner);
  assert.equal(otherDetail.ownerPhone, null);
  assert.equal(otherDetail.ownerName, `${PREFIX}可见性机主`, "机主姓名在成员区可见");

  // 列表：普通成员读他人记录不过是 null；带 repair:review 的管理端列表必须下发完整号。
  const memberList = await repairQueryService.list(
    { page: 1, pageSize: 50, query: `${PREFIX}可见性机主` },
    other.owner,
  );
  const memberRow = memberList.items.find((item) => item.id === approved.id);
  assert.equal(memberRow?.ownerPhone, null);

  const adminList = await repairQueryService.list(
    { page: 1, pageSize: 50, query: `${PREFIX}可见性机主` },
    adminActor,
  );
  const adminRow = adminList.items.find((item) => item.id === approved.id);
  assert.equal(
    adminRow?.ownerPhone,
    "13800139001",
    "管理端列表必须下发完整号，否则编辑表单会把号码清空",
  );

  // 搜索：机主姓名可搜；电话不参与搜索。
  const byPhone = await repairQueryService.list(
    { page: 1, pageSize: 50, query: "13800139001" },
    adminActor,
  );
  assert.equal(
    byPhone.items.some((item) => item.id === approved.id),
    false,
    "机主电话不得参与搜索",
  );
});

dbTest("管理端 PATCH 修改其它字段时 ownerPhone / ownerName 不被清空", async () => {
  const owner = await createMember("管理端");
  const approved = await createApprovedRepair(owner.owner, "管理端");

  const updated = await repairAdminService.updateRecord(
    approved.id,
    { version: approved.version, durationMinutes: 66, reason: "修正异常时长" },
    adminActor,
  );
  assert.equal(updated.durationMinutes, 66);
  assert.equal(updated.ownerPhone, "13800139001", "管理端返回视图带完整号");
  assert.equal(updated.ownerName, `${PREFIX}管理端机主`);

  const row = await getDb().repairRecord.findUniqueOrThrow({ where: { id: approved.id } });
  assert.equal(row.ownerPhone, "13800139001", "未提交的字段必须保持不动");
  assert.equal(row.durationMinutes, 66);
});

dbTest("普通成员编辑老记录不带 content：正文不被清空（undefined = 不动）", async () => {
  const owner = await createMember("保正文");
  const db = getDb();
  const now = new Date();
  const legacyId = randomUUID();
  await db.repairRecord.create({
    data: {
      id: legacyId,
      memberProfileId: (
        await db.memberProfile.findFirstOrThrow({
          where: { userId: owner.member.userId },
        })
      ).id,
      status: "DRAFT",
      content: "老记录的正文不能被编辑表单清掉。",
      remark: "旧备注",
      createRequestKey: `serve79-keep-${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    },
  });
  const before = await repairService.update(
    legacyId,
    { version: 1, durationMinutes: 25 },
    owner.owner,
  );
  assert.equal(before.content, "老记录的正文不能被编辑表单清掉。");
  assert.equal(before.remark, "旧备注");
});

dbTest("非归属人不能编辑他人的接待草稿（REPAIR_FORBIDDEN）", async () => {
  await discardServeDrafts();
  const registration = await createCheckedInRegistration("壬", "13900002009");
  const served = await repairActivityStaffService.serve(ACTIVITY_ID, registration.id, staffActor);

  const stranger = await createMember("越权");
  await expectCode(
    () =>
      repairService.update(
        served.repairRecordId,
        { version: 1, durationMinutes: 10 },
        stranger.owner,
      ),
    "REPAIR_FORBIDDEN",
  );
});

/* ------------------------------------------------------------ 撤销接待（issue #166） */

dbTest("撤销接待：接待者本人或活动管理员可撤，报名回排队、草稿与照片一并删除", async () => {
  await discardServeDrafts();
  const registration = await createCheckedInRegistration("撤甲", "13900002010");
  const served = await repairActivityStaffService.serve(ACTIVITY_ID, registration.id, staffActor);

  // 给草稿挂一条照片行：撤销必须连同照片记录一起删（文件删除是 best-effort）。
  await getDb().repairPhoto.create({
    data: {
      id: randomUUID(),
      repairRecordId: served.repairRecordId,
      storageKey: `repairs/zz/revoke-${randomUUID()}.png`,
      originalName: "revoke.png",
      mimeType: "image/png",
      sizeBytes: 8,
      sha256Digest: Buffer.alloc(32),
      sortOrder: 0,
      uploadedByUserId: STAFF_USER_ID,
      createdAt: new Date(),
    },
  });

  let board = await repairActivityStaffService.getBoard(ACTIVITY_ID, staffActor);
  assert.equal(board.served.find((row) => row.id === registration.id)?.canRevert, true);
  assert.equal(board.pendingServeDraft?.registrationId, registration.id, "弹层可定位到这次接待");

  const reverted = await repairActivityStaffService.revertServe(
    ACTIVITY_ID,
    registration.id,
    staffActor,
  );
  assert.equal(reverted.deletedRecordId, served.repairRecordId);
  assert.equal(reverted.photosDeleted, 1);
  assert.equal(reverted.registration.status, "CHECKED_IN", "签过到的回到排队");

  const db = getDb();
  assert.equal(await db.repairRecord.findUnique({ where: { id: served.repairRecordId } }), null);
  assert.equal(await db.repairPhoto.count({ where: { repairRecordId: served.repairRecordId } }), 0);
  assert.equal(
    await db.repairRecordParticipant.count({ where: { repairRecordId: served.repairRecordId } }),
    0,
  );
  const row = await db.repairActivityRegistration.findUniqueOrThrow({
    where: { id: registration.id },
  });
  assert.equal(row.servedAt, null);
  assert.equal(row.servedByMemberProfileId, null);
  assert.equal(row.repairRecordId, null);
  assert.ok(
    await db.auditLog.findFirst({
      where: { action: "repair_activity.registration_serve_reverted", targetId: registration.id },
    }),
    "撤销接待必须留审计",
  );
  board = await repairActivityStaffService.getBoard(ACTIVITY_ID, staffActor);
  assert.equal(board.pendingServeDraft, null, "撤销后全局拦截解除");

  // 撤销后可以立刻接待下一位。
  const next = await createCheckedInRegistration("撤乙", "13900002011");
  assert.ok(
    (await repairActivityStaffService.serve(ACTIVITY_ID, next.id, staffActor)).repairRecordId,
  );
});

dbTest("撤销接待：非接待者且非管理员被拒；已提交记录不能撤销", async () => {
  await discardServeDrafts();
  const other = await createMember("撤丙");
  await repairActivityStaffService.markAttendance(ACTIVITY_ID, other.owner);

  const registration = await createCheckedInRegistration("撤丁", "13900002012");
  const served = await repairActivityStaffService.serve(ACTIVITY_ID, registration.id, staffActor);

  // 另一位已签到、但既不是接待者也不是活动管理员的成员：拒绝。
  await expectCode(
    () => repairActivityStaffService.revertServe(ACTIVITY_ID, registration.id, other.owner),
    "FORBIDDEN",
  );

  // 草稿提交后（PENDING）不能再撤销接待，走审核退回流程。
  const record = await getDb().repairRecord.findUniqueOrThrow({
    where: { id: served.repairRecordId },
  });
  const filled = await repairService.update(
    record.id,
    { version: record.version, durationMinutes: 20 },
    staffActor,
  );
  await repairService.submit(
    record.id,
    { version: filled.version, idempotencyKey: randomUUID() },
    staffActor,
  );
  await expectCode(
    () => repairActivityStaffService.revertServe(ACTIVITY_ID, registration.id, staffActor),
    "ACTIVITY_REGISTRATION_STATE_INVALID",
  );
  await discardServeDrafts();
});

dbTest("活动结束仍可撤销接待：清理历史评论、收藏与通知，不撞外键（审查 #195）", async () => {
  await discardServeDrafts();
  const registration = await createCheckedInRegistration("撤己", "13900002014");
  const served = await repairActivityStaffService.serve(ACTIVITY_ID, registration.id, staffActor);
  const db = getDb();
  const now = new Date();
  // 作者对自己的 DRAFT 有读权限，评论 / 收藏在详情页就是可点的；通知随评论产生。
  await db.repairComment.create({
    data: {
      id: randomUUID(),
      repairRecordId: served.repairRecordId,
      authorMemberProfileId: STAFF_PROFILE_ID,
      body: "草稿下的一句评论",
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.repairFavorite.create({
    data: {
      id: randomUUID(),
      memberProfileId: STAFF_PROFILE_ID,
      repairRecordId: served.repairRecordId,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.notification.create({
    data: {
      id: randomUUID(),
      recipientMemberProfileId: STAFF_PROFILE_ID,
      type: "REPAIR_COMMENTED",
      status: "UNREAD",
      repairRecordId: served.repairRecordId,
      createdAt: now,
      updatedAt: now,
    },
  });

  const activity = await db.repairActivity.findUniqueOrThrow({ where: { id: ACTIVITY_ID } });
  let reverted;
  try {
    const yesterday = new Date(Date.now() - 86_400_000);
    await db.repairActivity.update({
      where: { id: ACTIVITY_ID },
      data: {
        activityAt: yesterday,
        signupClosesAt: new Date(yesterday.getTime() - 3_600_000),
        signupOpensAt: new Date(yesterday.getTime() - 7_200_000),
      },
    });
    assert.equal(
      (await repairActivityStaffService.getBoard(ACTIVITY_ID, staffActor)).activity.status,
      "ENDED",
    );
    reverted = await repairActivityStaffService.revertServe(
      ACTIVITY_ID,
      registration.id,
      staffActor,
    );
  } finally {
    await db.repairActivity.update({
      where: { id: ACTIVITY_ID },
      data: {
        activityAt: activity.activityAt,
        signupClosesAt: activity.signupClosesAt,
        signupOpensAt: activity.signupOpensAt,
      },
    });
  }
  assert.equal(reverted.deletedRecordId, served.repairRecordId);
  assert.equal(await db.repairRecord.findUnique({ where: { id: served.repairRecordId } }), null);
  assert.equal(
    await db.repairComment.count({ where: { repairRecordId: served.repairRecordId } }),
    0,
  );
  assert.equal(
    await db.repairFavorite.count({ where: { repairRecordId: served.repairRecordId } }),
    0,
  );
  assert.equal(
    await db.notification.count({ where: { repairRecordId: served.repairRecordId } }),
    0,
  );
  const audit = await db.auditLog.findFirstOrThrow({
    where: { action: "repair_activity.registration_serve_reverted", targetId: registration.id },
  });
  const after = audit.afterSummary as { commentsDeleted: number; favoritesDeleted: number };
  assert.equal(after.commentsDeleted, 1);
  assert.equal(after.favoritesDeleted, 1);
  const row = await db.repairActivityRegistration.findUniqueOrThrow({
    where: { id: registration.id },
  });
  assert.equal(row.status, "CHECKED_IN", "撤销后报名回到排队");
});
