import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ReactElement, ReactNode } from "react";
import type { RepairActivityPublicView } from "../../src/features/repair-activities/repair-activity-service";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
type Props = { children?: ReactNode };
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" ? node : "";
}
const activity: RepairActivityPublicView = {
  id: "a",
  title: "原活动",
  capacity: 10,
  registeredCount: 2,
  remaining: 8,
  activityAt: "2026-10-24T10:00:00Z",
  signupOpensAt: "2026-10-24T04:00:00Z",
  signupClosesAt: "2026-10-24T09:00:00Z",
  status: "UPCOMING",
};

/** 与既有客户端测试相同的 hook 存储方式；只驱动真实 JSX/effect，不启动 Next 或 DB。 */
async function mount(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-24T04:00:01Z") });
  (globalThis as unknown as { React: typeof React }).React = React;
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const handlers = new Map<string, () => void>();
  const events = {
    addEventListener: (name: string, fn: () => void) => handlers.set(name, fn),
    removeEventListener: (name: string) => handlers.delete(name),
  };
  const document = { visibilityState: "visible", ...events };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setInterval, clearInterval, ...events },
  });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const slots: unknown[] = [];
  const effects: { deps?: unknown[]; cleanup?: () => void }[] = [];
  const callbacks: { deps?: unknown[]; callback: unknown }[] = [];
  let cursor = 0,
    effectIndex = 0,
    callbackIndex = 0,
    id = "a";
  let pending: (() => void)[] = [];
  const changed = (old: unknown[] | undefined, next: unknown[] | undefined) =>
    !old ||
    !next ||
    old.length !== next.length ||
    old.some((value, i) => !Object.is(value, next[i]));
  t.mock.method(React, "useState", <S>(initial: S | (() => S)) => {
    const index = cursor++;
    if (!(index in slots))
      slots[index] = typeof initial === "function" ? (initial as () => S)() : initial;
    return [
      slots[index],
      (value: S | ((old: S) => S)) => {
        slots[index] =
          typeof value === "function" ? (value as (old: S) => S)(slots[index] as S) : value;
      },
    ];
  });
  t.mock.method(React, "useRef", <T>(initial: T) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  });
  t.mock.method(React, "useCallback", (callback: unknown, deps?: unknown[]) => {
    const index = callbackIndex++;
    if (!callbacks[index] || changed(callbacks[index].deps, deps))
      callbacks[index] = { deps, callback };
    return callbacks[index].callback;
  });
  t.mock.method(React, "useEffect", (effect: () => void | (() => void), deps?: unknown[]) => {
    const index = effectIndex++;
    const previous = effects[index];
    if (previous && !changed(previous.deps, deps)) return;
    pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    });
  });
  const requests: { url: string; signal: AbortSignal; finish(response: Response): void }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (url: string, init: RequestInit) =>
      new Promise<Response>((finish) => {
        requests.push({ url, signal: init.signal as AbortSignal, finish });
      }),
  );
  const { RepairActivityDetail } =
    await import("../../src/components/repair-activities/RepairActivityDetail");
  const view = () => {
    cursor = effectIndex = callbackIndex = 0;
    const node = RepairActivityDetail({ activityId: id });
    const queue = pending;
    pending = [];
    queue.forEach((run) => run());
    return node;
  };
  t.after(() => {
    effects.forEach((slot) => slot.cleanup?.());
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  view();
  return {
    view,
    requests,
    changeId(value: string) {
      id = value;
      view();
    },
    visibility(value: string) {
      document.visibilityState = value;
      handlers.get("visibilitychange")?.();
    },
    focus() {
      handlers.get("focus")?.();
    },
    async finish(index: number, data: RepairActivityPublicView | null) {
      requests[index].finish(
        data
          ? Response.json({ success: true, data })
          : Response.json({ success: false, error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
      );
      await setImmediate();
    },
  };
}

test("活动轮询慢请求不叠加，隐藏时暂停，迟到响应与失败不覆盖已有内容", async (t) => {
  const ui = await mount(t);
  await ui.finish(0, activity);
  ui.view(); // 倒计时已归零，但服务端仍返回 UPCOMING，启动 30 秒复查。
  assert.equal(ui.requests.length, 2);
  t.mock.timers.tick(90_000);
  assert.equal(ui.requests.length, 2, "三个轮询节拍仍共用唯一在途请求");
  ui.visibility("hidden");
  assert.equal(ui.requests[1].signal.aborted, true);
  t.mock.timers.tick(90_000);
  assert.equal(ui.requests.length, 2);
  ui.visibility("visible");
  assert.equal(ui.requests.length, 3);
  await ui.finish(1, { ...activity, title: "已失效响应", status: "OPEN" });
  assert.equal(text(ui.view()).includes("已失效响应"), false);
  await ui.finish(2, null);
  assert.ok(text(ui.view()).includes("原活动"), "后台失败保留原内容");
  ui.focus();
  assert.equal(ui.requests.length, 4);
  await ui.finish(3, { ...activity, title: "最新活动", status: "OPEN" });
  assert.ok(text(ui.view()).includes("最新活动"));
  t.mock.timers.tick(60_000);
  assert.equal(ui.requests.length, 4, "状态已开放，停止等待开放的轮询");
});

test("切换活动会使旧请求失效，旧活动响应不能覆盖新目标", async (t) => {
  const ui = await mount(t);
  ui.changeId("b");
  assert.equal(ui.requests[0].signal.aborted, true);
  assert.equal(ui.requests[1].url, "/api/v1/repair-activities/b");
  await ui.finish(1, { ...activity, id: "b", title: "新目标", status: "OPEN" });
  await ui.finish(0, { ...activity, title: "旧目标", status: "OPEN" });
  const node: ReactElement = ui.view();
  assert.ok(text(node).includes("新目标"));
  assert.equal(text(node).includes("旧目标"), false);
});
