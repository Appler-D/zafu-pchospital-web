import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatShanghaiTime } from "../../src/components/repair-activities/activity-format";
import { memberRepairActivitiesCopy } from "../../src/config/repair-activities";

/**
 * 看板「出勤成员」入口与弹层的接线契约。
 *
 * 与 `repair-activity-attendance-count.test.ts` 同一思路：runtime 面薄
 * （一个入口按钮 + 一个只读弹层），真正会悄悄坏掉的是接线与两条红线 ——
 * ① 名单只对管理员下发：成员拿到空数组，且服务端在为成员取看板时**不查询**名单；
 * ② 行形状只有 `memberProfileId / name / checkedInAt`，QQ、手机号、学号等身份字段
 *    一律不进响应。
 */

const staffServiceSource = readFileSync(
  "src/features/repair-activities/repair-activity-staff-service.ts",
  "utf8",
);
const boardSource = readFileSync(
  "src/components/repair-activities/MemberRepairActivityBoard.tsx",
  "utf8",
);

test("formatShanghaiTime：按 Asia/Shanghai 输出时:分（补零，UTC 跨日 = 第二天）", () => {
  assert.equal(formatShanghaiTime("2026-10-08T23:12:00.000Z"), "07:12");
  assert.equal(formatShanghaiTime("2026-10-08T00:05:00.000Z"), "08:05");
  // 16:00Z = 次日 00:00（h23 口径，不是 24:00）。
  assert.equal(formatShanghaiTime("2026-10-07T16:00:00.000Z"), "00:00");
  assert.equal(formatShanghaiTime("2026-10-07T15:59:00.000Z"), "23:59");
});

test("出勤成员文案集中在 config，入口与签到时间带占位符", () => {
  const copy = memberRepairActivitiesCopy.board;
  assert.ok(copy.attendanceEntry.includes("{count}"));
  assert.ok(copy.attendanceCheckedInAt.includes("{time}"));
  assert.ok(copy.attendanceTitle.length > 0);
  assert.ok(copy.attendanceEmpty.length > 0);
  assert.ok(copy.attendanceNote.length > 0);
});

test("看板视图与新查询：名单仅管理员取数，按签到时间升序", () => {
  assert.match(
    staffServiceSource,
    /export type StaffAttendanceMemberView = \{[\s\S]*?memberProfileId: string;[\s\S]*?name: string;[\s\S]*?checkedInAt: string;[\s\S]*?\};/,
  );
  assert.match(staffServiceSource, /attendanceMembers: StaffAttendanceMemberView\[\];/);
  // 成员在库层就不取：三元短路的管理员分支才是唯一的名单查询。
  assert.match(
    staffServiceSource,
    /canAdmin\s*\?\s*getDb\(\)\.repairActivityAttendance\.findMany\(\{/,
  );
  assert.match(staffServiceSource, /Promise\.resolve\(\[\]\)/);
  assert.match(staffServiceSource, /orderBy: \[\{ checkedInAt: "asc" \}, \{ id: "asc" \}\]/);
  // 名字走展示名回退链，不允许手拼 nickname ?? realName。
  assert.match(staffServiceSource, /name: resolveDisplayName\(\{/);
});

test("出勤成员映射不携带身份字段（红线）", () => {
  const mapping = staffServiceSource.match(
    /const attendanceMembers: StaffAttendanceMemberView\[\] = attendanceRows\.map\(\(row\) => \(\{[\s\S]*?\}\)\);/,
  );
  assert.ok(mapping, "attendanceMembers 映射应存在");
  assert.equal(/phone|qq|studentId|className/i.test(mapping[0]), false);
});

test("看板入口与弹层接线：管理员入口 + AdminModal + formatShanghaiTime", () => {
  assert.match(
    boardSource,
    /board\.canAdmin \? \(\s*<Button[\s\S]*?className="activity-board__attendance-entry"[\s\S]*?trailingIcon="chevronRight"/,
  );
  assert.match(boardSource, /copy\.attendanceEntry\.replace\("\{count\}"/);
  assert.match(boardSource, /<AdminModal[\s\S]*?title=\{copy\.attendanceTitle\}/);
  assert.match(boardSource, /formatShanghaiTime\(row\.checkedInAt\)/);
  assert.match(boardSource, /board\.attendanceMembers\.length === 0/);
});
