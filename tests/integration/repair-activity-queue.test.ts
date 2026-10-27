import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { GET } from "../../src/app/api/v1/repair-activities/[id]/queue/route";
import { repairActivityService } from "../../src/features/repair-activities/repair-activity-service";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { shanghaiToday } from "../../src/lib/shanghai-date";
import { integrationTestsEnabled } from "./db-guard";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;
const activityId = "e2440000-0000-4000-8000-000000000001";
const otherId = "e2440000-0000-4000-8000-000000000002";

async function cleanup() {
  const activityIds = [activityId, otherId];
  await getDb().repairActivityRegistration.deleteMany({
    where: { activityId: { in: activityIds } },
  });
  await getDb().repairActivity.deleteMany({ where: { id: { in: activityIds } } });
}

before(async () => {
  if (!enabled) return;
  await cleanup();
  const now = new Date();
  for (const id of [activityId, otherId]) {
    await getDb().repairActivity.create({
      data: {
        id,
        title: "I244 公开排队测试",
        activityAt: new Date(`${shanghaiToday()}T23:59:00+08:00`),
        signupOpensAt: new Date(now.getTime() - 3_600_000),
        signupClosesAt: new Date(now.getTime() - 60_000),
        capacity: 20,
        createdAt: now,
      },
    });
  }
});
after(async () => {
  if (!enabled) return;
  await cleanup();
  await disconnectDb();
});

dbTest("#244 匿名汇总只计本场有效 CHECKED_IN，公开字段和缓存固定，队列变化立即反映", async () => {
  const ids: string[] = [];
  for (const [id, status, deleted] of [
    [activityId, "REGISTERED", false],
    [activityId, "CHECKED_IN", false],
    [activityId, "CHECKED_IN", false],
    [activityId, "CHECKED_IN", true],
    [activityId, "SERVED", false],
    [otherId, "CHECKED_IN", false],
  ] as const) {
    const registration = await getDb().repairActivityRegistration.create({
      data: {
        id: randomUUID(),
        activityId: id,
        name: "I244 不应公开的姓名",
        phone: "13800000244",
        phoneLast4: "0244",
        issueType: "CLEAN_ONLY",
        status,
        createdAt: new Date(),
        deletedAt: deleted ? new Date() : null,
      },
    });
    ids.push(registration.id);
  }
  const response = await GET(
    new Request(`http://localhost/api/v1/repair-activities/${activityId}/queue`, {
      headers: { "x-request-id": "req_i244_queue" },
    }),
    { params: Promise.resolve({ id: activityId }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.meta.requestId, "req_i244_queue");
  assert.deepEqual(Object.keys(body.data).sort(), ["observedAt", "waitingCount"]);
  assert.equal(body.data.waitingCount, 2);
  assert.ok(Number.isFinite(Date.parse(body.data.observedAt)));
  assert.equal(JSON.stringify(body).includes("13800000244"), false);
  assert.equal(JSON.stringify(body).includes("不应公开的姓名"), false);
  // 状态写入的事务语义由原接待台覆盖；这里钉住公开查询不是持久化的第二套计数。
  await getDb().repairActivityRegistration.update({
    where: { id: ids[1] },
    data: { status: "SERVED" },
  });
  assert.equal((await repairActivityService.getPublicQueue(activityId)).waitingCount, 1);
  await getDb().repairActivityRegistration.update({
    where: { id: ids[2] },
    data: { status: "REGISTERED" },
  });
  assert.equal((await repairActivityService.getPublicQueue(activityId)).waitingCount, 0);
});

dbTest("#244 未开放为 null，已结束/软删/不存在沿用错误，不能冒充空队列", async () => {
  const db = getDb();
  await db.repairActivity.update({
    where: { id: activityId },
    data: { signupClosesAt: new Date(Date.now() + 3_600_000) },
  });
  assert.equal((await repairActivityService.getPublicQueue(activityId)).waitingCount, null);
  await db.repairActivity.update({
    where: { id: activityId },
    data: { activityAt: new Date("2020-01-01T10:00:00Z") },
  });
  const ended = await GET(new Request("http://localhost/queue"), {
    params: Promise.resolve({ id: activityId }),
  });
  assert.equal(ended.status, 404);
  assert.equal((await ended.json()).error.code, "ACTIVITY_ENDED");
  await db.repairActivity.update({ where: { id: activityId }, data: { deletedAt: new Date() } });
  for (const id of [activityId, randomUUID()]) {
    await assert.rejects(repairActivityService.getPublicQueue(id), { code: "ACTIVITY_NOT_FOUND" });
  }
});
