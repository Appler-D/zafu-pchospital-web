import assert from "node:assert/strict";
import test from "node:test";

import { formatShanghaiDateParts } from "../../src/components/repair-activities/activity-format";

test("日期票根按 Asia/Shanghai 拆分月份、日与星期", () => {
  assert.deepEqual(formatShanghaiDateParts("2026-10-31T01:00:00.000Z"), {
    month: "10月",
    day: "31",
    weekday: "周六",
  });
});

test("日期票根跨上海午夜后取次日，日补零", () => {
  assert.deepEqual(formatShanghaiDateParts("2026-10-31T16:30:00.000Z"), {
    month: "11月",
    day: "01",
    weekday: "周日",
  });
});
