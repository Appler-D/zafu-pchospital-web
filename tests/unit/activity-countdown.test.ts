import assert from "node:assert/strict";
import test from "node:test";

import { formatSignupCountdown } from "../../src/components/repair-activities/activity-format";

// issue #187：报名开始倒计时（服务器时间校正由组件负责，这里只验证纯格式化）。

test("报名倒计时：分 / 秒补零，整小时不省略", () => {
  assert.equal(formatSignupCountdown(65_000), "00:01:05");
  assert.equal(formatSignupCountdown(3_600_000), "01:00:00");
  assert.equal(formatSignupCountdown(59_999), "00:01:00");
});

test("报名倒计时：不足 1 秒向上取整，不提前显示 00:00:00", () => {
  assert.equal(formatSignupCountdown(999), "00:00:01");
  assert.equal(formatSignupCountdown(1), "00:00:01");
  assert.equal(formatSignupCountdown(0), "00:00:00");
  assert.equal(formatSignupCountdown(-5_000), "00:00:00");
});

test("报名倒计时：满一天显示天数", () => {
  const twoDays = 2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000 + 5_000;
  assert.equal(formatSignupCountdown(twoDays), "2 天 03:04:05");
  assert.equal(formatSignupCountdown(86_400_000), "1 天 00:00:00");
});
