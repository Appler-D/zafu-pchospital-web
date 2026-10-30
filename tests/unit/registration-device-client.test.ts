import assert from "node:assert/strict";
import test from "node:test";

import { fetchRegistrationDeviceStatus } from "../../src/features/repair-activities/registration-device-client";

const registration = {
  id: "r1",
  activityId: "act-1",
  name: "测试客户",
  phoneMasked: "138****0000",
  issueType: "CLEAN_PASTE",
  deviceModel: null,
  status: "REGISTERED",
  createdAt: "2026-10-30T12:00:00.000Z",
};

test("设备状态接口成功时返回登记（含 null 表示未提交）", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json({ success: true, data: { submitted: true, registration } })),
  );
  assert.deepEqual(await fetchRegistrationDeviceStatus("act-1"), registration);
});

test("设备状态接口返回失败信封时按未知处理", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json({ success: false, error: { message: "boom" } })),
  );
  assert.equal(await fetchRegistrationDeviceStatus("act-1"), undefined);
});

test("网络异常按未知处理", async (t) => {
  t.mock.method(globalThis, "fetch", () => Promise.reject(new TypeError("network")));
  assert.equal(await fetchRegistrationDeviceStatus("act-1"), undefined);
});

test("设备状态查询超时按未知处理，不会一直挂着", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  const started = Date.now();
  const result = await fetchRegistrationDeviceStatus("act-1", { timeoutMs: 30 });
  assert.equal(result, undefined);
  assert.ok(Date.now() - started < 1500, "应在超时后立即返回，而不是等待网络");
});

test("AbortSignal.any 缺失（Safari 16 等）时手动合并，超时仍返回 undefined", async (t) => {
  const original = AbortSignal.any;
  Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
  t.after(() => Object.defineProperty(AbortSignal, "any", { value: original, configurable: true }));
  t.mock.method(
    globalThis,
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );

  const started = Date.now();
  const result = await fetchRegistrationDeviceStatus("act-1", {
    signal: new AbortController().signal,
    timeoutMs: 30,
  });
  assert.equal(result, undefined);
  assert.ok(Date.now() - started < 1500);
});

test("AbortSignal.any 抛错时按未知处理，不会 reject 出去", async (t) => {
  const original = AbortSignal.any;
  Object.defineProperty(AbortSignal, "any", {
    value: () => {
      throw new TypeError("any unsupported");
    },
    configurable: true,
  });
  t.after(() => Object.defineProperty(AbortSignal, "any", { value: original, configurable: true }));
  let fetched = 0;
  t.mock.method(globalThis, "fetch", () => {
    fetched += 1;
    return Promise.resolve(Response.json({ success: true, data: { registration: null } }));
  });

  assert.equal(
    await fetchRegistrationDeviceStatus("act-1", { signal: new AbortController().signal }),
    undefined,
  );
  assert.equal(fetched, 0, "构造 signal 失败时不应发起请求");
});
