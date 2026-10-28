import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { repairActivityService } from "../../src/features/repair-activities/repair-activity-service";
import { AppError } from "../../src/lib/api/errors";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import type { PublicRequestContext } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";

const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;
const PREFIX = "RACE262 ";
const HOUR = 60 * 60 * 1000;

const context: PublicRequestContext = {
  requestId: "req_race262",
  ipAddress: "127.0.0.1",
  userAgent: "integration-race262",
};

async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  const activities = await db.repairActivity.findMany({
    where: { title: { startsWith: PREFIX } },
    select: { id: true },
  });
  const activityIds = activities.map((row) => row.id);
  if (activityIds.length === 0) return;
  const registrations = await db.repairActivityRegistration.findMany({
    where: { activityId: { in: activityIds } },
    select: { id: true },
  });
  const registrationIds = registrations.map((row) => row.id);
  await db.auditLog.deleteMany({
    where: { targetType: "RepairActivityRegistration", targetId: { in: registrationIds } },
  });
  await db.repairActivityRegistration.deleteMany({ where: { activityId: { in: activityIds } } });
  await db.repairActivity.deleteMany({ where: { id: { in: activityIds } } });
}

async function createActivity(capacity: number): Promise<string> {
  const now = new Date();
  const id = randomUUID();
  await getDb().repairActivity.create({
    data: {
      id,
      title: `${PREFIX}${capacity} 人场`,
      capacity,
      activityAt: new Date(now.getTime() + 7 * 24 * HOUR),
      signupOpensAt: new Date(now.getTime() - HOUR),
      signupClosesAt: new Date(now.getTime() + HOUR),
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}

async function createEndedActivity(capacity: number): Promise<string> {
  const now = new Date();
  const id = randomUUID();
  const activityAt = new Date(now.getTime() - 48 * HOUR);
  await getDb().repairActivity.create({
    data: {
      id,
      title: `${PREFIX}已结束${capacity} 人场`,
      capacity,
      activityAt,
      signupOpensAt: new Date(activityAt.getTime() - 2 * HOUR),
      signupClosesAt: new Date(activityAt.getTime() - HOUR),
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}

async function createWindowActivity(
  capacity: number,
  label: string,
  window: { activityAt: Date; signupOpensAt: Date; signupClosesAt: Date },
): Promise<string> {
  const now = new Date();
  const id = randomUUID();
  await getDb().repairActivity.create({
    data: {
      id,
      title: `${PREFIX}${label}${capacity} 人场`,
      capacity,
      activityAt: window.activityAt,
      signupOpensAt: window.signupOpensAt,
      signupClosesAt: window.signupClosesAt,
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}

async function seedRegistration(activityId: string, phone: string, name: string): Promise<void> {
  const now = new Date();
  await getDb().repairActivityRegistration.create({
    data: {
      id: randomUUID(),
      activityId,
      name,
      phone,
      phoneLast4: phone.slice(-4),
      issueType: "CLEAN_ONLY",
      status: "REGISTERED",
      consentAcceptedAt: now,
      createdAt: now,
    },
  });
}

function registerInput(phone: string, name: string) {
  return {
    name,
    phone,
    issueType: "CLEAN_ONLY",
    consentAccepted: true,
  };
}

function assertCode(error: unknown, code: string): boolean {
  return error instanceof AppError && error.code === code;
}

async function activeRows(activityId: string) {
  return getDb().repairActivityRegistration.findMany({
    where: { activityId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, phone: true, name: true },
  });
}

beforeEach(async () => {
  if (!enabled) return;
  await cleanupFixtures();
});

after(async () => {
  if (!enabled) return;
  try {
    await cleanupFixtures();
  } finally {
    await disconnectDb();
  }
});

dbTest("同手机号并发报名只落一条，其余返回重复", async () => {
  const activityId = await createActivity(10);
  const phone = "13800000001";
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      repairActivityService.register(activityId, registerInput(phone, `竞态客户${index}`), context),
    ),
  );
  const successes = results.filter((result) => result.status === "fulfilled");
  const duplicates = results.filter(
    (result) =>
      result.status === "rejected" && assertCode(result.reason, "ACTIVITY_REGISTRATION_DUPLICATE"),
  );
  assert.equal(successes.length, 1, "同一手机号并发报名只能成功一次");
  assert.equal(duplicates.length, 4, "其余请求应明确返回重复");
  const rows = await activeRows(activityId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.phone, phone);
  assert.equal(rows[0]!.id, (successes[0] as PromiseFulfilledResult<{ id: string }>).value.id);
});

dbTest("容量 1 时不同手机号并发报名不会超卖", async () => {
  const activityId = await createActivity(1);
  const results = await Promise.allSettled([
    repairActivityService.register(activityId, registerInput("13800000002", "竞态甲"), context),
    repairActivityService.register(activityId, registerInput("13800000003", "竞态乙"), context),
  ]);
  const successes = results.filter((result) => result.status === "fulfilled");
  const full = results.filter(
    (result) => result.status === "rejected" && assertCode(result.reason, "ACTIVITY_FULL"),
  );
  assert.equal(successes.length, 1);
  assert.equal(full.length, 1);
  const rows = await activeRows(activityId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, (successes[0] as PromiseFulfilledResult<{ id: string }>).value.id);
});

dbTest("容量 2 时 5 人并发报名只成功两名", async () => {
  const activityId = await createActivity(2);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      repairActivityService.register(
        activityId,
        registerInput(`1380000001${index}`, `并发客户${index}`),
        context,
      ),
    ),
  );
  const successes = results.filter((result) => result.status === "fulfilled");
  const full = results.filter(
    (result) => result.status === "rejected" && assertCode(result.reason, "ACTIVITY_FULL"),
  );
  assert.equal(successes.length, 2);
  assert.equal(full.length, 3);
  const rows = await activeRows(activityId);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    successes.map((result) => (result as PromiseFulfilledResult<{ id: string }>).value.id).sort(),
    "成功响应必须对应真实落库的记录",
  );
});

dbTest("满额后同一手机号再次提交返回重复而不是满额", async () => {
  const activityId = await createActivity(1);
  const phone = "13800000004";
  await repairActivityService.register(activityId, registerInput(phone, "已报名客户"), context);
  await assert.rejects(
    () => repairActivityService.register(activityId, registerInput(phone, "已报名客户"), context),
    (error) => assertCode(error, "ACTIVITY_REGISTRATION_DUPLICATE"),
  );
  assert.equal((await activeRows(activityId)).length, 1);
});

dbTest("活动已结束时优先返回结束而不是重复", async () => {
  const activityId = await createEndedActivity(1);
  const phone = "13800000005";
  const now = new Date();
  await getDb().repairActivityRegistration.create({
    data: {
      id: randomUUID(),
      activityId,
      name: "历史客户",
      phone,
      phoneLast4: phone.slice(-4),
      issueType: "CLEAN_ONLY",
      status: "REGISTERED",
      consentAcceptedAt: now,
      createdAt: now,
    },
  });
  await assert.rejects(
    () => repairActivityService.register(activityId, registerInput(phone, "历史客户"), context),
    (error) => assertCode(error, "ACTIVITY_ENDED"),
  );
});

dbTest("报名尚未开始时不因手机号重复而误报重复", async () => {
  const now = new Date();
  const activityId = await createWindowActivity(1, "未开始", {
    activityAt: new Date(now.getTime() + 48 * HOUR),
    signupOpensAt: new Date(now.getTime() + 2 * HOUR),
    signupClosesAt: new Date(now.getTime() + 24 * HOUR),
  });
  const phone = "13800000006";
  await seedRegistration(activityId, phone, "未开始客户");
  await assert.rejects(
    () => repairActivityService.register(activityId, registerInput(phone, "未开始客户"), context),
    (error) => assertCode(error, "ACTIVITY_NOT_OPEN"),
  );
});

dbTest("报名已截止时不因手机号重复而误报重复", async () => {
  const now = new Date();
  const activityId = await createWindowActivity(1, "已截止", {
    activityAt: new Date(now.getTime() + 24 * HOUR),
    signupOpensAt: new Date(now.getTime() - 24 * HOUR),
    signupClosesAt: new Date(now.getTime() - HOUR),
  });
  const phone = "13800000007";
  await seedRegistration(activityId, phone, "已截止客户");
  await assert.rejects(
    () => repairActivityService.register(activityId, registerInput(phone, "已截止客户"), context),
    (error) => assertCode(error, "ACTIVITY_NOT_OPEN"),
  );
});
