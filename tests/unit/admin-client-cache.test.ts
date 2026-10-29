import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { adminFetch, clearAdminCache } from "../../src/features/admin/admin-client";
import {
  checkClientSession,
  invalidateClientSession,
  sessionMutationFetch,
} from "../../src/lib/auth/client-session";
import type { AccountMeView } from "../../src/types/contracts";

const originalFetch = globalThis.fetch;
const principal = (sessionId = "session-a"): AccountMeView => ({
  userId: "admin-a",
  sessionId,
  displayName: "管理员",
  roles: ["ADMIN"],
  permissions: ["member:manage"],
  memberProfileId: null,
  memberStatus: null,
  mustChangePassword: false,
  rememberMe: false,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  accountAccess: { state: "READY", destination: "/admin", exemptionExpiresAt: null },
});
beforeEach(async () => {
  // 每个用例从一次真实格式的身份确认开始，业务请求断言不混入 /me 流量。
  globalThis.fetch = async () => response(principal());
  await sessionMutationFetch("/reset", { method: "POST" });
  await checkClientSession("");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAdminCache();
  invalidateClientSession();
});
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));

test("删除前开始的分页响应不能重新填充已失效缓存", async () => {
  let finishOldPage!: (value: Response) => void;
  let reads = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "DELETE") return response(null);
    reads++;
    if (reads === 1)
      return new Promise<Response>((resolve) => {
        finishOldPage = resolve;
      });
    return response([{ id: "remaining" }]);
  };
  const pending = adminFetch<{ id: string }[]>("/applications?page=2");
  await setImmediate();
  await adminFetch("/applications/deleted", { method: "DELETE" });
  finishOldPage(response([{ id: "deleted" }]));
  await pending;
  const refreshed = await adminFetch<{ id: string }[]>("/applications?page=2");
  assert.equal(reads, 2);
  assert.ok(refreshed.ok);
  assert.deepEqual(refreshed.data, [{ id: "remaining" }]);
  await adminFetch("/applications?page=2");
  assert.equal(reads, 2, "没有写操作时仍复用有效缓存");
});

test("显式清理缓存也阻止在途旧响应回填", async () => {
  let finish!: (value: Response) => void;
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    if (reads === 1)
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return response("new");
  };
  const pending = adminFetch("/applications");
  await setImmediate();
  clearAdminCache();
  finish(response("old"));
  await pending;
  assert.deepEqual(await adminFetch("/applications"), {
    ok: true,
    data: "new",
    pagination: undefined,
  });
  assert.equal(reads, 2);
});

test("删除进行中完成的旧读取在删除结束后同样失效", async () => {
  let finishDelete!: (value: Response) => void;
  let reads = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "DELETE") {
      return new Promise<Response>((resolve) => {
        finishDelete = resolve;
      });
    }
    reads++;
    return response(reads === 1 ? "old" : "new");
  };
  const deletion = adminFetch("/applications/deleted", { method: "DELETE" });
  await setImmediate();
  await adminFetch("/applications");
  finishDelete(response(null));
  await deletion;
  const refreshed = await adminFetch("/applications");
  assert.ok(refreshed.ok);
  assert.equal(refreshed.data, "new");
  assert.equal(reads, 2);
});

test("身份变化后缓存和在途响应都不能作为旧身份成功结果返回", async () => {
  let finish!: (value: Response) => void;
  globalThis.fetch = async () => response("cached-a");
  await adminFetch("/cached");
  globalThis.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = adminFetch("/pending");
  await setImmediate();
  globalThis.fetch = async () => response(principal("session-b"));
  await checkClientSession("");
  finish(response("late-a"));
  const late = await pending;
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.code, "CLIENT_SESSION_CHANGED");
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return response("fresh-b");
  };
  const fresh = await adminFetch("/cached");
  assert.ok(fresh.ok);
  assert.equal(fresh.data, "fresh-b");
  assert.equal(reads, 1);
});

test("短期内不同查询共享身份确认，命中缓存不额外请求 /me", async () => {
  invalidateClientSession();
  let sessions = 0,
    reads = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.cache, "no-store");
    if (String(url).startsWith("/api/v1/me")) {
      sessions++;
      return response(principal());
    }
    reads++;
    return response(String(url));
  };
  await Promise.all([adminFetch("/one"), adminFetch("/two")]);
  await adminFetch("/one");
  await adminFetch("/two");
  assert.equal(sessions, 1);
  assert.equal(reads, 2);
});

test("未知身份时绕过缓存，失败的 /me 不使已授权业务请求不可用", async () => {
  invalidateClientSession();
  let reads = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/v1/me")) throw new TypeError("offline");
    reads++;
    return response(reads);
  };
  assert.equal((await adminFetch("/one")).ok, true);
  assert.equal((await adminFetch("/one")).ok, true);
  assert.equal(reads, 2);
  const write = await adminFetch("/one", { method: "PATCH", body: { value: "old-draft" } });
  assert.ok(!write.ok);
  assert.equal(reads, 2, "身份未知时不发送旧页面的写操作");
});

test("鉴权拒绝清除其他路径缓存，且不会把失败信封缓存", async () => {
  let reads = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/v1/me")) return response(principal());
    if (url === "/denied")
      return Response.json({ success: false, error: { code: "FORBIDDEN" } }, { status: 403 });
    reads++;
    return response(reads);
  };
  await adminFetch("/one");
  const denied = await adminFetch("/denied");
  assert.ok(!denied.ok);
  assert.equal(denied.code, "FORBIDDEN");
  await adminFetch("/one");
  assert.equal(reads, 2);
});

test("已取消的调用不能消费命中缓存，也不会发出写请求", async () => {
  globalThis.fetch = async () => response("cached");
  await adminFetch("/one");
  globalThis.fetch = async () => {
    assert.fail("取消后不应请求");
  };
  for (const method of ["GET", "POST"]) {
    const result = await adminFetch("/one", { method, signal: AbortSignal.abort() });
    assert.ok(!result.ok);
    assert.equal(result.code, "REQUEST_ABORTED");
  }
});

test("调用方修改网络结果或缓存命中对象不会污染后续读取", async () => {
  globalThis.fetch = async () => response([{ nested: { name: "original" } }]);
  const first = await adminFetch<{ nested: { name: string } }[]>("/one");
  assert.ok(first.ok);
  first.data[0].nested.name = "mutated";
  const second = await adminFetch<{ nested: { name: string } }[]>("/one");
  assert.ok(second.ok);
  assert.equal(second.data[0].nested.name, "original");
  second.data.push({ nested: { name: "extra" } });
  const third = await adminFetch<unknown[]>("/one");
  assert.ok(third.ok);
  assert.equal(third.data.length, 1);
});
