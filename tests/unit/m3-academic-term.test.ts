import assert from "node:assert/strict";
import test from "node:test";

import {
  shanghaiAcademicYearRange,
  shanghaiMonthRange,
  shanghaiDateToUtc,
  toDateOnlyBounds,
} from "../../src/lib/academic-term";
import { ApiErrorCode } from "../../src/lib/api/errors";
import { Permission } from "../../src/types/contracts";
import {
  MEMBER_NICKNAME_MAX_LENGTH,
  MEMBER_RECENT_REPAIR_LIMIT,
  MEMBER_SKILL_LIMIT,
} from "../../src/types/contracts";

// ---------------------------------------------------------------------------
// 学年口径（固定 9/1 → 次年 9/1，不再读环境变量）
// ---------------------------------------------------------------------------

test("学年边界：上海 9 月 1 日 00:00 起算，此前一分钟仍属上一学年", () => {
  // UTC 2026-08-31T15:59:59.999Z = 上海 2026-08-31 23:59:59.999 → 仍是 2025–2026 学年
  const before = shanghaiAcademicYearRange(new Date("2026-08-31T15:59:59.999Z"));
  assert.equal(before.startYear, 2025);
  assert.equal(before.label, "2025–2026 学年");
  assert.equal(before.startInclusive.toISOString(), "2025-08-31T16:00:00.000Z");
  assert.equal(before.endExclusive.toISOString(), "2026-08-31T16:00:00.000Z");

  // 再晚 1ms = 上海 2026-09-01 00:00 → 新学年
  const after = shanghaiAcademicYearRange(new Date("2026-08-31T16:00:00.000Z"));
  assert.equal(after.startYear, 2026);
  assert.equal(after.label, "2026–2027 学年");
  assert.equal(after.startInclusive.toISOString(), "2026-08-31T16:00:00.000Z");
  assert.equal(after.endExclusive.toISOString(), "2027-08-31T16:00:00.000Z");
});

test("学年归属：跨年月份（1–8 月）属于上一年开始的学年", () => {
  // 上海 2027-03-15 → 2026–2027 学年
  const spring = shanghaiAcademicYearRange(new Date("2027-03-15T00:00:00.000Z"));
  assert.equal(spring.startYear, 2026);
  assert.equal(spring.label, "2026–2027 学年");
  // 上海 2027-09-01 00:00 → 2027–2028 学年
  const next = shanghaiAcademicYearRange(new Date("2027-08-31T16:00:00.000Z"));
  assert.equal(next.startYear, 2027);
});

test("学年口径不受已废弃的 ACADEMIC_TERM_* 环境变量影响", () => {
  const previousStart = process.env.ACADEMIC_TERM_START;
  const previousEnd = process.env.ACADEMIC_TERM_END;
  process.env.ACADEMIC_TERM_START = "2026-01-01";
  process.env.ACADEMIC_TERM_END = "2026-02-01";
  try {
    const range = shanghaiAcademicYearRange(new Date("2026-10-20T00:00:00.000Z"));
    assert.equal(range.startInclusive.toISOString(), "2026-08-31T16:00:00.000Z");
    assert.equal(range.endExclusive.toISOString(), "2027-08-31T16:00:00.000Z");
  } finally {
    if (previousStart === undefined) delete process.env.ACADEMIC_TERM_START;
    else process.env.ACADEMIC_TERM_START = previousStart;
    if (previousEnd === undefined) delete process.env.ACADEMIC_TERM_END;
    else process.env.ACADEMIC_TERM_END = previousEnd;
  }
});

// ---------------------------------------------------------------------------
// Asia/Shanghai 月边界
// ---------------------------------------------------------------------------

test("M3 月份边界：上海月初按 UTC+8 平移", () => {
  // UTC 2026-08-31T16:00:00Z 恰好是上海 2026-09-01T00:00 → 属于 9 月
  const range = shanghaiMonthRange(new Date("2026-08-31T16:00:00.000Z"));
  assert.equal(range.year, 2026);
  assert.equal(range.month, 9);
  assert.equal(range.startInclusive.toISOString(), "2026-08-31T16:00:00.000Z");
  assert.equal(range.endExclusive.toISOString(), "2026-09-30T16:00:00.000Z");
});

test("M3 月份边界：上海月末最后一刻仍属当月（UTC 跨日）", () => {
  // UTtC 2026-09-30T15:59:59.999Z = 上海 2026-09-30T23:59:59.999 → 仍是 9 月
  const range = shanghaiMonthRange(new Date("2026-09-30T15:59:59.999Z"));
  assert.equal(range.month, 9);
  // 再往后 1ms 进入 10 月
  const next = shanghaiMonthRange(new Date("2026-09-30T16:00:00.000Z"));
  assert.equal(next.month, 10);
});

test("M3 月份边界：12 月正确进位到次年 1 月", () => {
  const range = shanghaiMonthRange(new Date("2026-12-15T00:00:00.000Z"));
  assert.equal(range.year, 2026);
  assert.equal(range.month, 12);
  assert.equal(range.endExclusive.toISOString(), "2026-12-31T16:00:00.000Z");
});

test("M3 日期工具：非法日期返回 null", () => {
  assert.equal(shanghaiDateToUtc("2026-02-30"), null);
  assert.equal(shanghaiDateToUtc("not-a-date"), null);
  assert.equal(shanghaiDateToUtc("2026-09-01")?.toISOString(), "2026-08-31T16:00:00.000Z");
});

// ---------------------------------------------------------------------------
// DATE 列边界
// ---------------------------------------------------------------------------

test("M3 DATE 列边界：月区间转成 UTC 零点日期边界", () => {
  // 上海 2026-09 的 UTC 区间是 [08-31T16:00Z, 09-30T16:00Z)；
  // 直接交给 Prisma 会被按 UTC 日历日截断成 [08-31, 09-30) → 整体挪前一天。
  const month = shanghaiMonthRange(new Date("2026-09-15T00:00:00.000Z"));
  assert.deepEqual(toDateOnlyBounds(month), {
    gte: new Date("2026-09-01T00:00:00.000Z"),
    lt: new Date("2026-10-01T00:00:00.000Z"),
  });
});

test("M3 DATE 列边界：跨年月份", () => {
  // 12 月：上海 2026-12-31 的次日是 2027-01-01，不能停在同一年的 12-31
  const december = shanghaiMonthRange(new Date("2026-12-15T00:00:00.000Z"));
  assert.deepEqual(toDateOnlyBounds(december), {
    gte: new Date("2026-12-01T00:00:00.000Z"),
    lt: new Date("2027-01-01T00:00:00.000Z"),
  });
});

test("M3 DATE 列边界：学年区间是 [9/1, 次年 9/1) 两个完整自然日边界", () => {
  const year = shanghaiAcademicYearRange(new Date("2026-10-20T00:00:00.000Z"));
  const bounds = toDateOnlyBounds(year);
  assert.equal(bounds.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(bounds.lt.toISOString(), "2027-09-01T00:00:00.000Z");
  // 区间两端固定相差 8 小时（DATE 边界 = UTC 区间 + 偏移），两种语义下都不变
  assert.equal(
    bounds.gte.getTime() - year.startInclusive.getTime(),
    bounds.lt.getTime() - year.endExclusive.getTime(),
  );
});

// ---------------------------------------------------------------------------
// M3 公共契约
// ---------------------------------------------------------------------------

test("M3 稳定错误码已进入公共错误码集合", () => {
  for (const code of [
    "MEMBER_PROFILE_NOT_FOUND",
    "MEMBER_PROFILE_FORBIDDEN",
    "MEMBER_PROFILE_VERSION_CONFLICT",
    "MEMBER_PROFILE_INVALID_NICKNAME",
    "SKILL_NOT_FOUND",
    "SKILL_INACTIVE",
    "SKILL_LIMIT_EXCEEDED",
    "SKILL_SELECTION_INVALID",
  ]) {
    assert.equal(ApiErrorCode.includes(code as (typeof ApiErrorCode)[number]), true, code);
  }
});

test("M3 权限已进入公共 Permission 集合", () => {
  for (const permission of [
    "member.profile.read_self",
    "member.profile.update_self",
    "member.profile.read_internal",
    "member.skill.assign_self",
  ]) {
    assert.equal(Permission.includes(permission as (typeof Permission)[number]), true, permission);
  }
});

test("M3 数量边界常量固定为契约值", () => {
  assert.equal(MEMBER_SKILL_LIMIT, 12);
  assert.equal(MEMBER_NICKNAME_MAX_LENGTH, 64);
  assert.equal(MEMBER_RECENT_REPAIR_LIMIT, 5);
});
