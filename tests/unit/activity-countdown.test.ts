import assert from "node:assert/strict";
import test from "node:test";

import { signupCountdownParts } from "../../src/components/repair-activities/activity-format";

// 报名开始倒计时（服务器时间校正由组件负责，这里只验证纯拆解）。

test("报名倒计时：分 / 秒补零，整小时不省略", () => {
  assert.deepEqual(signupCountdownParts(65_000), {
    days: 0,
    hours: "00",
    minutes: "01",
    seconds: "05",
  });
  assert.deepEqual(signupCountdownParts(3_600_000), {
    days: 0,
    hours: "01",
    minutes: "00",
    seconds: "00",
  });
  assert.deepEqual(signupCountdownParts(59_999), {
    days: 0,
    hours: "00",
    minutes: "01",
    seconds: "00",
  });
});

test("报名倒计时：不足 1 秒向上取整，不提前显示 00:00:00", () => {
  assert.deepEqual(signupCountdownParts(999), {
    days: 0,
    hours: "00",
    minutes: "00",
    seconds: "01",
  });
  assert.deepEqual(signupCountdownParts(1), { days: 0, hours: "00", minutes: "00", seconds: "01" });
  assert.deepEqual(signupCountdownParts(0), { days: 0, hours: "00", minutes: "00", seconds: "00" });
  assert.deepEqual(signupCountdownParts(-5_000), {
    days: 0,
    hours: "00",
    minutes: "00",
    seconds: "00",
  });
});

test("报名倒计时：满一天给出天数", () => {
  const twoDays = 2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000 + 5_000;
  assert.deepEqual(signupCountdownParts(twoDays), {
    days: 2,
    hours: "03",
    minutes: "04",
    seconds: "05",
  });
  assert.deepEqual(signupCountdownParts(86_400_000), {
    days: 1,
    hours: "00",
    minutes: "00",
    seconds: "00",
  });
});

test("报名倒计时：Infinity / NaN 兜底归零，绝不渲染出 Infinity", () => {
  const zeros = { days: 0, hours: "00", minutes: "00", seconds: "00" };
  assert.deepEqual(signupCountdownParts(Number.POSITIVE_INFINITY), zeros);
  assert.deepEqual(signupCountdownParts(Number.NEGATIVE_INFINITY), zeros);
  assert.deepEqual(signupCountdownParts(Number.NaN), zeros);
});
