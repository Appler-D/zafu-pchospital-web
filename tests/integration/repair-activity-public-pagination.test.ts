import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { GET as GET_PUBLIC_ACTIVITIES } from "../../src/app/api/v1/repair-activities/route";
import { repairActivityService } from "../../src/features/repair-activities/repair-activity-service";
import { startOfShanghaiDay } from "../../src/lib/academic-term";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { integrationTestsEnabled } from "./db-guard";
import { callRoute } from "./http-harness";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

const TITLE_PREFIX = "PAG286 ";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const UNENDED_A_ID = "a2860000-0000-4000-8000-000000000001";
const UNENDED_B_ID = "a2860000-0000-4000-8000-000000000002";
const ENDED_LATEST_ID = "a2860000-0000-4000-8000-000000000003";
const ENDED_TIE_A_ID = "a2860000-0000-4000-8000-000000000004";
const ENDED_TIE_B_ID = "a2860000-0000-4000-8000-000000000005";
const ENDED_OLDER_ID = "a2860000-0000-4000-8000-000000000006";
const ENDED_OLDEST_ID = "a2860000-0000-4000-8000-000000000007";
const SOFT_DELETED_ID = "a2860000-0000-4000-8000-000000000008";
const FIXTURE_ACTIVITY_IDS = [
  UNENDED_A_ID,
  UNENDED_B_ID,
  ENDED_LATEST_ID,
  ENDED_TIE_A_ID,
  ENDED_TIE_B_ID,
  ENDED_OLDER_ID,
  ENDED_OLDEST_ID,
  SOFT_DELETED_ID,
];

let now = new Date();
let todayStart = startOfShanghaiDay(now);
let baselineActiveCount = 0;

async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  await db.repairActivityRegistration.deleteMany({
    where: { activityId: { in: FIXTURE_ACTIVITY_IDS } },
  });
  await db.repairActivity.deleteMany({
    where: {
      OR: [{ id: { in: FIXTURE_ACTIVITY_IDS } }, { title: { startsWith: TITLE_PREFIX } }],
    },
  });
}

async function createActivity(input: {
  id: string;
  activityAt: Date;
  createdAt: Date;
  deletedAt?: Date | null;
}): Promise<void> {
  await getDb().repairActivity.create({
    data: {
      id: input.id,
      title: `${TITLE_PREFIX}${input.id.slice(-3)}`,
      activityAt: input.activityAt,
      capacity: 10,
      signupOpensAt: new Date(input.activityAt.getTime() - 7 * DAY),
      signupClosesAt: new Date(input.activityAt.getTime() - HOUR),
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
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
      name: "分页测试报名",
      phone: "13800000286",
      phoneLast4: "0286",
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
  const db = getDb();
  baselineActiveCount = await db.repairActivity.count({ where: { deletedAt: null } });

  now = new Date();
  todayStart = startOfShanghaiDay(now);
  const sameUnendedAt = new Date(todayStart.getTime() + 30 * 60 * 1000); // 今天 00:30
  const sameEndedAt = new Date(todayStart.getTime() - 2 * DAY + 10 * HOUR);
  const sharedCreatedAt = new Date(now.getTime() - 7 * DAY);

  await createActivity({
    id: UNENDED_A_ID,
    activityAt: sameUnendedAt,
    createdAt: new Date(now.getTime() - 10 * DAY),
  });
  await createActivity({
    id: UNENDED_B_ID,
    activityAt: sameUnendedAt,
    createdAt: new Date(now.getTime() - 9 * DAY),
  });
  await createActivity({
    id: ENDED_LATEST_ID,
    activityAt: new Date(todayStart.getTime() - 30 * 60 * 1000), // 昨天 23:30
    createdAt: new Date(now.getTime() - 8 * DAY),
  });
  await createActivity({
    id: ENDED_TIE_A_ID,
    activityAt: sameEndedAt,
    createdAt: sharedCreatedAt,
  });
  await createActivity({
    id: ENDED_TIE_B_ID,
    activityAt: sameEndedAt,
    createdAt: sharedCreatedAt,
  });
  await createActivity({
    id: ENDED_OLDER_ID,
    activityAt: new Date(todayStart.getTime() - 5 * DAY),
    createdAt: new Date(now.getTime() - 6 * DAY),
  });
  await createActivity({
    id: ENDED_OLDEST_ID,
    activityAt: new Date(todayStart.getTime() - 10 * DAY),
    createdAt: new Date(now.getTime() - 5 * DAY),
  });
  await createActivity({
    id: SOFT_DELETED_ID,
    activityAt: new Date(todayStart.getTime() + 7 * DAY),
    createdAt: new Date(now.getTime() - 4 * DAY),
    deletedAt: new Date(now.getTime() - DAY),
  });

  for (const status of ["REGISTERED", "REGISTERED", "CHECKED_IN", "SERVED"] as const) {
    await createRegistration({ activityId: UNENDED_A_ID, status });
  }
  await createRegistration({ activityId: UNENDED_A_ID, status: "REGISTERED", deleted: true });
  await createRegistration({ activityId: ENDED_LATEST_ID, status: "REGISTERED" });
  await createRegistration({ activityId: ENDED_LATEST_ID, status: "SERVED", deleted: true });
});

after(async () => {
  if (!enabled) return;
  await cleanupFixtures();
  await disconnectDb();
});

dbTest("公开列表分页：跨未结束/已结束分界、条数上限与越界页", async () => {
  const expectedTotal = baselineActiveCount + 7;
  const all = await repairActivityService.listPublic({ page: 1, pageSize: 100 }, now);
  const ours = all.items.filter((item) => FIXTURE_ACTIVITY_IDS.includes(item.id));

  assert.equal(all.pagination.total, expectedTotal);
  assert.equal(ours.length, 7, "软删活动不应进入公开列表");
  assert.equal(
    ours.some((item) => item.id === SOFT_DELETED_ID),
    false,
  );

  const ourIds = ours.map((item) => item.id);
  assert.ok(ourIds.indexOf(UNENDED_A_ID) < ourIds.indexOf(ENDED_LATEST_ID));
  assert.ok(ourIds.indexOf(UNENDED_B_ID) < ourIds.indexOf(ENDED_LATEST_ID));
  assert.ok(ourIds.indexOf(ENDED_LATEST_ID) < ourIds.indexOf(ENDED_TIE_A_ID));
  assert.ok(ourIds.indexOf(ENDED_TIE_A_ID) < ourIds.indexOf(ENDED_TIE_B_ID));
  assert.ok(ourIds.indexOf(ENDED_TIE_B_ID) < ourIds.indexOf(ENDED_OLDER_ID));

  // 第一页必须恰好是全量顺序的前 4 条；页大小变化后仍从同一稳定顺序切片。
  const firstPage = await repairActivityService.listPublic({ page: 1, pageSize: 4 }, now);
  const secondPage = await repairActivityService.listPublic({ page: 2, pageSize: 4 }, now);
  assert.deepEqual(
    firstPage.items.map((item) => item.id),
    all.items.slice(0, 4).map((item) => item.id),
  );
  assert.deepEqual(
    secondPage.items.map((item) => item.id),
    all.items.slice(4, 8).map((item) => item.id),
  );
  assert.ok(firstPage.items.length <= 4);
  assert.ok(secondPage.items.length <= 4);

  const beyond = await repairActivityService.listPublic(
    { page: Math.ceil(expectedTotal / 4) + 2, pageSize: 4 },
    now,
  );
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.pagination.total, expectedTotal);
  assert.equal(beyond.pagination.totalPages, Math.ceil(expectedTotal / 4));
});

dbTest("公开列表分页：有效报名只聚合当前页，软删报名不计入", async () => {
  const page = await repairActivityService.listPublic({ page: 1, pageSize: 100 }, now);
  const unended = page.items.find((item) => item.id === UNENDED_A_ID);
  const ended = page.items.find((item) => item.id === ENDED_LATEST_ID);
  assert.ok(unended);
  assert.ok(ended);
  assert.equal(unended.registeredCount, 4);
  assert.equal(unended.remaining, 6);
  assert.equal(ended.registeredCount, 1);
});

dbTest("公开列表 API：默认/显式分页、meta.pagination 与非法参数", async () => {
  const total = baselineActiveCount + 7;
  const { status, json } = await callRoute(
    GET_PUBLIC_ACTIVITIES,
    "http://localhost/api/v1/repair-activities?page=1&pageSize=4",
  );
  assert.equal(status, 200);
  assert.equal(json.success, true);
  const data = json.data as Array<{ id: string }>;
  const meta = json.meta as {
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
  assert.ok(data.length <= 4);
  assert.equal(meta.pagination.page, 1);
  assert.equal(meta.pagination.pageSize, 4);
  assert.equal(meta.pagination.total, total);
  assert.equal(meta.pagination.totalPages, Math.ceil(total / 4));

  const defaults = await callRoute(
    GET_PUBLIC_ACTIVITIES,
    "http://localhost/api/v1/repair-activities",
  );
  assert.equal(defaults.status, 200);
  const defaultMeta = defaults.json.meta as {
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
  assert.equal(defaultMeta.pagination.page, 1);
  assert.equal(defaultMeta.pagination.pageSize, 20);
  assert.equal(defaultMeta.pagination.total, total);

  const beyond = await callRoute(
    GET_PUBLIC_ACTIVITIES,
    `http://localhost/api/v1/repair-activities?page=${Math.ceil(total / 4) + 2}&pageSize=4`,
  );
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.json.data, []);
  const beyondMeta = beyond.json.meta as {
    pagination: { total: number; totalPages: number };
  };
  assert.equal(beyondMeta.pagination.total, total);
  assert.equal(beyondMeta.pagination.totalPages, Math.ceil(total / 4));

  for (const query of ["page=0", "pageSize=101", "page=abc", "pageSize=1.5"]) {
    const invalid = await callRoute(
      GET_PUBLIC_ACTIVITIES,
      `http://localhost/api/v1/repair-activities?${query}`,
    );
    assert.equal(invalid.status, 400, query);
    const error = (invalid.json as { error: { code: string } }).error;
    assert.equal(error.code, "VALIDATION_FAILED", query);
  }
});
