import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { aggregateCategoryDistribution } from "../../src/features/analytics/analytics-repository";
import { rankingService } from "../../src/features/analytics/ranking-service";
import { memberRepository } from "../../src/features/members/member-repository";
import { repairAdminService } from "../../src/features/repairs/repair-admin-service";
import {
  listMemberRepairSummary,
  repairQueryService,
} from "../../src/features/repairs/repair-query-service";
import { repairReviewService } from "../../src/features/repairs/repair-review-service";
import { repairService } from "../../src/features/repairs/repair-service";
import { repairFieldLimits } from "../../src/config/repairs";
import {
  notificationService,
  summarizeNotifications,
} from "../../src/features/community/notification-service";
import { AppError, type ApiErrorCode } from "../../src/lib/api/errors";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import type { AuthorizedActor } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";
import { callRoute, sessionCookie } from "./http-harness";

/* 集成测试的统一闸门：指向非测试库时**在加载阶段就抛错**（`db-guard.ts` 里写了两次
   实际事故）。未开启时返回 false，各文件照常走 test.skip。 */
const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

/**
 * 多参与者链路集成测试（真实 GreatSQL）：
 * 建档 / 编辑（整体替换语义）/ 存在性校验 / 上限；
 * 审核通知发给全部参与者（审核人除外）；统计按**参与关系**双计（成员列表、排名、
 * 分类分布、个人摘要四个口径）；管理端 PATCH 替换参与者并写审计前后值；
 * 管理端 memberId 筛选按「参与过」匹配。
 *
 * 独立的 UUID 段 `e8b00000-…` 与姓名前缀 "PART114 " —— 清理一律按这两者限定，
 * 绝不触碰库里已有的活动、报名与成员。
 */
const PREFIX = "PART114 ";
const ADMIN_USER_ID = "e8b00000-0000-4000-8000-000000000001";
const ADMIN_PROFILE_ID = "e8b00000-0000-4000-8000-000000000002";

type MemberFixture = {
  userId: string;
  profileId: string;
  realName: string;
  actor: AuthorizedActor;
};

let seq = 0;

/** 直建 User + MemberProfile：服务直调不走 `authenticateRequest`，无需角色行与口令凭据。 */
async function createMember(label: string): Promise<MemberFixture> {
  const db = getDb();
  seq += 1;
  const tag = String(seq).padStart(3, "0");
  const userId = randomUUID();
  const profileId = randomUUID();
  const now = new Date();
  const realName = `${PREFIX}${label}${tag}`;
  await db.user.create({
    data: { id: userId, status: "ACTIVE", displayName: realName, createdAt: now, updatedAt: now },
  });
  await db.memberProfile.create({
    data: { id: profileId, userId, realName, status: "ACTIVE", joinedAt: now, createdAt: now },
  });
  return {
    userId,
    profileId,
    realName,
    actor: {
      actorType: "USER",
      userId,
      userStatus: "ACTIVE",
      permissions: permissionsForRoles(["MEMBER"]),
      requestId: `req_part114_${tag}`,
    },
  };
}

const adminActor: AuthorizedActor = {
  actorType: "USER",
  userId: ADMIN_USER_ID,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_part114_admin",
};

/** 失败断言：既核对错误码，也保证是 `AppError`（不是别的异常）。 */
async function expectCode(run: () => Promise<unknown>, code: ApiErrorCode): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.equal(error instanceof AppError, true, `期望 AppError，实际 ${String(error)}`);
    assert.equal((error as AppError).code, code);
    return true;
  });
}

async function participantRows(recordId: string) {
  return getDb().repairRecordParticipant.findMany({
    where: { repairRecordId: recordId },
    orderBy: { sortOrder: "asc" },
    select: { memberProfileId: true, sortOrder: true },
  });
}

async function categoryId(): Promise<string> {
  return (await getDb().repairCategory.findUniqueOrThrow({ where: { code: "SYSTEM" } })).id;
}

/** 清理本文件产生的全部行（顺序由外键决定：参与者行必须先于记录与档案删除）。 */
async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  const profiles = await db.memberProfile.findMany({
    where: { realName: { startsWith: PREFIX } },
    select: { id: true, userId: true },
  });
  const profileIds = [ADMIN_PROFILE_ID, ...profiles.map((row) => row.id)];
  const userIds = [ADMIN_USER_ID, ...profiles.map((row) => row.userId)];
  const records = await db.repairRecord.findMany({
    where: {
      OR: [
        { memberProfileId: { in: profileIds } },
        { participants: { some: { memberProfileId: { in: profileIds } } } },
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
  await db.repairRecordParticipant.deleteMany({
    where: {
      OR: [{ repairRecordId: { in: recordIds } }, { memberProfileId: { in: profileIds } }],
    },
  });
  await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await db.auditLog.deleteMany({
    where: { targetType: "RepairRecord", targetId: { in: recordIds } },
  });
  await db.repairRecord.deleteMany({ where: { id: { in: recordIds } } });
  await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: userIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.memberProfile.deleteMany({ where: { id: { in: profileIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function prepareFixtures(): Promise<void> {
  await cleanupFixtures();
  const db = getDb();
  const now = new Date();
  await db.user.create({
    data: {
      id: ADMIN_USER_ID,
      status: "ACTIVE",
      displayName: `${PREFIX}管理员`,
      createdAt: now,
      updatedAt: now,
    },
  });
  // 管理员也建成员档案：排名服务要求操作者有 ACTIVE 档案，
  // 同时本文件借它验证「审核人本人是参与者时不给自己发通知」。
  await db.memberProfile.create({
    data: {
      id: ADMIN_PROFILE_ID,
      userId: ADMIN_USER_ID,
      realName: `${PREFIX}管理员`,
      status: "ACTIVE",
      joinedAt: now,
      createdAt: now,
    },
  });
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

/* ------------------------------------------------------------ 建档 */

dbTest("建档：创建人恒为第一行，额外成员按添加顺序落库", async () => {
  const creator = await createMember("创建甲");
  const extra = await createMember("参与乙");
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), participantIds: [extra.profileId] },
    creator.actor,
  );
  assert.deepEqual(
    draft.participants.map((row) => row.id),
    [creator.profileId, extra.profileId],
    "视图参与者顺序 = 创建人在前",
  );
  assert.deepEqual(await participantRows(draft.id), [
    { memberProfileId: creator.profileId, sortOrder: 0 },
    { memberProfileId: extra.profileId, sortOrder: 1 },
  ]);
  assert.equal(draft.member.id, creator.profileId, "member 字段仍是创建人（主维修人）");
});

dbTest("建档不带参与者：仍落创建人一行（不变量：每条记录 ≥1 参与行）", async () => {
  const creator = await createMember("独做丙");
  const draft = await repairService.createDraft({ idempotencyKey: randomUUID() }, creator.actor);
  assert.deepEqual(await participantRows(draft.id), [
    { memberProfileId: creator.profileId, sortOrder: 0 },
  ]);
});

/* ------------------------------------------------------------ 编辑：整体替换 */

dbTest("编辑：去重、剔除创建人本人、显式空数组清空、undefined 不动", async () => {
  const creator = await createMember("编辑甲");
  const b = await createMember("编辑乙");
  const c = await createMember("编辑丙");
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), participantIds: [b.profileId] },
    creator.actor,
  );

  // 重复 + 混入创建人本人：服务端去重并按「创建人第一」重排。
  const replaced = await repairService.update(
    draft.id,
    {
      version: draft.version,
      participantIds: [b.profileId, c.profileId, c.profileId, creator.profileId],
    },
    creator.actor,
  );
  assert.deepEqual(
    replaced.participants.map((row) => row.id),
    [creator.profileId, b.profileId, c.profileId],
  );
  assert.deepEqual(await participantRows(draft.id), [
    { memberProfileId: creator.profileId, sortOrder: 0 },
    { memberProfileId: b.profileId, sortOrder: 1 },
    { memberProfileId: c.profileId, sortOrder: 2 },
  ]);

  // 显式空数组 = 清空额外参与者（创建人保留）。
  const cleared = await repairService.update(
    draft.id,
    { version: replaced.version, participantIds: [] },
    creator.actor,
  );
  assert.deepEqual(
    cleared.participants.map((row) => row.id),
    [creator.profileId],
  );

  // undefined = 不动：改别的字段不得动参与者。
  const withExtra = await repairService.update(
    draft.id,
    { version: cleared.version, participantIds: [c.profileId] },
    creator.actor,
  );
  const untouched = await repairService.update(
    draft.id,
    { version: withExtra.version, durationMinutes: 45 },
    creator.actor,
  );
  assert.equal(untouched.durationMinutes, 45);
  assert.deepEqual(
    untouched.participants.map((row) => row.id),
    [creator.profileId, c.profileId],
    "未提交 participantIds 时参与者保持原样",
  );
});

/* ------------------------------------------------------------ 校验 */

dbTest("人数上限：建档、成员编辑与管理端编辑允许 8 名协作者，拒绝第 9 名", async () => {
  const creator = await createMember("上限创建人");
  const extras = await Promise.all(
    Array.from({ length: 9 }, (_, index) => createMember(`上限协作者${index}`)),
  );
  const participantIds = extras.slice(0, 8).map((row) => row.profileId);
  const overflowIds = extras.map((row) => row.profileId);
  const expectedIds = [creator.profileId, ...participantIds];

  await expectCode(
    () =>
      repairService.createDraft(
        { idempotencyKey: randomUUID(), participantIds: overflowIds },
        creator.actor,
      ),
    "VALIDATION_FAILED",
  );
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), participantIds },
    creator.actor,
  );
  assert.deepEqual(
    draft.participants.map((row) => row.id),
    expectedIds,
  );

  await expectCode(
    () =>
      repairService.update(
        draft.id,
        { version: draft.version, participantIds: overflowIds },
        creator.actor,
      ),
    "VALIDATION_FAILED",
  );
  await expectCode(
    () =>
      repairAdminService.updateRecord(
        draft.id,
        { version: draft.version, reason: "人数上限校验", participantIds: overflowIds },
        adminActor,
      ),
    "VALIDATION_FAILED",
  );
  assert.deepEqual(
    (await participantRows(draft.id)).map((row) => row.memberProfileId),
    expectedIds,
  );
  assert.equal(
    (await getDb().repairRecord.findUniqueOrThrow({ where: { id: draft.id } })).version,
    draft.version,
  );

  const reduced = await repairService.update(
    draft.id,
    { version: draft.version, participantIds: participantIds.slice(0, 7) },
    creator.actor,
  );
  assert.equal(reduced.participants.length, 8);
  const restored = await repairService.update(
    draft.id,
    { version: reduced.version, participantIds },
    creator.actor,
  );
  assert.deepEqual(
    restored.participants.map((row) => row.id),
    expectedIds,
  );
  const adminUpdated = await repairAdminService.updateRecord(
    draft.id,
    { version: restored.version, reason: "满员名单可保存", participantIds },
    adminActor,
  );
  assert.deepEqual(
    adminUpdated.participants.map((row) => row.id),
    expectedIds,
  );
});

dbTest("校验：不存在的成员、软删除成员、超上限一律拒绝", async () => {
  const creator = await createMember("校验甲");
  const ghost = await createMember("校验乙");
  const draft = await repairService.createDraft({ idempotencyKey: randomUUID() }, creator.actor);

  await expectCode(
    () =>
      repairService.update(
        draft.id,
        { version: draft.version, participantIds: [randomUUID()] },
        creator.actor,
      ),
    "VALIDATION_FAILED",
  );

  // 软删除的成员不能作为新参与者（历史档案仍可留在旧记录的参与行上，但不能再加）。
  await getDb().memberProfile.update({
    where: { id: ghost.profileId },
    data: { deletedAt: new Date() },
  });
  await expectCode(
    () =>
      repairService.update(
        draft.id,
        { version: draft.version, participantIds: [ghost.profileId] },
        creator.actor,
      ),
    "VALIDATION_FAILED",
  );

  // 上限含创建人本人：额外成员最多 participantMaxCount - 1 个。
  const extras = await Promise.all(
    Array.from({ length: repairFieldLimits.participantMaxCount }, (_, index) =>
      createMember(`超限${index}`),
    ),
  );
  await expectCode(
    () =>
      repairService.update(
        draft.id,
        { version: draft.version, participantIds: extras.map((row) => row.profileId) },
        creator.actor,
      ),
    "VALIDATION_FAILED",
  );
});

/* ------------------------------------------------------------ 审核通知与统计双计 */

dbTest("审核通过：通知发给全部参与者（审核人除外），统计按参与关系双计", async () => {
  const db = getDb();
  const creator = await createMember("通过甲");
  const extra = await createMember("通过乙");
  const category = await categoryId();
  // 审核人本人也是参与者：他应该被通知逻辑剔除。
  const draft = await repairService.createDraft({ idempotencyKey: randomUUID() }, creator.actor);
  const filled = await repairService.update(
    draft.id,
    {
      version: draft.version,
      repairDate: new Date().toISOString().slice(0, 10),
      durationMinutes: 40,
      categoryId: category,
      deviceModel: "PART114 测试机型",
      ownerName: `${PREFIX}通过机主`,
      ownerPhone: "13800139114",
      participantIds: [extra.profileId, ADMIN_PROFILE_ID],
    },
    creator.actor,
  );
  await repairService.submit(
    draft.id,
    { version: filled.version, idempotencyKey: randomUUID() },
    creator.actor,
  );
  const approved = await repairReviewService.review(
    draft.id,
    { decision: "APPROVED", idempotencyKey: randomUUID() },
    adminActor,
  );
  assert.equal(approved.status, "APPROVED");

  // 通知：只发给创建人与额外成员；审核人（也是参与者）不给自己发。
  const notifications = await db.notification.findMany({
    where: { repairRecordId: draft.id },
    select: { recipientMemberProfileId: true, type: true },
  });
  assert.deepEqual(
    notifications.map((row) => row.recipientMemberProfileId).sort(),
    [creator.profileId, extra.profileId].sort(),
    "审核通知发给全部参与者，且剔除审核人本人",
  );
  assert.equal(
    notifications.every((row) => row.type === "REPAIR_APPROVED"),
    true,
  );

  // 统计口径 1：成员列表计数（`approvedRepairStats` 走参与关系聚合）。
  const list = await memberRepository.list({ page: 1, pageSize: 10, query: extra.realName });
  const entry = list.rows.find((row) => row.id === extra.profileId);
  assert.equal(entry?.approvedRepairCount, 1, "额外参与者也计入一次");
  assert.equal(entry?.approvedRepairMinutes, 40, "时长取记录上的同一值，不分人");

  // 统计口径 2：分类分布（原始 SQL JOIN 参与行）。
  const distribution = await aggregateCategoryDistribution(extra.profileId, null);
  const row = distribution.find((item) => item.categoryId === category);
  assert.equal(Number(row?.approvedCount), 1);
  assert.equal(Number(row?.durationMinutes), 40);

  // 统计口径 3：个人摘要（`approvedForMember` → participants.some）。
  const summary = await listMemberRepairSummary(extra.profileId);
  assert.equal(summary.totalApprovedCount.value, 1);
  assert.equal(summary.totalApprovedDurationMinutes.value, 40);

  // 统计口径 4：排行榜（窗口函数按参与关系分组）。
  const ranking = await rankingService.getRankings(
    { scope: "ALL_TIME", metric: "REPAIR_COUNT", page: 1, pageSize: 100 },
    adminActor,
  );
  const ranked = ranking.items.find((item) => item.memberProfileId === extra.profileId);
  assert.equal(ranked?.approvedCount, 1, "额外参与者也上榜且计数一次");
});

/* ------------------------------------------------------------ 管理端 */

dbTest("管理端 PATCH：整体替换参与者并写审计前后值", async () => {
  const db = getDb();
  const creator = await createMember("管理甲");
  const b = await createMember("管理乙");
  const c = await createMember("管理丙");
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), participantIds: [b.profileId] },
    creator.actor,
  );

  const updated = await repairAdminService.updateRecord(
    draft.id,
    { version: draft.version, reason: "调整参与人员", participantIds: [c.profileId] },
    adminActor,
  );
  assert.deepEqual(
    updated.participants.map((row) => row.id),
    [creator.profileId, c.profileId],
  );
  assert.deepEqual(await participantRows(draft.id), [
    { memberProfileId: creator.profileId, sortOrder: 0 },
    { memberProfileId: c.profileId, sortOrder: 1 },
  ]);

  const audit = await db.auditLog.findFirst({
    where: { action: "repair.admin.updated", targetId: draft.id },
  });
  assert.ok(audit, "管理端修改必须落审计");
  assert.deepEqual((audit!.beforeSummary as { participantIds?: string[] }).participantIds, [
    creator.profileId,
    b.profileId,
  ]);
  assert.deepEqual((audit!.afterSummary as { participantIds?: string[] }).participantIds, [
    creator.profileId,
    c.profileId,
  ]);
});

dbTest("管理端 memberId 筛选：创建人之外的参与者也命中", async () => {
  const creator = await createMember("筛选甲");
  const b = await createMember("筛选乙");
  const outsider = await createMember("筛选丙");
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), participantIds: [b.profileId] },
    creator.actor,
  );

  const matched = await repairQueryService.list(
    { page: 1, pageSize: 20, memberId: b.profileId, status: "DRAFT" },
    adminActor,
  );
  assert.equal(
    matched.items.some((item) => item.id === draft.id),
    true,
    "按「参与过」筛选：额外参与者也能查到",
  );
  const unmatched = await repairQueryService.list(
    { page: 1, pageSize: 20, memberId: outsider.profileId, status: "DRAFT" },
    adminActor,
  );
  assert.equal(
    unmatched.items.some((item) => item.id === draft.id),
    false,
  );
});

dbTest("成员与管理端 HTTP PATCH 拒绝非字符串参与者，名单与版本均不变", async () => {
  const creator = await createMember("HTTP甲");
  const extra = await createMember("HTTP乙");
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), participantIds: [extra.profileId] },
    creator.actor,
  );
  const { PATCH: memberPatch } = await import("../../src/app/api/v1/repairs/[id]/route");
  const { PATCH: adminPatch } = await import("../../src/app/api/v1/admin/repairs/[id]/route");
  const memberCookie = await sessionCookie(creator.userId, "MEMBER");
  const adminCookie = await sessionCookie(ADMIN_USER_ID);
  for (const [handler, cookie, path] of [
    [memberPatch, memberCookie, "repairs"],
    [adminPatch, adminCookie, "admin/repairs"],
  ] as const) {
    for (const participantIds of [[123], [extra.profileId, null], [true], [{}]]) {
      const response = await callRoute(handler, `http://localhost/api/v1/${path}/${draft.id}`, {
        method: "PATCH",
        headers: { cookie },
        params: { id: draft.id },
        body: { version: draft.version, reason: "非法名单校验", participantIds },
      });
      assert.equal(response.status, 400);
      assert.equal((response.json.error as { code: string }).code, "VALIDATION_FAILED");
      assert.equal(
        (await getDb().repairRecord.findUniqueOrThrow({ where: { id: draft.id } })).version,
        draft.version,
      );
      assert.deepEqual(
        (await participantRows(draft.id)).map((row) => row.memberProfileId),
        [creator.profileId, extra.profileId],
      );
    }
  }
});

dbTest("保留软删除的历史参与者可正常编辑，移除后不得重新新增", async () => {
  const creator = await createMember("历史甲");
  const extra = await createMember("历史乙");
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), participantIds: [extra.profileId] },
    creator.actor,
  );
  await getDb().memberProfile.update({
    where: { id: extra.profileId },
    data: { deletedAt: new Date() },
  });
  const memberEdit = await repairService.update(
    draft.id,
    {
      version: draft.version,
      durationMinutes: 45,
      participantIds: [extra.profileId.toUpperCase()],
    },
    creator.actor,
  );
  const adminEdit = await repairAdminService.updateRecord(
    draft.id,
    {
      version: memberEdit.version,
      durationMinutes: 60,
      participantIds: [extra.profileId],
      reason: "仅调整时长",
    },
    adminActor,
  );
  assert.equal(adminEdit.durationMinutes, 60);
  assert.deepEqual(
    adminEdit.participants.map((row) => row.id),
    [creator.profileId, extra.profileId],
  );
  const cleared = await repairAdminService.updateRecord(
    draft.id,
    {
      version: adminEdit.version,
      participantIds: [],
      reason: "移除历史关联",
    },
    adminActor,
  );
  for (const edit of [
    () =>
      repairService.update(
        draft.id,
        { version: cleared.version, participantIds: [extra.profileId] },
        creator.actor,
      ),
    () =>
      repairAdminService.updateRecord(
        draft.id,
        { version: cleared.version, participantIds: [extra.profileId], reason: "不得重新新增" },
        adminActor,
      ),
  ])
    await expectCode(edit, "VALIDATION_FAILED");
});

dbTest("UUID 大小写混用在建档与两个编辑入口都只落一条参与关系", async () => {
  const creator = await createMember("UUID甲");
  const extra = await createMember("UUID乙");
  const participantIds = [
    creator.profileId.toUpperCase(),
    extra.profileId.toUpperCase(),
    extra.profileId,
  ];
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), participantIds },
    creator.actor,
  );
  const edited = await repairService.update(
    draft.id,
    { version: draft.version, participantIds },
    creator.actor,
  );
  const adminEdited = await repairAdminService.updateRecord(
    draft.id,
    {
      version: edited.version,
      participantIds,
      reason: "UUID 归一",
    },
    adminActor,
  );
  assert.deepEqual(
    adminEdited.participants.map((row) => row.id),
    [creator.profileId, extra.profileId],
  );
  assert.equal((await participantRows(draft.id)).length, 2);
});

dbTest("另一端新增参与者后保存标记，旧表单版本必须冲突且不得删除新增成员", async () => {
  const creator = await createMember("并发甲");
  const extra = await createMember("并发乙");
  const draft = await repairService.createDraft({ idempotencyKey: randomUUID() }, creator.actor);
  await repairService.update(
    draft.id,
    { version: draft.version, participantIds: [extra.profileId] },
    creator.actor,
  );
  await repairAdminService.updateFlags(
    draft.id,
    { isTypical: true, isDifficult: false },
    adminActor,
  );
  await expectCode(
    () =>
      repairAdminService.updateRecord(
        draft.id,
        {
          version: draft.version,
          durationMinutes: 45,
          participantIds: [],
          reason: "旧快照编辑",
        },
        adminActor,
      ),
    "REPAIR_VERSION_CONFLICT",
  );
  assert.deepEqual(
    (await participantRows(draft.id)).map((row) => row.memberProfileId),
    [creator.profileId, extra.profileId],
  );
});

dbTest(
  "退回通知保留事件，额外参与者的列表、已读响应与工作台摘要不返回不可见链接或正文",
  async () => {
    const creator = await createMember("退回甲");
    const extra = await createMember("退回乙");
    const draft = await repairService.createDraft(
      { idempotencyKey: randomUUID(), participantIds: [extra.profileId] },
      creator.actor,
    );
    const filled = await repairService.update(
      draft.id,
      {
        version: draft.version,
        repairDate: new Date().toISOString().slice(0, 10),
        durationMinutes: 40,
        categoryId: await categoryId(),
        deviceModel: "PART114 退回机型",
        ownerName: "测试机主",
        ownerPhone: "13800139114",
        remark: "不可见的退回备注",
      },
      creator.actor,
    );
    await repairService.submit(
      draft.id,
      { version: filled.version, idempotencyKey: randomUUID() },
      creator.actor,
    );
    await repairReviewService.review(
      draft.id,
      { decision: "REJECTED", note: "补充信息", idempotencyKey: randomUUID() },
      adminActor,
    );
    await expectCode(() => repairQueryService.getById(draft.id, extra.actor), "REPAIR_NOT_FOUND");
    const extraList = await notificationService.list({ page: 1, pageSize: 20 }, extra.actor);
    assert.equal(extraList.items.length, 1);
    const notification = extraList.items[0];
    assert.equal(notification.type, "REPAIR_REJECTED");
    const marked = await notificationService.markRead(notification.id, extra.actor);
    const summary = await summarizeNotifications(extra.profileId, extra.actor);
    for (const view of [notification, marked, summary.latest[0]]) {
      assert.equal(view.repairRecordId, null);
      assert.equal(view.repairExcerpt, null);
      assert.equal(view.commentId, null);
    }
    const ownerList = await notificationService.list({ page: 1, pageSize: 20 }, creator.actor);
    assert.equal(ownerList.items[0].repairRecordId, draft.id);
    assert.equal(ownerList.items[0].repairExcerpt, "不可见的退回备注");
  },
);
