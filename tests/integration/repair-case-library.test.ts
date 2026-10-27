import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { repairQueryService } from "../../src/features/repairs/repair-query-service";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import type { AuthorizedActor } from "../../src/types/contracts";
import { integrationTestsEnabled } from "./db-guard";

/**
 * 案例库准入的集成测试（真实 GreatSQL）。
 *
 * 钉三件事：
 * 1. `flagged=ANY` 返回「典型案例 ∪ 疑难案例」并集：单标、双标都命中，无标不命中；
 * 2. 单标记参数（`isTypical` / `isDifficult`）的平铺 AND 语义不变（都传 = 两条都标）；
 * 3. `flagged` 与关键词搜索**并存** —— Prisma 同一对象两个同名 `OR` 键后者覆盖前者，
 *    实现时把并集条件并入了 `AND` 数组，这里在真实数据库上验证搜索没有被顶掉。
 *
 * fixture 一律随机 UUID + 名称 / 内容前缀 "CASE134"：清理只按这两者限定，
 * 不触碰库里已有的成员与维修记录。记录直建为 `APPROVED` —— 本文件只验列表谓词，
 * 不走审核状态机（那条链由 `repair-participants.test.ts` 等覆盖）。
 */
/* 集成测试的统一闸门：指向非测试库时**在加载阶段就抛错**（`db-guard.ts` 里写了两次
   实际事故）。未开启时返回 false，各文件照常走 test.skip。 */
const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

const PREFIX = "CASE134";
const MARKER = `${PREFIX}关键词`;

let seq = 0;

async function createMember(label: string) {
  const db = getDb();
  seq += 1;
  const tag = String(seq).padStart(3, "0");
  const userId = randomUUID();
  const profileId = randomUUID();
  const now = new Date();
  await db.user.create({
    data: { id: userId, status: "ACTIVE", displayName: `${PREFIX}${label}${tag}`, createdAt: now, updatedAt: now },
  });
  await db.memberProfile.create({
    data: { id: profileId, userId, realName: `${PREFIX}${label}${tag}`, status: "ACTIVE", joinedAt: now, createdAt: now },
  });
  const actor: AuthorizedActor = {
    actorType: "USER",
    userId,
    userStatus: "ACTIVE",
    permissions: permissionsForRoles(["MEMBER"]),
    requestId: `req_case134_${tag}`,
  };
  return { userId, profileId, actor };
}

/** 直建已通过记录；`content` 不带关键词的那条专门用来验搜索仍然生效。 */
async function createApprovedRecord(
  profileId: string,
  flags: { typical: boolean; difficult: boolean },
  content: string,
): Promise<string> {
  const db = getDb();
  const id = randomUUID();
  const now = new Date();
  await db.repairRecord.create({
    data: {
      id,
      memberProfileId: profileId,
      status: "APPROVED",
      repairDate: now,
      durationMinutes: 30,
      ownerName: `${PREFIX}机主`,
      ownerPhone: "13800000000",
      content,
      isTypical: flags.typical,
      isDifficult: flags.difficult,
      createRequestKey: randomUUID(),
      submittedAt: now,
      reviewedAt: now,
      createdAt: now,
    },
  });
  // 创建人恒有参与行（不变量），避免留下半截数据。
  await db.repairRecordParticipant.create({
    data: { id: randomUUID(), repairRecordId: id, memberProfileId: profileId, createdAt: now },
  });
  return id;
}

/** 清理本文件产生的全部行（顺序由外键决定：参与行先于记录，记录先于档案）。 */
async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  const profiles = await db.memberProfile.findMany({
    where: { realName: { startsWith: PREFIX } },
    select: { id: true, userId: true },
  });
  const profileIds = profiles.map((row) => row.id);
  const userIds = profiles.map((row) => row.userId);
  const records = await db.repairRecord.findMany({
    where: {
      OR: [{ memberProfileId: { in: profileIds } }, { content: { startsWith: PREFIX } }],
    },
    select: { id: true },
  });
  const recordIds = records.map((row) => row.id);
  await db.repairRecordParticipant.deleteMany({ where: { repairRecordId: { in: recordIds } } });
  await db.repairRecord.deleteMany({ where: { id: { in: recordIds } } });
  await db.memberProfile.deleteMany({ where: { id: { in: profileIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

let member: Awaited<ReturnType<typeof createMember>>;
let typicalOnly: string;
let difficultOnly: string;
let both: string;
let unmarked: string;
let typicalNoMarker: string;

before(async () => {
  if (!enabled) return;
  await cleanupFixtures();
  member = await createMember("成员");
  typicalOnly = await createApprovedRecord(member.profileId, { typical: true, difficult: false }, `${MARKER}仅典型`);
  difficultOnly = await createApprovedRecord(member.profileId, { typical: false, difficult: true }, `${MARKER}仅疑难`);
  both = await createApprovedRecord(member.profileId, { typical: true, difficult: true }, `${MARKER}双标`);
  unmarked = await createApprovedRecord(member.profileId, { typical: false, difficult: false }, `${MARKER}无标`);
  typicalNoMarker = await createApprovedRecord(member.profileId, { typical: true, difficult: false }, `${PREFIX}无关键词仅典型`);
});

after(async () => {
  if (!enabled) return;
  await cleanupFixtures();
  await disconnectDb();
});

/** 取第一页并筛出本文件的 fixture id —— 库里还有别人的已通过记录，不能只看总数。 */
async function listedIds(input: {
  flagged?: "ANY";
  status?: "APPROVED";
  isTypical?: boolean;
  isDifficult?: boolean;
  query?: string;
}): Promise<Set<string>> {
  const { items } = await repairQueryService.list({ page: 1, pageSize: 200, ...input }, member.actor);
  return new Set(items.map((item) => item.id));
}

dbTest("flagged=ANY 返回「典型 ∪ 疑难」并集：单标与双标都命中，无标不命中", async () => {
  const ids = await listedIds({ flagged: "ANY", status: "APPROVED" });
  assert.equal(ids.has(typicalOnly), true, "仅典型应入选");
  assert.equal(ids.has(difficultOnly), true, "仅疑难应入选");
  assert.equal(ids.has(both), true, "双标应入选且只出现一次");
  assert.equal(ids.has(typicalNoMarker), true, "另一条仅典型同样入选");
  assert.equal(ids.has(unmarked), false, "无标记录不得入选");
});

dbTest("单标记参数语义不变：isTypical / isDifficult 仍是平铺 AND", async () => {
  const typical = await listedIds({ status: "APPROVED", isTypical: true });
  assert.equal(typical.has(typicalOnly), true);
  assert.equal(typical.has(both), true);
  assert.equal(typical.has(difficultOnly), false, "仅疑难不该被 isTypical 命中");

  const difficult = await listedIds({ status: "APPROVED", isDifficult: true });
  assert.equal(difficult.has(difficultOnly), true);
  assert.equal(difficult.has(both), true);
  assert.equal(difficult.has(typicalOnly), false, "仅典型不该被 isDifficult 命中");

  // 两个都传仍是 AND（两条都标）—— 并集只由 flagged=ANY 表达
  const both2 = await listedIds({ status: "APPROVED", isTypical: true, isDifficult: true });
  assert.equal(both2.has(both), true);
  assert.equal(both2.has(typicalOnly), false, "都传时应要求两条都标");
  assert.equal(both2.has(difficultOnly), false, "都传时应要求两条都标");
});

dbTest("flagged 与关键词搜索并存：并集条件没有顶掉顶层 OR 搜索", async () => {
  const ids = await listedIds({ flagged: "ANY", status: "APPROVED", query: MARKER });
  assert.equal(ids.has(typicalOnly), true);
  assert.equal(ids.has(difficultOnly), true);
  assert.equal(ids.has(both), true);
  assert.equal(
    ids.has(typicalNoMarker),
    false,
    "内容不含关键词的已标记记录应被搜索排除 —— 顶掉了搜索它就会混进来",
  );
});
