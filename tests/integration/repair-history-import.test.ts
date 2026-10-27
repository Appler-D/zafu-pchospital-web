import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { AppError } from "../../src/lib/api/errors";
import { inviteCodeService } from "../../src/features/invitations/invite-code-service";
import { memberService } from "../../src/features/members/member-service";
import {
  classifyHistoryRows,
  type HistoryInputRow,
} from "../../src/features/repairs/repair-history-import";
import {
  applyHistoryImport,
  claimHistoryForNewMember,
  storePendingHistory,
} from "../../src/features/repairs/repair-history-import-service";
import type { AuthorizedActor } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";

/* 集成测试的统一闸门：指向非测试库时**在加载阶段就抛错**。 */
const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

/**
 * 历史修机数据导入的落库通道集成测试（）。
 *
 * 单测只覆盖 `classifyHistoryRows` 纯逻辑；「直接落 APPROVED」「三条 history_import
 * timeline」「审计行」「行指纹重复导入跳过」必须打到真库才测得出来。
 *
 * 独立 UUID 段 `e7200000-…` 与姓名前缀 "HZ"（姓名里不带空格：一格多人按空白分词），
 * 清理只按这两者限定。
 */
const ADMIN_USER_ID = "e7200000-0000-4000-8000-000000000001";
const MEMBER_PROFILE_ID = "e7200000-0000-4000-8000-000000000002";
const CATEGORY_ID = "e7200000-0000-4000-8000-000000000003";
const MEMBER_USER_ID = "e7200000-0000-4000-8000-000000000004";
/** 暂存行的来源文件名：清理按它兜底 —— 姓名可能被班级前缀剥离规则改写，前缀不可靠。 */
const FIXTURE_SOURCE_FILE = "e72-fixture.xlsx";

function adminActor(): AuthorizedActor {
  return {
    actorType: "USER",
    userId: ADMIN_USER_ID,
    userStatus: "ACTIVE",
    permissions: permissionsForRoles(["ADMIN"]),
    requestId: "req_h72_admin",
  };
}

async function cleanupFixtures(): Promise<void> {
  await cleanupClaimArtifacts();
  const db = getDb();
  const records = await db.repairRecord.findMany({
    where: { memberProfileId: MEMBER_PROFILE_ID },
    select: { id: true },
  });
  const recordIds = records.map((row) => row.id);
  if (recordIds.length > 0) {
    await db.repairTimelineEvent.deleteMany({ where: { repairRecordId: { in: recordIds } } });
    await db.auditLog.deleteMany({
      where: { targetType: "RepairRecord", targetId: { in: recordIds } },
    });
    // 参与行先于记录删除（导入记录都带创建人参与行，RESTRICT 会挡住）。
    await db.repairRecordParticipant.deleteMany({ where: { repairRecordId: { in: recordIds } } });
    await db.repairRecord.deleteMany({ where: { id: { in: recordIds } } });
  }
  await db.auditLog.deleteMany({ where: { actorUserId: ADMIN_USER_ID } });
  await db.memberProfile.deleteMany({ where: { id: MEMBER_PROFILE_ID } });
  await db.user.deleteMany({ where: { id: { in: [ADMIN_USER_ID, MEMBER_USER_ID] } } });
  await db.repairCategory.deleteMany({ where: { id: CATEGORY_ID } });
}

/**
 * 清理「暂存 → 注册后自动认领」链路产生的全部行。
 *
 * 认领测试会通过真实注册流程（邀请码 / 管理端新增）建出档案与用户，id 是随机的；
 * 这些成员一律以姓名前缀 "HZ" 命名，清理按前缀限定并严格按外键顺序删
 * （审计 → 记录/时间线 → 兑换/发放 → 用户侧行 → 档案 → 用户）。
 */
async function cleanupClaimArtifacts(): Promise<void> {
  const db = getDb();
  const profiles = await db.memberProfile.findMany({
    where: { realName: { startsWith: "HZ" }, id: { not: MEMBER_PROFILE_ID } },
    select: { id: true, userId: true },
  });
  const profileIds = profiles.map((profile) => profile.id);
  const userIds = profiles.map((profile) => profile.userId);
  const pendings = await db.repairHistoryPending.findMany({
    where: {
      OR: [{ realName: { startsWith: "HZ" } }, { sourceFile: FIXTURE_SOURCE_FILE }],
    },
    select: { id: true, createdRecordId: true },
  });
  const ownRecords = profileIds.length
    ? await db.repairRecord.findMany({
        where: { memberProfileId: { in: profileIds } },
        select: { id: true },
      })
    : [];
  const recordIds = [
    ...new Set([
      ...ownRecords.map((row) => row.id),
      ...pendings.flatMap((row) => (row.createdRecordId ? [row.createdRecordId] : [])),
    ]),
  ];
  if (recordIds.length > 0) {
    await db.repairTimelineEvent.deleteMany({ where: { repairRecordId: { in: recordIds } } });
    await db.auditLog.deleteMany({
      where: { targetType: "RepairRecord", targetId: { in: recordIds } },
    });
    await db.repairRecordParticipant.deleteMany({ where: { repairRecordId: { in: recordIds } } });
    await db.repairRecord.deleteMany({ where: { id: { in: recordIds } } });
  }
  if (profileIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { targetType: "MemberProfile", targetId: { in: profileIds } },
    });
  }
  await db.repairHistoryPending.deleteMany({
    where: { id: { in: pendings.map((row) => row.id) } },
  });
  // 邀请码注册链路：本文件的邀请码都以 ADMIN_USER_ID 为创建者。
  await db.auditLog.deleteMany({
    where: {
      action: { in: ["member.history_claimed", "repair.history_pending_imported"] },
    },
  });
  // 新旧成员自己当 actor 的审计（invite.code.redeemed 等）同样要清，
  // 否则 audit_logs.actor_user_id 的 RESTRICT 外键会挡住下面删用户。
  if (userIds.length > 0) {
    await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  }
  const codes = await db.inviteCode.findMany({
    where: { createdByUserId: ADMIN_USER_ID },
    select: { id: true },
  });
  const codeIds = codes.map((code) => code.id);
  const redemptions = codeIds.length
    ? await db.inviteCodeRedemption.findMany({
        where: { inviteCodeId: { in: codeIds } },
        select: { id: true },
      })
    : [];
  const redemptionIds = redemptions.map((redemption) => redemption.id);
  // 建档通道各留一条 account_provisions：邀请码兑换按 sourceId 能找到，
  // 管理端新增是 ADMIN_CREATED —— 统一按档案 / 用户反查删，否则 RESTRICT 外键挡住档案删除。
  if (profileIds.length > 0 || userIds.length > 0) {
    await db.accountProvision.deleteMany({
      where: {
        OR: [{ memberProfileId: { in: profileIds } }, { userId: { in: userIds } }],
      },
    });
  }
  if (redemptionIds.length > 0) {
    await db.inviteCodeRedemption.deleteMany({ where: { id: { in: redemptionIds } } });
  }
  if (codeIds.length > 0) await db.inviteCode.deleteMany({ where: { id: { in: codeIds } } });
  if (userIds.length > 0) {
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userSkill.deleteMany({ where: { memberProfileId: { in: profileIds } } });
    await db.passwordCredential.deleteMany({ where: { userId: { in: userIds } } });
    await db.userIdentity.deleteMany({ where: { userId: { in: userIds } } });
  }
  await db.memberProfile.deleteMany({ where: { id: { in: profileIds } } });
  if (userIds.length > 0) await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function prepareFixtures(): Promise<void> {
  await cleanupFixtures();
  const db = getDb();
  const now = new Date();
  await db.user.create({
    data: {
      id: ADMIN_USER_ID,
      status: "ACTIVE",
      displayName: "HZ 导入管理员",
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.user.create({
    data: {
      id: MEMBER_USER_ID,
      status: "ACTIVE",
      displayName: "HZ 导入成员",
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.memberProfile.create({
    data: {
      id: MEMBER_PROFILE_ID,
      userId: MEMBER_USER_ID,
      realName: "HZ张三",
      status: "ACTIVE",
      joinedAt: now,
      createdAt: now,
    },
  });
  await db.repairCategory.create({
    data: {
      id: CATEGORY_ID,
      code: "HZ_TEST",
      name: "HZ 测试分类",
      sortOrder: 99,
      createdAt: now,
    },
  });
  // 认领测试要走真实注册链路（邀请码 / 管理端新增），两条都要发 MEMBER 角色：
  // upsert 不删除共享 seed（与 m0 的约定一致）。
  await db.role.upsert({
    where: { code: "MEMBER" },
    update: { name: "成员" },
    create: { id: randomUUID(), code: "MEMBER", name: "成员", createdAt: now },
  });
}

/** 行指纹含内容，用例之间用 `contentSuffix` 区分，避免互相命中彼此的幂等键。 */
function inputRows(contentSuffix = ""): HistoryInputRow[] {
  return [
    {
      lineNo: 2,
      raw: {
        name: "HZ张三",
        repairDate: "2025-06-01",
        durationMinutes: "45",
        categoryName: "HZ 测试分类",
        content: `清理灰尘并更换硅脂。${contentSuffix}`,
      },
    },
    {
      lineNo: 3,
      raw: {
        name: "查无此人",
        repairDate: "2025-06-02",
        durationMinutes: "30",
        categoryName: "HZ 测试分类",
        content: "重装系统。",
      },
    },
  ];
}

before(async () => {
  if (!enabled) return;
  await prepareFixtures();
});

after(async () => {
  if (!enabled) return;
  // 清理抛错也必须断开连接池：否则子进程带着 Pool 连接不退出，整轮 test:db 会永远挂住
  // （2026-09-29 实际发生过一次：account_provisions 的 RESTRICT 外键让删除档案失败）。
  try {
    await cleanupFixtures();
  } finally {
    await disconnectDb();
  }
});

dbTest("导入直接落 APPROVED，写齐 timeline 与审计；重名拒收行不落库", async () => {
  const db = getDb();
  const plan = classifyHistoryRows(inputRows(), {
    members: [{ profileId: MEMBER_PROFILE_ID, realName: "HZ张三" }],
    categories: [{ id: CATEGORY_ID, name: "HZ 测试分类", isActive: true }],
    today: new Date().toISOString().slice(0, 10),
  });
  assert.equal(plan.valid.length, 1);
  assert.equal(plan.rejected[0]?.reason, "未找到在册成员：查无此人");

  const result = await applyHistoryImport(plan.valid, adminActor());
  assert.deepEqual(result, { inserted: 1, skipped: 0 });

  const record = await db.repairRecord.findUniqueOrThrow({
    where: { createRequestKey: plan.valid[0]!.idempotencyKey },
  });
  assert.equal(record.status, "APPROVED");
  assert.equal(record.memberProfileId, MEMBER_PROFILE_ID);
  assert.equal(record.categoryId, CATEGORY_ID);
  assert.equal(record.durationMinutes, 45);
  assert.equal(record.deletedAt, null);
  // 导入记录同样落创建人参与行（不变量）：导入按「匹配到的成员」当创建人。
  assert.deepEqual(
    await db.repairRecordParticipant.findMany({
      where: { repairRecordId: record.id },
      select: { memberProfileId: true, sortOrder: true },
    }),
    [{ memberProfileId: MEMBER_PROFILE_ID, sortOrder: 0 }],
  );
  const events = await db.repairTimelineEvent.findMany({
    where: { repairRecordId: record.id },
    orderBy: { createdAt: "asc" },
  });
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["CREATED", "SUBMITTED", "APPROVED"],
  );
  assert.ok(
    events.every((event) => (event.summary as { source?: string }).source === "history_import"),
  );
  const audit = await db.auditLog.findFirst({
    where: { action: "repair.history_imported", targetId: record.id },
  });
  assert.ok(audit, "导入应留下 repair.history_imported 审计");

  assert.equal(await db.repairRecord.count({ where: { content: "重装系统。" } }), 0);
});

dbTest("同一批行重复导入只跳过不重复入库", async () => {
  const db = getDb();
  const plan = classifyHistoryRows(inputRows("（幂等用例）"), {
    members: [{ profileId: MEMBER_PROFILE_ID, realName: "HZ张三" }],
    categories: [{ id: CATEGORY_ID, name: "HZ 测试分类", isActive: true }],
    today: new Date().toISOString().slice(0, 10),
  });

  const firstRun = await applyHistoryImport(plan.valid, adminActor());
  assert.deepEqual(firstRun, { inserted: 1, skipped: 0 });
  const secondRun = await applyHistoryImport(plan.valid, adminActor());
  assert.deepEqual(secondRun, { inserted: 0, skipped: 1 }, "重跑整批应全部跳过");
  assert.equal(
    await db.repairRecord.count({ where: { createRequestKey: plan.valid[0]!.idempotencyKey } }),
    1,
    "落库记录不应重复",
  );
});

/** 第 2 行与第 1 行业务字段完全相同（同一人同一天两台机器做同样的活）。 */
function duplicatedRows(contentSuffix: string): HistoryInputRow[] {
  const rows = inputRows(contentSuffix);
  rows[1] = { lineNo: 3, raw: { ...rows[0]!.raw } };
  return rows;
}

dbTest("同组重复行不再被吞：第 2 行得到 #2 键并入库", async () => {
  const db = getDb();
  const plan = classifyHistoryRows(duplicatedRows("（同组用例）"), {
    members: [{ profileId: MEMBER_PROFILE_ID, realName: "HZ张三" }],
    categories: [{ id: CATEGORY_ID, name: "HZ 测试分类", isActive: true }],
    today: new Date().toISOString().slice(0, 10),
  });
  assert.equal(plan.valid.length, 2);
  const [first, second] = plan.valid.map((entry) => entry.idempotencyKey);
  assert.notEqual(second, first, "同组两行必须是两个键，不能折成一条");
  assert.equal(second, `${first}#2`);

  const firstRun = await applyHistoryImport(plan.valid, adminActor());
  assert.deepEqual(firstRun, { inserted: 2, skipped: 0 }, "同组两行都应收录");
  assert.equal(
    await db.repairRecord.count({ where: { createRequestKey: { in: [first!, second!] } } }),
    2,
  );
  const secondRun = await applyHistoryImport(plan.valid, adminActor());
  assert.deepEqual(secondRun, { inserted: 0, skipped: 2 }, "重跑仍全部跳过");
});

dbTest("增量补录：旧键已入库时重跑只补缺失的第 2 行", async () => {
  const db = getDb();
  const plan = classifyHistoryRows(duplicatedRows("（增量补录用例）"), {
    members: [{ profileId: MEMBER_PROFILE_ID, realName: "HZ张三" }],
    categories: [{ id: CATEGORY_ID, name: "HZ 测试分类", isActive: true }],
    today: new Date().toISOString().slice(0, 10),
  });
  // 模拟修复前的状态：同组只导入了第一行（第 2 行被当作重复吞掉）。
  await applyHistoryImport([plan.valid[0]!], adminActor());
  const backfill = await applyHistoryImport(plan.valid, adminActor());
  assert.deepEqual(backfill, { inserted: 1, skipped: 1 }, "只补第 2 行");
  assert.equal(
    await db.repairRecord.count({
      where: { createRequestKey: { in: plan.valid.map((entry) => entry.idempotencyKey) } },
    }),
    2,
  );
});

dbTest("暂存同组行同样保留序号：两行都落暂存而不是折成一行", async () => {
  const db = getDb();
  const rows: HistoryInputRow[] = ["HZ重复行", "HZ重复行"].map((name) => ({
    lineNo: 2,
    raw: {
      name,
      repairDate: "2025-06-03",
      durationMinutes: "30",
      categoryName: "HZ 测试分类",
      content: "重复行暂存用例。",
    },
  }));
  const plan = classifyHistoryRows(rows, {
    members: [{ profileId: MEMBER_PROFILE_ID, realName: "HZ张三" }],
    categories: [{ id: CATEGORY_ID, name: "HZ 测试分类", isActive: true }],
    today: new Date().toISOString().slice(0, 10),
    options: { storePendingUnmatched: true },
  });
  assert.equal(plan.pending.length, 2);
  assert.equal(plan.pending[1]!.fingerprint, `${plan.pending[0]!.fingerprint}#2`);

  const stored = await storePendingHistory(plan.pending, adminActor(), FIXTURE_SOURCE_FILE);
  assert.deepEqual(stored, { stored: 2, skipped: 0 });
  assert.equal(
    await db.repairHistoryPending.count({
      where: { fingerprint: { in: plan.pending.map((row) => row.fingerprint) } },
    }),
    2,
  );
});

dbTest("无 repair:review 权限的调用被拒绝，不写任何行", async () => {
  const db = getDb();
  const plan = classifyHistoryRows(inputRows("（越权用例）"), {
    members: [{ profileId: MEMBER_PROFILE_ID, realName: "HZ张三" }],
    categories: [{ id: CATEGORY_ID, name: "HZ 测试分类", isActive: true }],
    today: new Date().toISOString().slice(0, 10),
  });
  const memberActor: AuthorizedActor = {
    ...adminActor(),
    userId: MEMBER_USER_ID,
    permissions: permissionsForRoles(["MEMBER"]),
  };
  await assert.rejects(
    () => applyHistoryImport(plan.valid, memberActor),
    (error) => error instanceof AppError && error.code === "FORBIDDEN",
  );
  assert.equal(
    await db.repairRecord.count({ where: { createRequestKey: plan.valid[0]!.idempotencyKey } }),
    0,
  );
});

/** 「先修机、后注册」的一行：姓名 HZ待认领 尚未在册。 */
function claimInputRow(): HistoryInputRow {
  return {
    lineNo: 2,
    raw: {
      name: "HZ待认领",
      repairDate: "2025-06-02",
      durationMinutes: "30",
      categoryName: "HZ 测试分类",
      content: "重装系统并备份数据。",
    },
  };
}

dbTest("暂存待认领：注册后自动补录，记录/时间线/审计/暂存状态齐备且幂等", async () => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  // CLI `--apply` 的等价动作：姓名尚未在册、字段有效的行进暂存（先修机、后注册）。
  const preImport = classifyHistoryRows([claimInputRow()], {
    members: [{ profileId: MEMBER_PROFILE_ID, realName: "HZ张三" }],
    categories: [{ id: CATEGORY_ID, name: "HZ 测试分类", isActive: true }],
    today,
    options: { storePendingUnmatched: true },
  });
  assert.equal(preImport.valid.length, 0);
  assert.equal(preImport.pending.length, 1);
  assert.deepEqual(
    await storePendingHistory(preImport.pending, adminActor(), FIXTURE_SOURCE_FILE),
    {
      stored: 1,
      skipped: 0,
    },
  );
  // 重跑只跳过：指纹幂等，历史数据只导入一次。
  assert.deepEqual(
    await storePendingHistory(preImport.pending, adminActor(), FIXTURE_SOURCE_FILE),
    {
      stored: 0,
      skipped: 1,
    },
  );

  // 该姓名的新成员通过**邀请码注册**建档（真实注册链路）。
  const invite = await inviteCodeService.create({ maxUses: 1 }, adminActor());
  const qq = `6${String(Date.now()).slice(-9)}`;
  const registration = await inviteCodeService.redeem(
    {
      code: invite.plainCode,
      idempotencyKey: randomUUID(),
      realName: "HZ待认领",
      qq,
      phone: `136${String(Date.now()).slice(-8)}`,
      studentId: "20231010",
      className: "计算机 231",
      password: "Claim-Password-2026",
    },
    { requestId: "req_h72_claim" },
  );

  const pendingRow = await db.repairHistoryPending.findFirstOrThrow({
    where: { realName: "HZ待认领" },
  });
  assert.ok(pendingRow.claimedAt, "注册后暂存行应被认领");
  assert.equal(pendingRow.claimedByProfileId, registration.memberProfileId);
  assert.ok(pendingRow.createdRecordId);
  const record = await db.repairRecord.findUniqueOrThrow({
    where: { id: pendingRow.createdRecordId! },
  });
  assert.equal(record.memberProfileId, registration.memberProfileId);
  assert.equal(record.status, "APPROVED");
  assert.equal(record.createRequestKey, pendingRow.fingerprint, "记录指纹应与暂存行一致");
  assert.equal(record.durationMinutes, 30);
  assert.equal(record.content, "重装系统并备份数据。");
  const events = await db.repairTimelineEvent.findMany({
    where: { repairRecordId: record.id },
    orderBy: { createdAt: "asc" },
  });
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["CREATED", "SUBMITTED", "APPROVED"],
  );
  assert.ok(
    events.every(
      (event) => (event.summary as { source?: string }).source === "history_import_claim",
    ),
  );
  const audit = await db.auditLog.findFirst({
    where: { action: "member.history_claimed", targetId: registration.memberProfileId },
  });
  assert.ok(audit, "认领应留下 member.history_claimed 审计");
  assert.equal((audit.afterSummary as { count?: number }).count, 1);
  assert.ok(
    await db.auditLog.findFirst({ where: { action: "repair.history_pending_imported" } }),
    "暂存也应留下审计",
  );

  // 幂等：重复触发（例如邀请码请求重放）不会再补一条。
  await claimHistoryForNewMember({
    memberProfileId: registration.memberProfileId,
    realName: "HZ待认领",
    actor: { requestId: "req_h72_claim_replay" },
    actorType: "SYSTEM",
    actorUserId: registration.userId,
  });
  assert.equal(
    await db.repairRecord.count({ where: { memberProfileId: registration.memberProfileId } }),
    1,
  );
});

dbTest("同名在册成员不止一位时暂存行不认领：宁缺毋滥，留人工处理", async () => {
  const db = getDb();
  const now = new Date();
  // 先在册一位同名成员（历史数据里已有重名），再让第二位同名人建档。
  const twinUserId = randomUUID();
  await db.user.create({
    data: {
      id: twinUserId,
      status: "ACTIVE",
      displayName: "HZ重名甲",
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.memberProfile.create({
    data: {
      id: randomUUID(),
      userId: twinUserId,
      realName: "HZ重名",
      status: "ACTIVE",
      joinedAt: now,
      createdAt: now,
    },
  });
  const preImport = classifyHistoryRows(
    [
      {
        lineNo: 2,
        raw: {
          name: "HZ重名",
          repairDate: "2025-05-01",
          durationMinutes: "60",
          categoryName: "HZ 测试分类",
          content: "更换键盘。",
        },
      },
    ],
    {
      members: [],
      categories: [{ id: CATEGORY_ID, name: "HZ 测试分类", isActive: true }],
      today: new Date().toISOString().slice(0, 10),
      options: { storePendingUnmatched: true },
    },
  );
  assert.deepEqual(
    await storePendingHistory(preImport.pending, adminActor(), FIXTURE_SOURCE_FILE),
    {
      stored: 1,
      skipped: 0,
    },
  );

  const created = await memberService.create(
    {
      realName: "HZ重名",
      qq: `3${String(Date.now()).slice(-9)}`,
      phone: `137${String(Date.now()).slice(-8)}`,
      idempotencyKey: randomUUID(),
    },
    adminActor(),
  );
  const row = await db.repairHistoryPending.findFirstOrThrow({
    where: { realName: "HZ重名" },
  });
  assert.equal(row.claimedAt, null, "重名歧义时不得认领");
  assert.equal(await db.repairRecord.count({ where: { createRequestKey: row.fingerprint } }), 0);
  assert.equal(created.member.status, "ACTIVE");
});
