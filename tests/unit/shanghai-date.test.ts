import assert from "node:assert/strict";
import test from "node:test";
import { shanghaiToday } from "../../src/lib/shanghai-date";
import {
  parseRepairDate,
  validateDraftFields,
  validateSubmission,
} from "../../src/features/repairs/repair-validation";

test("默认维修日期保持 YYYY-MM-DD，不受 Intl 地区格式影响", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-09T16:00:00.000Z") });
  // 部分浏览器的 en-CA 数据使用月/日/年；模拟该环境，不能把本地化显示值当日期协议。
  const DateTimeFormat = Intl.DateTimeFormat;
  t.mock.method(
    Intl,
    "DateTimeFormat",
    function (_locales: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return new DateTimeFormat("en-US", options);
    },
  );
  const repairDate = shanghaiToday();
  assert.equal(repairDate, "2026-10-10");
  validateDraftFields({ repairDate });
  validateSubmission({
    repairDate: parseRepairDate(repairDate) as Date,
    durationMinutes: 30,
    categoryId: "category",
    ownerName: "张三",
    ownerPhone: "13800138000",
    deviceModel: "联想小新 Air 14",
    content: null,
    result: "COMPLETED",
  });
  assert.throws(() => validateDraftFields({ repairDate: "2026-10-11" }));
});

test("默认维修日期按上海日历日跨午夜、跨年与闰日", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  for (const [instant, expected] of [
    ["2026-10-09T15:59:59.999Z", "2026-10-09"],
    ["2026-10-09T16:00:00.000Z", "2026-10-10"],
    ["2026-12-31T16:00:00.000Z", "2027-01-01"],
    ["2028-02-28T16:00:00.000Z", "2028-02-29"],
  ]) {
    t.mock.timers.setTime(new Date(instant).valueOf());
    assert.equal(shanghaiToday(), expected);
  }
});
