import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { adminCopy } from "../../src/config/admin";

/**
 * 活动管理页「出勤」列（issue #107）的接线契约。
 *
 * 这一改动的 runtime 面很薄（一次 groupBy 计数 + 一个表格单元格），
 * 真正会悄悄坏掉的是**接线**：字段改名、copy 键丢失、面板绑错字段，
 * 或者有人为了「顺手」把出勤成员明细一起下发到管理端列表。
 * 因此这里对源码块做文本断言、对 copy 做运行时断言 ——
 * 与 `m5-contracts.test.ts` 的「契约层白名单」同一思路：
 * 断言优先于截图，坏在合入前而不是线上。
 */

const serviceSource = readFileSync(
  "src/features/repair-activities/repair-activity-service.ts",
  "utf8",
);
const panelSource = readFileSync("src/components/admin/RepairActivityAdminPanel.tsx", "utf8");

test("出勤文案集中在 config 且带计数占位", () => {
  const table = adminCopy.repairActivities.table;
  assert.equal(typeof table.attendance, "string");
  assert.ok(table.attendance.length > 0);
  assert.ok(adminCopy.repairActivities.attendanceLine.includes("{count}"));
});

test("管理端视图类型包含 attendedCount，计数走 groupBy 批量聚合", () => {
  assert.match(
    serviceSource,
    /export type RepairActivityAdminView = RepairActivityPublicView & \{[\s\S]*?attendedCount: number;/,
  );
  assert.match(serviceSource, /async function loadAttendanceCounts\(ids: string\[\]\)/);
  assert.match(serviceSource, /repairActivityAttendance\.groupBy/);
  // 缺省口径与报名计数一致：没有出勤记录的活动显示 0，而不是 undefined
  assert.match(serviceSource, /attendanceCounts\.get\(row\.id\) \?\? 0/);
});

test("listAdmin 同时聚合报名与出勤两类计数", () => {
  assert.match(serviceSource, /const attendanceCounts = await loadAttendanceCounts\(/);
  const call =
    /toAdminView\(row, counts\.get\(row\.id\) \?\? 0, attendanceCounts\.get\(row\.id\) \?\? 0, now\)/;
  assert.match(serviceSource, call);
});

test("活动管理页表格有「出勤」列并绑定 attendedCount", () => {
  assert.match(panelSource, /<th>\{copy\.table\.attendance\}<\/th>/);
  assert.match(panelSource, /<td data-label=\{copy\.table\.attendance\}>/);
  const cell = /copy\.attendanceLine\.replace\("\{count\}", String\(item\.attendedCount\)\)/;
  assert.match(panelSource, cell);
});

test("出勤人数只回计数：管理端列表源码不下发成员身份字段", () => {
  // 本期只做计数，成员明细不在范围。若将来要做出勤明细接口，应新建独立服务/路由
  // 并同步本用例，而不是把 memberProfileId / checkedInAt 泄进列表响应。
  for (const field of ["memberProfileId", "checkedInAt"]) {
    assert.equal(serviceSource.includes(field), false, `管理端列表不应暴露 ${field}`);
  }
});
