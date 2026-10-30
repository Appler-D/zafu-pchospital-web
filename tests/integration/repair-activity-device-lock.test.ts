import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { GET as deviceStatusRoute } from "../../src/app/api/v1/repair-activities/[id]/registrations/device/route";
import { POST as lookupRoute } from "../../src/app/api/v1/repair-activities/[id]/registrations/lookup/route";
import { POST as registerRoute } from "../../src/app/api/v1/repair-activities/[id]/registrations/route";
import {
  issueRegistrationDeviceToken,
  registrationDeviceCookieName,
} from "../../src/features/repair-activities/registration-device-token";
import { resetRateLimitsForTests } from "../../src/lib/api/rate-limit";
import { disconnectDb, getDb } from "../../src/lib/db/client";
import { integrationTestsEnabled } from "./db-guard";
import { sameOriginHeaders } from "./http-harness";

/**
 * 报名查询（姓名 + 手机）与设备凭证（issue #304）。
 *
 * 独立 UUID 段 `e6300000-…` 与标题前缀 "REG304 "：清理一律按这两者限定。
 * 设备凭证是签名 cookie，所以用例自己组 Request / 读 Set-Cookie（callRoute 不返回头）。
 */
const enabled = integrationTestsEnabled();
const dbTest = enabled ? test : test.skip;

const ACTIVITY_ID = "e6300000-0000-4000-8000-000000000001";
const ACTIVITY_TITLE = "REG304 设备锁定集成测试活动";
const BASE = `http://localhost/api/v1/repair-activities/${ACTIVITY_ID}/registrations`;
const COOKIE_NAME = registrationDeviceCookieName(ACTIVITY_ID);

type Handler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

async function call(
  handler: Handler,
  url: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const request = new Request(url, {
    method: init.method ?? "GET",
    headers: {
      ...sameOriginHeaders(),
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const response = await handler(request, { params: Promise.resolve({ id: ACTIVITY_ID }) });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
    setCookies: response.headers.getSetCookie(),
  };
}

function errorCodeOf(json: Record<string, unknown>): string | undefined {
  return (json.error as { code?: string } | undefined)?.code;
}

/** 从 Set-Cookie 里取出可直接回传的 `name=value`。 */
function deviceCookieOf(setCookies: string[]): string {
  const header = setCookies.find((item) => item.startsWith(`${COOKIE_NAME}=`));
  assert.ok(header, "报名成功必须下发设备凭证 cookie");
  return header.split(";")[0]!;
}

function signup(body: Record<string, unknown>, cookie?: string) {
  return call(registerRoute as Handler, BASE, { method: "POST", body, cookie });
}

function lookup(body: Record<string, unknown>) {
  return call(lookupRoute as Handler, `${BASE}/lookup`, { method: "POST", body });
}

function deviceStatus(cookie?: string) {
  return call(deviceStatusRoute as Handler, `${BASE}/device`, { cookie });
}

async function cleanup(): Promise<void> {
  const db = getDb();
  const registrations = await db.repairActivityRegistration.findMany({
    where: { activityId: ACTIVITY_ID },
    select: { id: true },
  });
  await db.auditLog.deleteMany({
    where: {
      targetType: "RepairActivityRegistration",
      targetId: { in: registrations.map((row) => row.id) },
    },
  });
  await db.repairActivityRegistration.deleteMany({ where: { activityId: ACTIVITY_ID } });
  await db.repairActivityAttendance.deleteMany({ where: { activityId: ACTIVITY_ID } });
  await db.repairActivity.deleteMany({ where: { id: ACTIVITY_ID } });
}

async function prepareFixtures(): Promise<void> {
  await cleanup();
  const now = new Date();
  const hour = 60 * 60 * 1000;
  await getDb().repairActivity.create({
    data: {
      id: ACTIVITY_ID,
      title: ACTIVITY_TITLE,
      activityAt: new Date(now.getTime() + 7 * 24 * hour),
      capacity: 20,
      signupOpensAt: new Date(now.getTime() - hour),
      signupClosesAt: new Date(now.getTime() + 24 * hour),
      createdAt: now,
      updatedAt: now,
    },
  });
}

function body(name: string, phone: string) {
  return { name, phone, issueType: "CLEAN_ONLY", consentAccepted: true };
}

before(async () => {
  if (!enabled) return;
  await prepareFixtures();
});

beforeEach(() => {
  if (!enabled) return;
  // 同一 IP 桶在文件内累计（30 次/分钟），每个用例前清空，避免互相挤占。
  resetRateLimitsForTests();
});

after(async () => {
  if (!enabled) return;
  await cleanup();
  await disconnectDb();
});

dbTest("查询必须姓名与手机号同时匹配，且不区分哪个字段错", async () => {
  const created = await signup(body("REG304 甲", "13900000301"));
  assert.equal(created.status, 201);

  const wrongName = await lookup({ name: "REG304 乙", phone: "13900000301" });
  assert.equal(wrongName.status, 404);
  assert.equal(errorCodeOf(wrongName.json), "ACTIVITY_REGISTRATION_NOT_FOUND");

  const wrongPhone = await lookup({ name: "REG304 甲", phone: "13900000302" });
  assert.equal(wrongPhone.status, 404);
  assert.equal(errorCodeOf(wrongPhone.json), "ACTIVITY_REGISTRATION_NOT_FOUND");
  assert.equal(
    (wrongName.json.error as { message?: string }).message,
    (wrongPhone.json.error as { message?: string }).message,
    "两种不匹配的提示必须一致，不能暴露某个手机号是否存在",
  );

  const found = await lookup({ name: "REG304 甲", phone: "13900000301" });
  assert.equal(found.status, 200);
  assert.equal((found.json.data as { name: string }).name, "REG304 甲");
});

dbTest("报名成功下发设备凭证：带 cookie 的再次填写被 409 拦下", async () => {
  const first = await signup(body("REG304 丙", "13900000311"));
  assert.equal(first.status, 201);
  const cookie = deviceCookieOf(first.setCookies);
  // 有效期收到活动结束：夹具活动在 7 天后，Max-Age 必须明显小于 30 天。
  const maxAge = Number(
    /Max-Age=(\d+)/.exec(
      first.setCookies.find((item) => item.startsWith(`${COOKIE_NAME}=`)) ?? "",
    )?.[1],
  );
  assert.ok(maxAge > 6 * 24 * 3600 && maxAge < 8 * 24 * 3600, `Max-Age 应在 6–8 天内：${maxAge}`);

  const blocked = await signup(body("REG304 丁", "13900000312"), cookie);
  assert.equal(blocked.status, 409);
  assert.equal(errorCodeOf(blocked.json), "ACTIVITY_DEVICE_ALREADY_REGISTERED");

  // 不带 cookie：同手机号仍由既有唯一规则拦，换手机号可以正常报名（锁只作用于设备）。
  const samePhone = await signup(body("REG304 丙", "13900000311"));
  assert.equal(samePhone.status, 409);
  assert.equal(errorCodeOf(samePhone.json), "ACTIVITY_REGISTRATION_DUPLICATE");
  const otherPhone = await signup(body("REG304 戊", "13900000313"));
  assert.equal(otherPhone.status, 201);
});

dbTest("设备状态接口按 cookie 返回；报名被删除后自动解锁", async () => {
  const none = await deviceStatus();
  assert.equal(none.status, 200);
  assert.deepEqual(none.json.data, { submitted: false, registration: null });

  const created = await signup(body("REG304 己", "13900000321"));
  assert.equal(created.status, 201);
  const cookie = deviceCookieOf(created.setCookies);
  const registrationId = (created.json.data as { id: string }).id;

  const submitted = await deviceStatus(cookie);
  assert.equal(submitted.status, 200);
  const data = submitted.json.data as {
    submitted: boolean;
    registration: { name: string; phoneMasked: string };
  };
  assert.equal(data.submitted, true);
  assert.equal(data.registration.name, "REG304 己");
  assert.match(data.registration.phoneMasked, /\*{4}/);

  // 管理员删除该报名后：状态回到未提交，同一设备凭证也能重新填写。
  await getDb().repairActivityRegistration.update({
    where: { id: registrationId },
    data: { deletedAt: new Date() },
  });
  const unlocked = await deviceStatus(cookie);
  assert.equal((unlocked.json.data as { submitted: boolean }).submitted, false);
  const again = await signup(body("REG304 庚", "13900000322"), cookie);
  assert.equal(again.status, 201);
});

dbTest("伪造 / 篡改的设备凭证等同于没有", async () => {
  const tampered = `${COOKIE_NAME}=${issueRegistrationDeviceToken(ACTIVITY_ID, "x")}x`;
  const status = await deviceStatus(tampered);
  assert.equal(status.status, 200);
  assert.equal((status.json.data as { submitted: boolean }).submitted, false);
  const created = await signup(body("REG304 辛", "13900000331"), tampered);
  assert.equal(created.status, 201);
});
