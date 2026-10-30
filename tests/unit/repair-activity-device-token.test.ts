import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "mysql://x:x@127.0.0.1:3306/x";
process.env.AUTH_SECRET ??= "test-auth-secret-for-activity-device-token";
process.env.INVITE_CODE_PEPPER ??= "pepper";
process.env.PII_AUDIT_PEPPER ??= "pii";

import {
  issueRegistrationDeviceToken,
  readRegistrationDeviceCookie,
  readRegistrationDeviceToken,
  registrationDeviceCookieName,
} from "../../src/features/repair-activities/registration-device-token";
import { resetServerEnvForTests } from "../../src/lib/env";

resetServerEnvForTests();

test("设备凭证可签发、按活动校验，过期 / 篡改 / 串活动一律视为没有", () => {
  resetServerEnvForTests();
  const now = new Date("2026-10-30T12:00:00.000Z");
  const token = issueRegistrationDeviceToken("act-1", "reg-1", now);
  assert.deepEqual(readRegistrationDeviceToken(token, { activityId: "act-1" }, now), {
    registrationId: "reg-1",
  });
  assert.equal(readRegistrationDeviceToken(token, { activityId: "act-2" }, now), null);
  assert.equal(readRegistrationDeviceToken("not.a.token", { activityId: "act-1" }, now), null);
  assert.equal(
    readRegistrationDeviceToken(
      `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
      { activityId: "act-1" },
      now,
    ),
    null,
    "签名被篡改时视为没有",
  );
  const expired = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
  assert.equal(readRegistrationDeviceToken(token, { activityId: "act-1" }, expired), null);
});

test("cookie 名按活动区分，读取只认同名 cookie", () => {
  const header = `a=1; ${registrationDeviceCookieName("act-1")}=token-1; b=2`;
  assert.equal(readRegistrationDeviceCookie(header, "act-1"), "token-1");
  assert.equal(readRegistrationDeviceCookie(header, "act-2"), "");
  assert.equal(readRegistrationDeviceCookie(null, "act-1"), "");
});
