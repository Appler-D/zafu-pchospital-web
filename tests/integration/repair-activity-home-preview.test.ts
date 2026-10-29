import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { repairActivityService } from "../../src/features/repair-activities/repair-activity-service";
import { startOfShanghaiDay } from "../../src/lib/academic-term";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { integrationTestsEnabled } from "./db-guard";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

const TITLE_PREFIX = "PREV288 ";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const OPEN_EARLY_ID = "b2880000-0000-4000-8000-000000000001";
const OPEN_LATE_ID = "b2880000-0000-4000-8000-000000000002";
const UPCOMING_ID = "b2880000-0000-4000-8000-000000000003";
const FULL_ID = "b2880000-0000-4000-8000-000000000004";
const CLOSED_ID = "b2880000-0000-4000-8000-000000000005";
const ENDED_ID = "b2880000-0000-4000-8000-000000000006";
const SOFT_DELETED_ID = "b2880000-0000-4000-8000-000000000007";
const FIXTURE_IDS = [
  OPEN_EARLY_ID,
  OPEN_LATE_ID,
  UPCOMING_ID,
  FULL_ID,
  CLOSED_ID,
  ENDED_ID,
  SOFT_DELETED_ID,
];

let now = new Date();
let baselineNonEnded = 0;

async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  await db.repairActivityRegistration.deleteMany({
    where: { activityId: { in: FIXTURE_IDS } },
  });
  await db.repairActivity.deleteMany({
    where: { OR: [{ id: { in: FIXTURE_IDS } }, { title: { startsWith: TITLE_PREFIX } }] },
  });
}

async function createActivity(input: {
  id: string;
  activityAt: Date;
  signupOpensAt: Date;
  signupClosesAt: Date;
  capacity?: number;
  deletedAt?: Date | null;
}): Promise<void> {
  const createdAt = new Date(now.getTime() - 10 * DAY);
  await getDb().repairActivity.create({
    data: {
      id: input.id,
      title: `${TITLE_PREFIX}${input.id.slice(-3)}`,
      activityAt: input.activityAt,
      capacity: input.capacity ?? 10,
      signupOpensAt: input.signupOpensAt,
      signupClosesAt: input.signupClosesAt,
      createdAt,
      updatedAt: createdAt,
      deletedAt: input.deletedAt ?? null,
    },
  });
}

async function createRegistration(input: {
  activityId: string;
  status: "REGISTERED" | "CHECKED_IN" | "SERVED";
  deleted?: boolean;
}): Promise<void> {
  const createdAt = new Date(now.getTime() - DAY);
  await getDb().repairActivityRegistration.create({
    data: {
      id: randomUUID(),
      activityId: input.activityId,
      name: "首页预览测试报名",
      phone: "13800000288",
      phoneLast4: "0288",
      issueType: "CLEAN_ONLY",
      status: input.status,
      createdAt,
      updatedAt: createdAt,
      deletedAt: input.deleted ? createdAt : null,
    },
  });
}

before(async () => {
  if (!enabled) return;
  await cleanupFixtures();
  now = new Date();
  const db = getDb();
  baselineNonEnded = await db.repairActivity.count({
    where: { deletedAt: null, activityAt: { gte: startOfShanghaiDay(now) } },
  });

  await createActivity({
    id: OPEN_EARLY_ID,
    activityAt: new Date(now.getTime() + 2 * DAY),
    signupOpensAt: new Date(now.getTime() - DAY),
    signupClosesAt: new Date(now.getTime() + DAY),
  });
  await createActivity({
    id: OPEN_LATE_ID,
    activityAt: new Date(now.getTime() + 5 * DAY),
    signupOpensAt: new Date(now.getTime() - DAY),
    signupClosesAt: new Date(now.getTime() + DAY),
  });
  await createActivity({
    id: UPCOMING_ID,
    activityAt: new Date(now.getTime() + DAY),
    signupOpensAt: new Date(now.getTime() + HOUR),
    signupClosesAt: new Date(now.getTime() + 2 * HOUR),
  });
  await createActivity({
    id: FULL_ID,
    activityAt: new Date(now.getTime() + 3 * DAY),
    signupOpensAt: new Date(now.getTime() - DAY),
    signupClosesAt: new Date(now.getTime() + DAY),
    capacity: 1,
  });
  await createActivity({
    id: CLOSED_ID,
    activityAt: new Date(now.getTime() + 4 * DAY),
    signupOpensAt: new Date(now.getTime() - 2 * DAY),
    signupClosesAt: new Date(now.getTime() - HOUR),
  });
  await createActivity({
    id: ENDED_ID,
    activityAt: new Date(startOfShanghaiDay(now).getTime() - HOUR),
    signupOpensAt: new Date(now.getTime() - 3 * DAY),
    signupClosesAt: new Date(now.getTime() - 2 * DAY),
  });
  await createActivity({
    id: SOFT_DELETED_ID,
    activityAt: new Date(now.getTime() + 2 * DAY),
    signupOpensAt: new Date(now.getTime() - DAY),
    signupClosesAt: new Date(now.getTime() + DAY),
    deletedAt: new Date(now.getTime() - HOUR),
  });

  // FULL 的有效报名 1 条；再来一条已软删的，确认不计入。
  await createRegistration({ activityId: FULL_ID, status: "REGISTERED" });
  await createRegistration({ activityId: FULL_ID, status: "REGISTERED", deleted: true });
});

after(async () => {
  if (!enabled) return;
  await cleanupFixtures();
  await disconnectDb();
});

dbTest("首页预览：只返回未结束活动，按 OPEN → UPCOMING → FULL → CLOSED 排序", async () => {
  const items = await repairActivityService.listPublicForHomePreview(100, now);
  const ids = items.map((item) => item.id);

  assert.equal(ids.includes(ENDED_ID), false, "已结束活动不应进入首页预览");
  assert.equal(ids.includes(SOFT_DELETED_ID), false, "软删活动不应进入首页预览");

  // OPEN 优先于 activityAt 更早的 UPCOMING；同档（两条 OPEN）按 activityAt 升序。
  const ours = ids.filter((id) => FIXTURE_IDS.includes(id));
  assert.deepEqual(ours, [OPEN_EARLY_ID, OPEN_LATE_ID, UPCOMING_ID, FULL_ID, CLOSED_ID]);

  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get(OPEN_EARLY_ID)?.status, "OPEN");
  assert.equal(byId.get(UPCOMING_ID)?.status, "UPCOMING");
  assert.equal(byId.get(FULL_ID)?.status, "FULL");
  assert.equal(byId.get(CLOSED_ID)?.status, "CLOSED");
  assert.equal(byId.get(FULL_ID)?.registeredCount, 1);
  assert.equal(byId.get(FULL_ID)?.remaining, 0);
});

dbTest("首页预览：limit 与无未结束活动时的空结果", async () => {
  const limited = await repairActivityService.listPublicForHomePreview(3, now);
  assert.ok(limited.length <= 3);
  if (baselineNonEnded === 0) {
    assert.deepEqual(
      limited.map((item) => item.id),
      [OPEN_EARLY_ID, OPEN_LATE_ID, UPCOMING_ID],
    );
  }

  const defaultLimit = await repairActivityService.listPublicForHomePreview(undefined, now);
  assert.ok(defaultLimit.length <= 3);

  // 30 天后：所有夹具活动都已结束，只验证夹具没有被首页查询带出来。
  const future = new Date(now.getTime() + 30 * DAY);
  const empty = await repairActivityService.listPublicForHomePreview(10, future);
  assert.equal(
    empty.some((item) => FIXTURE_IDS.includes(item.id)),
    false,
  );
});
