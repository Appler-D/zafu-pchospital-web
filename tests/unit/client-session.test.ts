import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  checkClientSession,
  clientSessionRevision,
  getClientSession,
  invalidateClientSession,
  onClientSessionEvent,
  sessionMutationFetch,
  watchClientSession,
} from "../../src/lib/auth/client-session";
import type { AccountMeView } from "../../src/types/contracts";

const originalFetch = globalThis.fetch;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const principal = (overrides: Partial<AccountMeView> = {}): AccountMeView => ({
  userId: "admin-a",
  sessionId: "session-a",
  displayName: "管理员",
  roles: ["ADMIN"],
  permissions: ["member:manage"],
  memberProfileId: null,
  memberStatus: null,
  mustChangePassword: false,
  rememberMe: false,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  accountAccess: { state: "READY", destination: "/admin", exemptionExpiresAt: null },
  ...overrides,
});
const reply = (data = principal()) => Response.json({ success: true, data });

beforeEach(async () => {
  Reflect.deleteProperty(globalThis, "window");
  globalThis.fetch = async () => reply();
  await sessionMutationFetch("/reset", { method: "POST" });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateClientSession();
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("并发确认共用 /me，15 秒内复用身份；到期按需复查，不常驻轮询", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return reply();
  };
  await Promise.all(Array.from({ length: 20 }, () => getClientSession()));
  assert.equal(requests, 1);
  t.mock.timers.tick(14_999);
  await getClientSession();
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await getClientSession();
  assert.equal(requests, 2);
});

test("身份确认不越过会话或有效豁免期限", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return reply(
      principal({
        expiresAt: new Date(9_000).toISOString(),
        accountAccess: {
          state: "READY",
          destination: "/admin",
          exemptionExpiresAt: new Date(5_000).toISOString(),
        },
      }),
    );
  };
  await getClientSession();
  t.mock.timers.tick(5_000);
  await getClientSession();
  assert.equal(requests, 2);
  t.mock.timers.tick(4_000);
  await getClientSession();
  assert.equal(requests, 3);
});

test("会话轮换、角色/权限和账号门禁变化都会提升身份代次", async () => {
  const changes: string[] = [];
  const unsubscribe = onClientSessionEvent((event) => changes.push(event.type));
  try {
    await getClientSession();
    for (const override of [
      { sessionId: "session-b" },
      { userId: "admin-b" },
      { roles: ["MEMBER"] as AccountMeView["roles"] },
      { permissions: [] },
      {
        accountAccess: {
          state: "PASSWORD_CHANGE_REQUIRED" as const,
          destination: "/account/change-password",
          exemptionExpiresAt: null,
        },
      },
    ]) {
      const before = clientSessionRevision();
      globalThis.fetch = async () => reply(principal(override));
      await checkClientSession();
      assert.ok(clientSessionRevision() > before);
    }
    assert.equal(changes.filter((event) => event === "change").length, 5);
  } finally {
    unsubscribe();
  }
});

test("失效前开始的 /me 即使成功也不能恢复旧身份", async () => {
  let finish!: (value: Response) => void;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const task = checkClientSession();
  await setImmediate();
  invalidateClientSession();
  finish(reply());
  assert.deepEqual(await task, { ok: false, status: 0, stale: true });
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return reply(principal({ sessionId: "new" }));
  };
  const result = await getClientSession();
  assert.ok(result.ok);
  assert.equal(result.data.sessionId, "new");
  assert.equal(reads, 1);
});

test("取消一个等待者不取消共享确认，也不阻塞其他等待者", async () => {
  let finish!: (value: Response) => void;
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const controller = new AbortController();
  const cancelled = getClientSession(controller.signal);
  const active = getClientSession();
  await setImmediate();
  controller.abort();
  assert.deepEqual(await cancelled, { ok: false, status: 0, stale: true });
  finish(reply());
  assert.equal((await active).ok, true);
  assert.equal(requests, 1);
});

test("存储事件尚未投递时，读取共享标记也会同步作废身份确认", async () => {
  let value: string | null = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: () => value },
      location: { href: "http://localhost/admin" },
    },
  });
  await getClientSession();
  const before = clientSessionRevision();
  value = "another-tab-changed-session";
  assert.ok(clientSessionRevision() > before);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return reply();
  };
  await getClientSession();
  assert.equal(requests, 1);
});

test("存储禁用时仍接收通道通知，清理监听器时关闭通道", async () => {
  let handler!: (event: MessageEvent<unknown>) => void;
  let closed = false;
  const events: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      get localStorage() {
        throw new Error("disabled");
      },
      addEventListener() {},
      removeEventListener() {},
      BroadcastChannel: class {
        set onmessage(value: (event: MessageEvent<unknown>) => void) {
          handler = value;
        }
        close() {
          closed = true;
        }
      },
    },
  });
  const unwatch = watchClientSession((event) => events.push(event.type));
  const before = clientSessionRevision();
  handler({ data: "remote-change" } as MessageEvent<unknown>);
  assert.ok(clientSessionRevision() > before);
  assert.deepEqual(events, ["invalidate"]);
  unwatch();
  assert.ok(closed);
});

test("会话写入在请求前后通知失效；网络失败也保留第二次通知且不保存凭据", async () => {
  const stored: string[] = [];
  const events: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { setItem: (_key: string, value: string) => stored.push(value) },
    },
  });
  const unsubscribe = onClientSessionEvent((event) => events.push(event.type));
  globalThis.fetch = async () => {
    assert.equal(events.length, 1);
    throw new TypeError("uncertain response");
  };
  try {
    await assert.rejects(
      sessionMutationFetch("/login", { method: "POST", body: "private-password" }),
    );
    assert.equal(events.length, 2);
    assert.equal(stored.length, 2);
    assert.notEqual(stored[0], stored[1]);
    assert.ok(stored.every((value) => /^[0-9a-f-]{36}$/.test(value)));
  } finally {
    unsubscribe();
  }
});

test("非 JSON 的 401 仍是会话失效，不能降级为网络失败", async () => {
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  assert.deepEqual(await checkClientSession(), { ok: false, status: 401 });
});

test("慢响应跨过会话或豁免期限时不能继续确认可用身份", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  for (const deadline of ["session", "gate"] as const) {
    let finish!: (value: Response) => void;
    const data = principal(
      deadline === "session"
        ? { expiresAt: new Date(Date.now() + 1_000).toISOString() }
        : {
            accountAccess: {
              state: "READY",
              destination: "/admin",
              exemptionExpiresAt: new Date(Date.now() + 1_000).toISOString(),
            },
          },
    );
    globalThis.fetch = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = checkClientSession();
    await setImmediate();
    t.mock.timers.tick(2_000);
    finish(reply(data));
    const result = await pending;
    assert.ok(!result.ok);
    assert.equal(result.status, deadline === "session" ? 401 : 0);
  }
});
