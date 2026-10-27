import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { GET as GET_ADMIN_ACTIVITIES } from "../../src/app/api/v1/admin/repair-activities/route";
import { repairActivityService } from "../../src/features/repair-activities/repair-activity-service";
import { repairActivityStaffService } from "../../src/features/repair-activities/repair-activity-staff-service";
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
 * 活动管理页「出勤」列的真实库验证。
 *
 * 单测（`tests/unit/repair-activity-attendance-count.test.ts`）钉住源码接线；
 * 这里验证**行为**：出勤人数是不是真的随 `markAttendance` 变化、是否按活动隔离、
 * create / update 的响应是否同口径、以及公开视图绝不带上这个字段。
 * 夹具一律走独立 UUID 段 `e7700000-…` 与标题前缀 "REG107 "，清理按这两者限定。
 */
const ADMIN_USER_ID = "e7700000-0000-4000-8000-000000000001";
const STAFF_USER_ID = "e7700000-0000-4000-8000-000000000002";
const STAFF_PROFILE_ID = "e7700000-0000-4000-8000-000000000003";
const ATTEND_ACTIVITY_ID = "e7700000-0000-4000-8000-000000000004";
const OTHER_ACTIVITY_ID = "e7700000-0000-4000-8000-000000000005";
const FIXTURE_ACTIVITY_IDS = [ATTEND_ACTIVITY_ID, OTHER_ACTIVITY_ID];
const FIXTURE_USER_IDS = [ADMIN_USER_ID, STAFF_USER_ID];
const FIXTURE_PROFILE_IDS = [STAFF_PROFILE_ID];
const TITLE_PREFIX = "REG107 ";
const ADMIN_LIST_URL = "http://localhost/api/v1/admin/repair-activities";
const HOUR = 60 * 60 * 1000;

const adminActor: AuthorizedActor = {
  actorType: "USER",
  userId: ADMIN_USER_ID,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_reg107_admin",
};

/** 接待员 actor：`markAttendance` 要求「用户 ↔ ACTIVE 成员档案」与 `activity:staff`。 */
const staffActor: AuthorizedActor = {
  actorType: "USER",
  userId: STAFF_USER_ID,
  userStatus: "ACTIVE",
  permissions: permissionsForRoles(["ADMIN"]),
  requestId: "req_reg107_staff",
};

let adminCookie = "";

/** 本文件产生的活动 = 固定 ID 两场 + create 用例动态建的所有 "REG107 " 前缀活动。 */
async function fixtureActivityIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.repairActivity.findMany({
    // 注意：`OR` 数组里必须是**两个独立对象**；写进同一个对象会变成 AND，动态建的
    // 活动（随机 UUID）就漏删，残留出勤行会在删成员档案时撞外键。
    where: { OR: [{ id: { in: FIXTURE_ACTIVITY_IDS } }, { title: { startsWith: TITLE_PREFIX } }] },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * 清理顺序由外键决定：审计（RESTRICT 子表）→ 报名 / 出勤 → 活动 → 成员档案 →
 * 会话 / 凭据 / 角色 → 用户。与 board 测试同一套纪律，绝不触碰非本前缀数据。
 */
async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  const activityIds = await fixtureActivityIds();
  if (activityIds.length > 0) {
    const attendanceIds = (
      await db.repairActivityAttendance.findMany({
        where: { activityId: { in: activityIds } },
        select: { id: true },
      })
    ).map((row) => row.id);
    if (attendanceIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { targetType: "RepairActivityAttendance", targetId: { in: attendanceIds } },
      });
    }
  await db.repairActivityAttendance.deleteMany({ where: { activityId: { in: activityIds } } });
  // 安全网：按成员档案再清一次出勤行，避免任何漏网活动让下一步删档案撞外键。
  await db.repairActivityAttendance.deleteMany({
    where: { memberProfileId: { in: FIXTURE_PROFILE_IDS } },
  });
  await db.repairActivity.deleteMany({ where: { id: { in: activityIds } } });
  }
  await db.auditLog.deleteMany({ where: { actorUserId: { in: FIXTURE_USER_IDS } } });
  await db.memberProfile.deleteMany({ where: { id: { in: FIXTURE_PROFILE_IDS } } });
  await db.authSession.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.userRole.deleteMany({ where: { userId: { in: FIXTURE_USER_IDS } } });
  await db.user.deleteMany({ where: { id: { in: FIXTURE_USER_IDS } } });
}

async function prepareFixtures(): Promise<void> {
  await cleanupFixtures();
  const db = getDb();
  const now = new Date();
  for (const [userId, displayName] of [
    [ADMIN_USER_ID, "REG107 管理员"],
    [STAFF_USER_ID, "REG107 接待员"],
  ] as const) {
    await db.user.create({
      data: { id: userId, status: "ACTIVE", displayName, createdAt: now, updatedAt: now },
    });
  }
  await db.memberProfile.create({
    data: {
      id: STAFF_PROFILE_ID,
      userId: STAFF_USER_ID,
      realName: "REG107 接待员",
      status: "ACTIVE",
      joinedAt: now,
      createdAt: now,
    },
  });
  for (const [id, title] of [
    [ATTEND_ACTIVITY_ID, `${TITLE_PREFIX}出勤主场`],
    [OTHER_ACTIVITY_ID, `${TITLE_PREFIX}隔离场`],
  ] as const) {
    await db.repairActivity.create({
      data: {
        id,
        title,
        activityAt: new Date(now.getTime() + 7 * 24 * HOUR),
        capacity: 100,
        signupOpensAt: new Date(now.getTime() - HOUR),
        signupClosesAt: new Date(now.getTime() - HOUR / 2),
        createdAt: now,
        updatedAt: now,
      },
    });
  }
}

/** 管理端列表信封 → 找到指定活动那一行。 */
async function adminRow(activityId: string): Promise<Record<string, unknown>> {
  const { status, json } = await callRoute(GET_ADMIN_ACTIVITIES, ADMIN_LIST_URL, {
    headers: { cookie: adminCookie },
  });
  assert.equal(status, 200);
  const items = json.data as Array<Record<string, unknown>>;
  const row = items.find((item) => item.id === activityId);
  assert.ok(row, `管理端列表应包含活动 ${activityId}`);
  return row as Record<string, unknown>;
}

before(async () => {
  if (!enabled) return;
  await prepareFixtures();
  adminCookie = await sessionCookie(ADMIN_USER_ID, "ADMIN");
});

after(async () => {
  if (!enabled) return;
  // 清理失败也必须断开连接：mariadb 连接池会保活事件循环，进程将永远不退出
  // （2026-10-13 实测挂死 10 分钟的教训）。
  try {
    await cleanupFixtures();
  } finally {
    await disconnectDb();
  }
});

dbTest("无出勤时管理端列表 attendedCount 为 0，且只回计数不下发明细", async () => {
  const row = await adminRow(ATTEND_ACTIVITY_ID);
  const actual = await getDb().repairActivityAttendance.count({
    where: { activityId: ATTEND_ACTIVITY_ID },
  });
  assert.equal(actual, 0);
  assert.equal(row.attendedCount, actual);
  // 出勤成员身份字段不得进管理端列表响应
  assert.equal("memberProfileId" in row, false);
  assert.equal("checkedInAt" in row, false);
});

dbTest("成员出勤后 attendedCount 变 1，计数按活动隔离", async () => {
  const marked = await repairActivityStaffService.markAttendance(ATTEND_ACTIVITY_ID, staffActor);
  assert.equal(marked.attended, true);

  const row = await adminRow(ATTEND_ACTIVITY_ID);
  assert.equal(row.attendedCount, 1);
  const actual = await getDb().repairActivityAttendance.count({
    where: { activityId: ATTEND_ACTIVITY_ID },
  });
  assert.equal(row.attendedCount, actual);

  const other = await adminRow(OTHER_ACTIVITY_ID);
  assert.equal(other.attendedCount, 0);
});

dbTest("create / update 响应同口径带回 attendedCount", async () => {
  const now = new Date();
  const created = await repairActivityService.create(
    {
      title: `${TITLE_PREFIX}计数新建`,
      capacity: 10,
      activityAt: new Date(now.getTime() + 7 * 24 * HOUR),
      signupOpensAt: new Date(now.getTime() - HOUR),
      signupClosesAt: new Date(now.getTime() - HOUR / 2),
    },
    adminActor,
  );
  assert.equal(created.attendedCount, 0);

  await repairActivityStaffService.markAttendance(created.id, staffActor);
  // 编辑响应必须是事务内实时计数，不能沿用加载时的旧值
  const updated = await repairActivityService.update(
    created.id,
    { title: `${TITLE_PREFIX}计数编辑` },
    adminActor,
  );
  assert.equal(updated.attendedCount, 1);
});

dbTest("公开列表不包含 attendedCount", async () => {
  const items = await repairActivityService.listPublic();
  assert.ok(items.length > 0, "公开列表应有活动");
  for (const item of items) {
    assert.equal("attendedCount" in (item as unknown as Record<string, unknown>), false);
  }
});
