import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { GET as detailRoute, PATCH as updateRoute } from "../../src/app/api/v1/repairs/[id]/route";
import { POST as submitRoute } from "../../src/app/api/v1/repairs/[id]/submit/route";
import { POST as withdrawRoute } from "../../src/app/api/v1/repairs/[id]/withdraw/route";
import { POST as createRoute } from "../../src/app/api/v1/repairs/route";
import { repairFieldLimits } from "../../src/config/repairs";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { integrationTestsEnabled } from "./db-guard";
import { callRoute, sessionCookie } from "./http-harness";

/**
 * 成员维修表单的「机型」字段（issue #218，真实 GreatSQL）：
 * 路由入参归一 → 详情回显 → 草稿可改 → 提交审核必填（撤回重提同样适用）。
 *
 * 独立的 UUID 段 `e8c00000-…` 与姓名前缀 "DM218 "：清理只按这两者限定。
 * 机型列与活动落单复制已由 `repair-activity-device-model.test.ts` 覆盖，这里只测成员侧写入。
 */
const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

const PREFIX = "DM218 ";

async function createMember(label: string) {
  const db = getDb();
  const userId = randomUUID();
  const profileId = randomUUID();
  const now = new Date();
  await db.user.create({
    data: {
      id: userId,
      status: "ACTIVE",
      displayName: `${PREFIX}${label}`,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.memberProfile.create({
    data: {
      id: profileId,
      userId,
      realName: `${PREFIX}${label}`,
      status: "ACTIVE",
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  return { userId, profileId, cookie: await sessionCookie(userId, "MEMBER") };
}

async function systemCategoryId(): Promise<string> {
  return (await getDb().repairCategory.findUniqueOrThrow({ where: { code: "SYSTEM" } })).id;
}

/** 一份能通过提交校验的完整草稿（除机型外），机型由调用方决定。 */
async function completeDraftFields(deviceModel?: string | null) {
  return {
    repairDate: new Date().toISOString().slice(0, 10),
    durationMinutes: 30,
    categoryId: await systemCategoryId(),
    ownerName: "机主",
    ownerPhone: "13900002180",
    result: "COMPLETED",
    ...(deviceModel === undefined ? {} : { deviceModel }),
  };
}

function fieldErrorsOf(json: Record<string, unknown>): Record<string, string[]> {
  return ((json.error ?? {}) as { fieldErrors?: Record<string, string[]> }).fieldErrors ?? {};
}

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

after(async () => {
  if (!enabled) return;
  await cleanupFixtures();
  await disconnectDb();
});

dbTest("机型（#218）：路由入参去空白，详情回显，草稿可改可清空", async () => {
  const member = await createMember("写入");
  const created = await callRoute(createRoute, "http://localhost/api/v1/repairs", {
    method: "POST",
    headers: { cookie: member.cookie, "Idempotency-Key": randomUUID() },
    body: { deviceModel: "  联想 小新  " },
  });
  assert.equal(created.status, 201);
  const draft = created.json.data as { id: string; version: number; deviceModel: string | null };
  assert.equal(draft.deviceModel, "联想 小新", "写入前应去掉首尾空白");

  const patched = await callRoute(updateRoute, "http://localhost/api/v1/repairs/x", {
    method: "PATCH",
    headers: { cookie: member.cookie },
    body: { version: draft.version, deviceModel: "ThinkPad X1 Carbon" },
    params: { id: draft.id },
  });
  assert.equal(patched.status, 200);
  assert.equal((patched.json.data as { deviceModel: string }).deviceModel, "ThinkPad X1 Carbon");

  const detail = await callRoute(detailRoute, "http://localhost/api/v1/repairs/x", {
    headers: { cookie: member.cookie },
    params: { id: draft.id },
  });
  assert.equal((detail.json.data as { deviceModel: string }).deviceModel, "ThinkPad X1 Carbon");

  // 草稿阶段允许清空（例如换设备前先移除），填了就必须在上限内。
  const cleared = await callRoute(updateRoute, "http://localhost/api/v1/repairs/x", {
    method: "PATCH",
    headers: { cookie: member.cookie },
    body: { version: (patched.json.data as { version: number }).version, deviceModel: "" },
    params: { id: draft.id },
  });
  assert.equal(cleared.status, 200);
  assert.equal((cleared.json.data as { deviceModel: string | null }).deviceModel, null);

  const tooLong = await callRoute(updateRoute, "http://localhost/api/v1/repairs/x", {
    method: "PATCH",
    headers: { cookie: member.cookie },
    body: {
      version: (cleared.json.data as { version: number }).version,
      deviceModel: "机".repeat(repairFieldLimits.deviceModelMaxLength + 1),
    },
    params: { id: draft.id },
  });
  assert.equal(tooLong.status, 400);
  assert.ok(fieldErrorsOf(tooLong.json).deviceModel, "错误应定位到 deviceModel 字段");
});

dbTest("机型（#218）：提交审核必填，撤回重提同样要求", async () => {
  const member = await createMember("提交");
  const created = await callRoute(createRoute, "http://localhost/api/v1/repairs", {
    method: "POST",
    headers: { cookie: member.cookie, "Idempotency-Key": randomUUID() },
    body: await completeDraftFields(),
  });
  assert.equal(created.status, 201);
  let current = created.json.data as { id: string; version: number; deviceModel: string | null };
  assert.equal(current.deviceModel, null, "草稿允许暂时没有机型（活动落单可能就是空的）");

  const submit = (version: number) =>
    callRoute(submitRoute, "http://localhost/api/v1/repairs/x/submit", {
      method: "POST",
      headers: { cookie: member.cookie, "Idempotency-Key": randomUUID() },
      body: { version },
      params: { id: current.id },
    });

  const blocked = await submit(current.version);
  assert.equal(blocked.status, 400);
  assert.equal((blocked.json.error as { code?: string }).code, "REPAIR_SUBMISSION_INCOMPLETE");
  assert.ok(fieldErrorsOf(blocked.json).deviceModel, "缺机型要定位到 deviceModel");

  const filled = await callRoute(updateRoute, "http://localhost/api/v1/repairs/x", {
    method: "PATCH",
    headers: { cookie: member.cookie },
    body: { version: current.version, deviceModel: "Redmi Book Pro 15" },
    params: { id: current.id },
  });
  current = filled.json.data as typeof current;
  const accepted = await submit(current.version);
  assert.equal(accepted.status, 200);
  assert.equal((accepted.json.data as { status: string }).status, "PENDING");
  assert.equal((accepted.json.data as { deviceModel: string }).deviceModel, "Redmi Book Pro 15");

  // 撤回 → 改回空机型（草稿允许）→ 再次提交仍被拦：撤回重提不豁免必填。
  const withdrawn = await callRoute(withdrawRoute, "http://localhost/api/v1/repairs/x/withdraw", {
    method: "POST",
    headers: { cookie: member.cookie, "Idempotency-Key": randomUUID() },
    body: { version: (accepted.json.data as { version: number }).version },
    params: { id: current.id },
  });
  const backToDraft = withdrawn.json.data as { version: number; status: string };
  assert.equal(backToDraft.status, "DRAFT");
  const emptied = await callRoute(updateRoute, "http://localhost/api/v1/repairs/x", {
    method: "PATCH",
    headers: { cookie: member.cookie },
    body: { version: backToDraft.version, deviceModel: null },
    params: { id: current.id },
  });
  assert.equal(emptied.status, 200);
  const blockedAgain = await submit((emptied.json.data as { version: number }).version);
  assert.equal(blockedAgain.status, 400);
  assert.ok(fieldErrorsOf(blockedAgain.json).deviceModel);
});
