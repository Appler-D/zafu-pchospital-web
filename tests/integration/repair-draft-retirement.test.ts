import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  retireRepairDrafts,
  type DraftRetirementSnapshot,
} from "../../src/features/repairs/repair-draft-retirement-service";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { integrationTestsEnabled } from "./db-guard";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

/**
 * 存量草稿盘点与处置（issue #223，真实 GreatSQL）。
 *
 * 覆盖：dry-run 不写库、活动草稿回填补提、分类重映射、作废软删除并清空接待关联、
 * 系统时间线 / 审计、撤回草稿两种策略、备份前置、事后核对与幂等重跑。
 *
 * 独立姓名前缀 "DR223 " 与分类 code 前缀 "DR223_"：清理只按这两者限定。
 */
const PREFIX = "DR223 ";
const CODE_PREFIX = "DR223_";
const FIXED_NOW = new Date("2026-10-05T00:00:00.000Z");
const SEED_TIME = new Date("2026-09-21T00:00:00.000Z");
const RUN_ID = "draft-retire-test-run";

type Member = { userId: string; profileId: string };

async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  const profiles = await db.memberProfile.findMany({
    where: { realName: { startsWith: PREFIX } },
    select: { id: true, userId: true },
  });
  const profileIds = profiles.map((row) => row.id);
  const userIds = profiles.map((row) => row.userId);
  const records = await db.repairRecord.findMany({
    where: { memberProfileId: { in: profileIds } },
    select: { id: true },
  });
  const recordIds = records.map((row) => row.id);
  const activities = await db.repairActivity.findMany({
    where: { title: { startsWith: PREFIX } },
    select: { id: true },
  });
  const activityIds = activities.map((row) => row.id);

  await db.repairActivityRegistration.deleteMany({ where: { activityId: { in: activityIds } } });
  await db.notification.deleteMany({
    where: {
      OR: [{ repairRecordId: { in: recordIds } }, { recipientMemberProfileId: { in: profileIds } }],
    },
  });
  await db.repairTimelineEvent.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.repairReview.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.repairRecordParticipant.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.repairPhoto.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.auditLog.deleteMany({
    where: { targetType: "RepairRecord", targetId: { in: recordIds } },
  });
  await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await db.repairRecord.deleteMany({ where: { id: { in: recordIds } } });
  await db.repairActivity.deleteMany({ where: { id: { in: activityIds } } });
  await db.repairCategory.deleteMany({ where: { code: { startsWith: CODE_PREFIX } } });
  await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: userIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.memberProfile.deleteMany({ where: { id: { in: profileIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeEach(async () => {
  if (!enabled) return;
  await cleanupFixtures();
});

after(async () => {
  if (!enabled) return;
  await cleanupFixtures();
  await disconnectDb();
});

async function seedMember(): Promise<Member> {
  const db = getDb();
  const userId = randomUUID();
  const profileId = randomUUID();
  const now = SEED_TIME;
  await db.user.create({
    data: {
      id: userId,
      status: "ACTIVE",
      displayName: `${PREFIX}成员`,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.memberProfile.create({
    data: {
      id: profileId,
      userId,
      realName: `${PREFIX}成员`,
      status: "ACTIVE",
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  return { userId, profileId };
}

async function systemCategory(): Promise<string> {
  const row = await getDb().repairCategory.findUniqueOrThrow({ where: { code: "SYSTEM" } });
  return row.id;
}

async function coolingCategory(): Promise<string> {
  const row = await getDb().repairCategory.findUniqueOrThrow({
    where: { code: "COOLING_CLEANING" },
  });
  return row.id;
}

async function retiredCategory(): Promise<string> {
  const id = randomUUID();
  const now = SEED_TIME;
  await getDb().repairCategory.create({
    data: {
      id,
      code: `${CODE_PREFIX}RETIRED`,
      name: `${PREFIX}已停用分类`,
      sortOrder: 999,
      isActive: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}

async function createActivity(label: string, activityAt: Date): Promise<string> {
  const id = randomUUID();
  const now = SEED_TIME;
  await getDb().repairActivity.create({
    data: {
      id,
      title: `${PREFIX}${label}`,
      activityAt,
      capacity: 10,
      signupOpensAt: new Date(activityAt.getTime() - 7 * 24 * 60 * 60 * 1000),
      signupClosesAt: new Date(activityAt.getTime() - 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}

async function createRegistration(
  activityId: string,
  memberProfileId: string,
  repairRecordId: string,
  overrides: { phone?: string; deviceModel?: string | null; issueType?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const now = SEED_TIME;
  const phone = overrides.phone ?? "13900001111";
  await getDb().repairActivityRegistration.create({
    data: {
      id,
      activityId,
      name: `${PREFIX}客户`,
      phone,
      phoneLast4: phone.slice(-4),
      issueType: overrides.issueType ?? "SOFTWARE_SYSTEM",
      deviceModel: overrides.deviceModel === undefined ? "小新 Pro" : overrides.deviceModel,
      status: "SERVED",
      consentVersion: "v1",
      consentAcceptedAt: now,
      checkedInAt: now,
      servedAt: now,
      servedByMemberProfileId: memberProfileId,
      repairRecordId,
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}

type DraftSeed = {
  repairDate?: Date | null;
  durationMinutes?: number | null;
  categoryId?: string | null;
  ownerName?: string | null;
  ownerPhone?: string | null;
  deviceModel?: string | null;
  content?: string | null;
  result?: string | null;
  submittedAt?: Date | null;
};

async function createDraft(memberProfileId: string, seed: DraftSeed = {}): Promise<string> {
  const db = getDb();
  const id = randomUUID();
  const now = SEED_TIME;
  await db.repairRecord.create({
    data: {
      id,
      memberProfileId,
      status: "DRAFT",
      createRequestKey: `dr223:${id}`,
      repairDate: seed.repairDate === undefined ? null : seed.repairDate,
      durationMinutes: seed.durationMinutes === undefined ? 30 : seed.durationMinutes,
      categoryId: seed.categoryId === undefined ? null : seed.categoryId,
      ownerName: seed.ownerName === undefined ? null : seed.ownerName,
      ownerPhone: seed.ownerPhone === undefined ? null : seed.ownerPhone,
      deviceModel: seed.deviceModel === undefined ? null : seed.deviceModel,
      content: seed.content === undefined ? null : seed.content,
      result: seed.result === undefined ? "COMPLETED" : seed.result,
      submittedAt: seed.submittedAt === undefined ? null : seed.submittedAt,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.repairRecordParticipant.create({
    data: {
      id: randomUUID(),
      repairRecordId: id,
      memberProfileId,
      sortOrder: 0,
      createdAt: now,
    },
  });
  return id;
}

function completeSeed(categoryId: string): DraftSeed {
  return {
    repairDate: new Date("2026-10-01T00:00:00.000Z"),
    durationMinutes: 30,
    categoryId,
    ownerName: "李四",
    ownerPhone: "13900002222",
    deviceModel: "X1 Carbon",
  };
}

async function recordIdsByStatus(): Promise<{ draft: number; pending: number; deleted: number }> {
  const db = getDb();
  const [draft, pending, deleted] = await Promise.all([
    db.repairRecord.count({ where: { status: "DRAFT", deletedAt: null } }),
    db.repairRecord.count({ where: { status: "PENDING", deletedAt: null } }),
    db.repairRecord.count({ where: { deletedAt: { not: null } } }),
  ]);
  return { draft, pending, deleted };
}

const backupWriter = async (snapshot: DraftRetirementSnapshot): Promise<string> => {
  return `/tmp/${snapshot.database.replace(/\W+/g, "-")}-backup.json`;
};

dbTest("dry-run：分组报告且完全只读", async () => {
  const member = await seedMember();
  const system = await systemCategory();
  const activityId = await createActivity("dry-run 活动", new Date("2026-09-20T02:00:00.000Z"));
  const activityDraft = await createDraft(member.profileId);
  await createRegistration(activityId, member.profileId, activityDraft);
  const completeId = await createDraft(member.profileId, completeSeed(system));
  const notCompletedId = await createDraft(member.profileId, {
    ...completeSeed(system),
    result: "NOT_COMPLETED",
  });
  const withdrawnId = await createDraft(member.profileId, {
    ...completeSeed(system),
    submittedAt: new Date("2026-09-30T08:00:00.000Z"),
  });

  const result = await retireRepairDrafts({ apply: false, withdrawnMode: null });
  assert.equal(result.report.total, 4);
  assert.deepEqual(result.report.byAction, { submit: 2, void: 1, "withdrawn-pending": 1 });
  assert.equal(result.report.bySource.activity.submit, 1);
  assert.equal(result.report.withdrawn.total, 1);
  assert.equal(result.report.withdrawn.eligibleToSubmit, 1);
  assert.equal(result.applied, undefined);

  const records = await getDb().repairRecord.findMany({
    where: { id: { in: [activityDraft, completeId, notCompletedId, withdrawnId] } },
  });
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.equal(record.status, "DRAFT");
    assert.equal(record.deletedAt, null);
  }
  const registration = await getDb().repairActivityRegistration.findFirstOrThrow({
    where: { activityId },
  });
  assert.equal(registration.repairRecordId, activityDraft);
  assert.deepEqual(await recordIdsByStatus(), { draft: 4, pending: 0, deleted: 0 });
});

dbTest("apply：回填补提 / 分类重映射 / 作废并清空接待关联 / 系统审计", async () => {
  const member = await seedMember();
  const system = await systemCategory();
  const cooling = await coolingCategory();
  const retired = await retiredCategory();
  const activityAt = new Date("2026-09-20T02:00:00.000Z");

  const activityId = await createActivity("活动补提", activityAt);
  const activityDraft = await createDraft(member.profileId);
  await createRegistration(activityId, member.profileId, activityDraft);

  const remapActivityId = await createActivity("分类重映射", activityAt);
  const remapDraft = await createDraft(member.profileId, {
    ...completeSeed(retired),
    ownerPhone: null,
    deviceModel: null,
    categoryId: retired,
  });
  await createRegistration(remapActivityId, member.profileId, remapDraft, {
    issueType: "CLEAN_ONLY",
  });

  const voidActivityId = await createActivity("缺机型作废", activityAt);
  const voidDraft = await createDraft(member.profileId, {
    ...completeSeed(system),
    deviceModel: null,
  });
  await createRegistration(voidActivityId, member.profileId, voidDraft, { deviceModel: null });

  const manualCompleteId = await createDraft(member.profileId, completeSeed(system));
  const manualNotCompletedId = await createDraft(member.profileId, {
    ...completeSeed(system),
    result: "NOT_COMPLETED",
  });

  const withdrawnActivityId = await createActivity("撤回草稿", activityAt);
  const withdrawnId = await createDraft(member.profileId, {
    ...completeSeed(system),
    submittedAt: new Date("2026-09-30T08:00:00.000Z"),
  });
  await createRegistration(withdrawnActivityId, member.profileId, withdrawnId);

  let snapshotSeen: DraftRetirementSnapshot | undefined;
  let draftsAtBackup = -1;
  const result = await retireRepairDrafts({
    apply: true,
    withdrawnMode: "void",
    now: FIXED_NOW,
    runId: RUN_ID,
    backupWriter: async (snapshot) => {
      snapshotSeen = snapshot;
      draftsAtBackup = (await recordIdsByStatus()).draft;
      return backupWriter(snapshot);
    },
  });

  assert.equal(draftsAtBackup, 6, "备份必须在任何写库之前完成");
  assert.equal(snapshotSeen?.records.length, 6);
  const applied = result.applied;
  assert.ok(applied);
  assert.equal(applied.postCheckPassed, true);
  assert.deepEqual(
    new Set(applied.submittedRecordIds),
    new Set([activityDraft, remapDraft, manualCompleteId]),
  );
  assert.deepEqual(
    new Set(applied.voidedRecordIds),
    new Set([voidDraft, manualNotCompletedId, withdrawnId]),
  );
  assert.equal(applied.failures.length, 0);
  assert.equal(applied.postCheck.activeDraftCount, 0);
  assert.equal(applied.postCheck.submittedPendingCount, 3);
  assert.equal(applied.postCheck.voidedCount, 3);
  assert.equal(applied.postCheck.clearedRegistrationCount, 2);
  assert.equal(applied.postCheck.danglingRegistrationCount, 0);

  const db = getDb();
  const backfilled = await db.repairRecord.findUniqueOrThrow({ where: { id: activityDraft } });
  assert.equal(backfilled.status, "PENDING");
  assert.ok(backfilled.submittedAt);
  assert.equal(backfilled.ownerName, `${PREFIX}客户`);
  assert.equal(backfilled.ownerPhone, "13900001111");
  assert.equal(backfilled.deviceModel, "小新 Pro");
  assert.equal(backfilled.categoryId, system);
  assert.equal(backfilled.repairDate?.toISOString(), "2026-09-20T00:00:00.000Z");
  const keptRegistration = await db.repairActivityRegistration.findFirstOrThrow({
    where: { activityId },
  });
  assert.equal(keptRegistration.repairRecordId, activityDraft);
  assert.equal(keptRegistration.status, "SERVED");

  const remapped = await db.repairRecord.findUniqueOrThrow({ where: { id: remapDraft } });
  assert.equal(remapped.status, "PENDING");
  assert.equal(remapped.categoryId, cooling);
  assert.equal(remapped.ownerPhone, "13900001111");
  assert.equal(remapped.deviceModel, "小新 Pro");

  const voided = await db.repairRecord.findUniqueOrThrow({ where: { id: voidDraft } });
  assert.equal(voided.status, "DRAFT");
  assert.ok(voided.deletedAt);
  const voidedRegistration = await db.repairActivityRegistration.findFirstOrThrow({
    where: { activityId: voidActivityId },
  });
  assert.equal(voidedRegistration.repairRecordId, null);
  assert.equal(voidedRegistration.status, "SERVED");
  assert.equal(voidedRegistration.servedByMemberProfileId, member.profileId);

  const withdrawn = await db.repairRecord.findUniqueOrThrow({ where: { id: withdrawnId } });
  assert.ok(withdrawn.deletedAt);
  const withdrawnRegistration = await db.repairActivityRegistration.findFirstOrThrow({
    where: { activityId: withdrawnActivityId },
  });
  assert.equal(withdrawnRegistration.repairRecordId, null);
  assert.equal(withdrawnRegistration.status, "SERVED");

  const submittedEvent = await db.repairTimelineEvent.findFirstOrThrow({
    where: { repairRecordId: activityDraft, eventType: "SUBMITTED" },
  });
  const eventSummary = submittedEvent.summary as {
    source?: string;
    runId?: string;
    backfilled?: string[];
  };
  assert.equal(eventSummary.source, "draft-retire");
  assert.equal(eventSummary.runId, RUN_ID);
  assert.ok(eventSummary.backfilled?.includes("ownerPhone"));
  const deletedEvent = await db.repairTimelineEvent.findFirstOrThrow({
    where: { repairRecordId: voidDraft, eventType: "DELETED" },
  });
  assert.equal((deletedEvent.summary as { source?: string }).source, "draft-retire");

  const submitAudit = await db.auditLog.findFirstOrThrow({
    where: {
      targetType: "RepairRecord",
      targetId: activityDraft,
      action: "repair.draft_retired_submitted",
    },
  });
  assert.equal(submitAudit.actorType, "SYSTEM");
  assert.equal(submitAudit.requestId, RUN_ID);
  const voidAudit = await db.auditLog.findFirstOrThrow({
    where: {
      targetType: "RepairRecord",
      targetId: voidDraft,
      action: "repair.draft_retired_voided",
    },
  });
  assert.equal(voidAudit.actorType, "SYSTEM");
  assert.equal(voidAudit.requestId, RUN_ID);
  assert.equal(await db.notification.count({ where: { repairRecordId: activityDraft } }), 0);
  assert.equal(await db.repairReview.count({ where: { repairRecordId: activityDraft } }), 0);

  const rerun = await retireRepairDrafts({
    apply: true,
    withdrawnMode: "void",
    now: FIXED_NOW,
    runId: `${RUN_ID}-rerun`,
    backupWriter,
  });
  assert.equal(rerun.report.total, 0);
  assert.equal(rerun.applied?.submittedRecordIds.length, 0);
  assert.equal(rerun.applied?.voidedRecordIds.length, 0);
  assert.equal(rerun.applied?.postCheckPassed, true);
});

dbTest("已撤回草稿：未指定策略时拒绝 apply，且不写备份 / 不写库", async () => {
  const member = await seedMember();
  const system = await systemCategory();
  const withdrawnId = await createDraft(member.profileId, {
    ...completeSeed(system),
    submittedAt: new Date("2026-09-30T08:00:00.000Z"),
  });
  let backupCalled = false;
  await assert.rejects(
    retireRepairDrafts({
      apply: true,
      withdrawnMode: null,
      backupWriter: async (snapshot) => {
        backupCalled = true;
        return backupWriter(snapshot);
      },
    }),
    /已撤回草稿/,
  );
  assert.equal(backupCalled, false);
  const record = await getDb().repairRecord.findUniqueOrThrow({ where: { id: withdrawnId } });
  assert.equal(record.status, "DRAFT");
  assert.equal(record.deletedAt, null);
});

dbTest("已撤回草稿按补提：保留原 submittedAt 痕迹并直接进入 PENDING", async () => {
  const member = await seedMember();
  const system = await systemCategory();
  const activityId = await createActivity("撤回补提", new Date("2026-09-20T02:00:00.000Z"));
  const previousSubmittedAt = new Date("2026-09-30T08:00:00.000Z");
  const withdrawnId = await createDraft(member.profileId, {
    ...completeSeed(system),
    submittedAt: previousSubmittedAt,
  });
  await createRegistration(activityId, member.profileId, withdrawnId);

  const result = await retireRepairDrafts({
    apply: true,
    withdrawnMode: "submit",
    now: FIXED_NOW,
    runId: `${RUN_ID}-submit-withdrawn`,
    backupWriter,
  });
  assert.equal(result.report.withdrawn.mode, "submit");
  assert.deepEqual(result.report.byAction, { submit: 1, void: 0, "withdrawn-pending": 0 });
  assert.equal(result.applied?.postCheckPassed, true);

  const record = await getDb().repairRecord.findUniqueOrThrow({ where: { id: withdrawnId } });
  assert.equal(record.status, "PENDING");
  assert.equal(record.submittedAt?.toISOString(), FIXED_NOW.toISOString());
  const registration = await getDb().repairActivityRegistration.findFirstOrThrow({
    where: { activityId },
  });
  assert.equal(registration.repairRecordId, withdrawnId);
  const event = await getDb().repairTimelineEvent.findFirstOrThrow({
    where: { repairRecordId: withdrawnId, eventType: "SUBMITTED" },
  });
  assert.equal(
    (event.summary as { previouslySubmittedAt?: string }).previouslySubmittedAt,
    previousSubmittedAt.toISOString(),
  );
});

dbTest("apply 缺少备份写入器时拒绝执行", async () => {
  const member = await seedMember();
  const system = await systemCategory();
  const draftId = await createDraft(member.profileId, completeSeed(system));
  await assert.rejects(retireRepairDrafts({ apply: true, withdrawnMode: null }), /必须先写出备份/);
  const record = await getDb().repairRecord.findUniqueOrThrow({ where: { id: draftId } });
  assert.equal(record.status, "DRAFT");
  assert.equal(record.deletedAt, null);
});
