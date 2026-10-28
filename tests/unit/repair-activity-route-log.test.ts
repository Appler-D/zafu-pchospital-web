import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

process.env.APP_BASE_URL = "http://localhost:3000";
process.env.DATABASE_URL ??= "mysql://unused";
process.env.AUTH_SECRET ??= "test-auth-secret-for-activity-route-log";
process.env.INVITE_CODE_PEPPER ??= "test-invite-code-pepper";
process.env.PII_AUDIT_PEPPER ??= "test-pii-audit-pepper";

import { POST as lookupRoute } from "../../src/app/api/v1/repair-activities/[id]/registrations/lookup/route";
import { POST as signupRoute } from "../../src/app/api/v1/repair-activities/[id]/registrations/route";
import { repairActivityService } from "../../src/features/repair-activities/repair-activity-service";
import type {
  RegistrationLookupView,
  RegistrationPublicView,
} from "../../src/features/repair-activities/repair-activity-service";
import { AppError } from "../../src/lib/api/errors";
import { resetRateLimitsForTests } from "../../src/lib/api/rate-limit";

const ACTIVITY_ID = "activity-log-test";
const PHONE = "13800138000";
const NAME = "日志测试客户";

type LogEntry = {
  event: string;
  requestId: string;
  activityId: string;
  result: string;
};

function captureLogs(t: TestContext): LogEntry[] {
  const entries: LogEntry[] = [];
  t.mock.method(console, "info", (line: string) => {
    entries.push(JSON.parse(line) as LogEntry);
  });
  return entries;
}

function params() {
  return { params: Promise.resolve({ id: ACTIVITY_ID }) };
}

function signupRequest(requestId: string, body: Record<string, unknown> = {}) {
  return new Request(
    `http://localhost:3000/api/v1/repair-activities/${ACTIVITY_ID}/registrations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-real-ip": "203.0.113.31",
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        name: NAME,
        phone: PHONE,
        issueType: "CLEAN_ONLY",
        deviceModel: "测试机型",
        consentAccepted: true,
        ...body,
      }),
    },
  );
}

function lookupRequest(requestId: string) {
  return new Request(
    `http://localhost:3000/api/v1/repair-activities/${ACTIVITY_ID}/registrations/lookup`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-real-ip": "203.0.113.32",
        "x-request-id": requestId,
      },
      body: JSON.stringify({ phone: PHONE }),
    },
  );
}

const registeredView: RegistrationPublicView = {
  id: "registration-1",
  activityId: ACTIVITY_ID,
  name: NAME,
  phoneMasked: "138****8000",
  issueType: "CLEAN_ONLY",
  deviceModel: "测试机型",
  status: "REGISTERED",
  createdAt: "2026-10-28T06:00:00.000Z",
};

const lookupView: RegistrationLookupView = {
  ...registeredView,
  editToken: "token",
  editTokenExpiresAt: "2026-10-28T06:30:00.000Z",
};

function assertNoSensitivePayload(entries: LogEntry[]) {
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes(PHONE), false, "日志不能包含完整手机号");
  assert.equal(serialized.includes(NAME), false, "日志不能包含姓名");
  assert.equal(serialized.includes("consentAccepted"), false, "日志不能包含请求正文");
  for (const entry of entries) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["activityId", "event", "requestId", "result"],
      "日志字段保持最小集合",
    );
  }
}

test("报名成功日志包含请求编号与结果码，不记录手机号或正文", async (t) => {
  resetRateLimitsForTests();
  const entries = captureLogs(t);
  t.mock.method(repairActivityService, "register", async () => registeredView);

  const response = await signupRoute(signupRequest("req_signup_success"), params());

  assert.equal(response.status, 201);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    event: "repair_activity.signup",
    requestId: "req_signup_success",
    activityId: ACTIVITY_ID,
    result: "SUCCESS",
  });
  assertNoSensitivePayload(entries);
  assert.equal(
    ((await response.json()) as { meta: { requestId: string } }).meta.requestId,
    "req_signup_success",
  );
});

test("报名失败日志使用业务结果码覆盖重复、满额与参数错误", async (t) => {
  resetRateLimitsForTests();
  const entries = captureLogs(t);
  let failure: AppError | null = null;
  t.mock.method(repairActivityService, "register", async () => {
    if (failure) throw failure;
    return registeredView;
  });

  for (const [code, status] of [
    ["ACTIVITY_REGISTRATION_DUPLICATE", 409],
    ["ACTIVITY_FULL", 409],
    ["VALIDATION_FAILED", 400],
  ] as const) {
    failure = new AppError(code, "预期失败");
    const requestId = `req_signup_${code.toLowerCase()}`;
    const response = await signupRoute(signupRequest(requestId), params());
    assert.equal(response.status, status);
    assert.deepEqual(entries.at(-1), {
      event: "repair_activity.signup",
      requestId,
      activityId: ACTIVITY_ID,
      result: code,
    });
  }

  assert.equal(entries.length, 3);
  assertNoSensitivePayload(entries);
});

test("查询成功与未找到都记录请求编号和结果码，不记录手机号", async (t) => {
  resetRateLimitsForTests();
  const entries = captureLogs(t);
  let failure: AppError | null = null;
  t.mock.method(repairActivityService, "lookup", async () => {
    if (failure) throw failure;
    return lookupView;
  });

  const success = await lookupRoute(lookupRequest("req_lookup_success"), params());
  assert.equal(success.status, 200);
  assert.deepEqual(entries[0], {
    event: "repair_activity.lookup",
    requestId: "req_lookup_success",
    activityId: ACTIVITY_ID,
    result: "SUCCESS",
  });

  failure = new AppError("ACTIVITY_REGISTRATION_NOT_FOUND", "未找到该手机号的报名记录");
  const missing = await lookupRoute(lookupRequest("req_lookup_missing"), params());
  assert.equal(missing.status, 404);
  assert.deepEqual(entries[1], {
    event: "repair_activity.lookup",
    requestId: "req_lookup_missing",
    activityId: ACTIVITY_ID,
    result: "ACTIVITY_REGISTRATION_NOT_FOUND",
  });

  assertNoSensitivePayload(entries);
});
