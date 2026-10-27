import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { GET as detailRoute, PATCH as updateRoute } from "../../src/app/api/v1/repairs/[id]/route";
import { POST as submitRoute } from "../../src/app/api/v1/repairs/[id]/submit/route";
import { POST as createRoute } from "../../src/app/api/v1/repairs/route";
import { repairFieldLimits } from "../../src/config/repairs";
import { repairService } from "../../src/features/repairs/repair-service";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { integrationTestsEnabled } from "./db-guard";
import { callRoute, sessionCookie } from "./http-harness";

/**
 * 成员维修表单的「机型」字段（真实 GreatSQL）：
 * 路由入参归一 → 详情回显 → 草稿可改 → 提交审核必填（退回重提同样适用）。
 *
 * 同文件还覆盖「提交即建单」的幂等复放：并发同键只落一条、软删除后复放不返回旧记录。
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
  const db = getDb();
  const existing = await db.repairCategory.findUnique({ where: { code: "SYSTEM" } });
  if (existing) return existing.id;
  // 单文件定向运行时测试库可能还没被其它套件建分类，这里兜底。
  const created = await db.repairCategory.create({
    data: {
      id: randomUUID(),
      code: "SYSTEM",
      name: "系统问题",
      sortOrder: 90,
      createdAt: new Date(),
    },
  });
  return created.id;
}

/** 一份能通过提交校验的完整草稿（除机型外），机型由调用方决定。 */
async function completeDraftFields(deviceModel?: string | null) {
  return {
    repairDate: new Date().toISOString().slice(0, 10),
    durationMinutes: 30,
    categoryId: await systemCategoryId(),
    ownerName: "机主",
    ownerPhone: "13900002180",
    result: "COMPLETED" as const,
    ...(deviceModel === undefined ? {} : { deviceModel }),
  };
}

function memberActor(member: { userId: string }) {
  return {
    actorType: "USER" as const,
    userId: member.userId,
    userStatus: "ACTIVE" as const,
    permissions: permissionsForRoles(["MEMBER"]),
    requestId: `req_dm218_${member.userId.slice(0, 8)}`,
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

dbTest("机型（#218）：草稿写入去空白、可改可清空（过渡期服务层夹具）", async () => {
  const member = await createMember("写入");
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), deviceModel: "  联想 小新  " },
    memberActor(member),
  );
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

dbTest("机型（#218）：提交审核必填，提交后成员不可再改", async () => {
  const member = await createMember("提交");
  const draft = await repairService.createDraft(
    { idempotencyKey: randomUUID(), ...(await completeDraftFields(null)) },
    memberActor(member),
  );
  assert.equal(draft.deviceModel, null, "草稿允许暂时没有机型（活动落单可能就是空的）");

  const submit = (version: number) =>
    callRoute(submitRoute, "http://localhost/api/v1/repairs/x/submit", {
      method: "POST",
      headers: { cookie: member.cookie, "Idempotency-Key": randomUUID() },
      body: { version },
      params: { id: draft.id },
    });

  const blocked = await submit(draft.version);
  assert.equal(blocked.status, 400);
  const blockedCode = (blocked.json.error as { code?: string }).code;
  assert.equal(blockedCode, "REPAIR_SUBMISSION_INCOMPLETE");
  assert.ok(fieldErrorsOf(blocked.json).deviceModel, "缺机型要定位到 deviceModel");

  const filled = await callRoute(updateRoute, "http://localhost/api/v1/repairs/x", {
    method: "PATCH",
    headers: { cookie: member.cookie },
    body: { version: draft.version, deviceModel: "Redmi Book Pro 15" },
    params: { id: draft.id },
  });
  const accepted = await submit((filled.json.data as { version: number }).version);
  assert.equal(accepted.status, 200);
  assert.equal((accepted.json.data as { status: string }).status, "PENDING");
  assert.equal((accepted.json.data as { deviceModel: string }).deviceModel, "Redmi Book Pro 15");

  // 提交后成员不可再编辑（PENDING 不属于可编辑状态）。
  const blockedEdit = await callRoute(updateRoute, "http://localhost/api/v1/repairs/x", {
    method: "PATCH",
    headers: { cookie: member.cookie },
    body: {
      version: (accepted.json.data as { version: number }).version,
      deviceModel: "再次修改",
    },
    params: { id: draft.id },
  });
  assert.equal(blockedEdit.status, 409);
  assert.equal((blockedEdit.json.error as { code?: string }).code, "REPAIR_STATE_INVALID");
});

dbTest("新建提交即建单（#222）：不产生草稿、提交必填与幂等", async () => {
  const member = await createMember("提交即建单");
  const missing = await callRoute(createRoute, "http://localhost/api/v1/repairs", {
    method: "POST",
    headers: { cookie: member.cookie, "Idempotency-Key": randomUUID() },
    body: await completeDraftFields(),
  });
  assert.equal(missing.status, 400);
  assert.equal((missing.json.error as { code?: string }).code, "REPAIR_SUBMISSION_INCOMPLETE");
  assert.ok(fieldErrorsOf(missing.json).deviceModel, "新建提交同样要求机型");

  const key = randomUUID();
  const fields = await completeDraftFields("  Redmi Book  ");
  const created = await callRoute(createRoute, "http://localhost/api/v1/repairs", {
    method: "POST",
    headers: { cookie: member.cookie, "Idempotency-Key": key },
    body: fields,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const record = created.json.data as {
    id: string;
    status: string;
    deviceModel: string | null;
    submittedAt: string | null;
  };
  assert.equal(record.status, "PENDING", "新建提交直接进入待审核");
  assert.equal(record.deviceModel, "Redmi Book");
  assert.ok(record.submittedAt);

  const retry = await callRoute(createRoute, "http://localhost/api/v1/repairs", {
    method: "POST",
    headers: { cookie: member.cookie, "Idempotency-Key": key },
    body: fields,
  });
  assert.equal((retry.json.data as { id: string }).id, record.id, "同一幂等键返回原记录");
  assert.equal(
    await getDb().repairRecord.count({
      where: { memberProfileId: member.profileId, status: "DRAFT" },
    }),
    0,
    "新建提交不产生草稿",
  );
});

dbTest("新建提交即建单（#222）：同一幂等键并发提交只落一条", async () => {
  const member = await createMember("并发提交");
  const key = randomUUID();
  const fields = await completeDraftFields("并发机型");
  const create = () =>
    callRoute(createRoute, "http://localhost/api/v1/repairs", {
      method: "POST",
      headers: { cookie: member.cookie, "Idempotency-Key": key },
      body: fields,
    });
  const responses = await Promise.all([create(), create(), create()]);
  for (const response of responses) {
    assert.equal(response.status, 201, JSON.stringify(response.json));
  }
  const ids = new Set(responses.map((response) => (response.json.data as { id: string }).id));
  assert.equal(ids.size, 1, "并发请求应复用同一条记录");
  assert.equal(
    await getDb().repairRecord.count({ where: { memberProfileId: member.profileId } }),
    1,
    "同一幂等键不应落出多条记录",
  );
});

dbTest("新建提交即建单（#222）：记录被删除后同键复放返回 409", async () => {
  const member = await createMember("删除复放");
  const key = randomUUID();
  const fields = await completeDraftFields("删除复放机型");
  const create = () =>
    callRoute(createRoute, "http://localhost/api/v1/repairs", {
      method: "POST",
      headers: { cookie: member.cookie, "Idempotency-Key": key },
      body: fields,
    });
  const created = await create();
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const recordId = (created.json.data as { id: string }).id;
  await getDb().repairRecord.update({
    where: { id: recordId },
    data: { deletedAt: new Date() },
  });

  const retry = await create();
  assert.equal(retry.status, 409);
  assert.equal((retry.json.error as { code?: string }).code, "REPAIR_STATE_INVALID");
  assert.equal(
    await getDb().repairRecord.count({ where: { createRequestKey: key } }),
    1,
    "复放不应再建一条记录",
  );
});
