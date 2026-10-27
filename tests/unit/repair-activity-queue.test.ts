import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ReactElement, ReactNode } from "react";
import type { RepairActivityQueueView } from "../../src/features/repair-activities/repair-activity-service";
import { repairActivitiesPage } from "../../src/config/repair-activities";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const copy = repairActivitiesPage.detail.queue;
const sample = (waitingCount: number | null): RepairActivityQueueView => ({
  waitingCount,
  observedAt: "2026-10-27T10:30:00Z",
});
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function liveText(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(liveText);
  if (React.isValidElement<{ children?: ReactNode; "aria-live"?: string }>(node)) {
    if (node.props["aria-live"] === "polite") return [text(node.props.children)];
    return liveText(node.props.children);
  }
  return [];
}
function refreshButton(node: ReactNode): ReactElement<{ disabled: boolean; onClick(): void }> {
  if (React.isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) {
    if (node.props.onClick) return node as ReturnType<typeof refreshButton>;
    return refreshButton(node.props.children);
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = refreshButton(child);
      if (found) return found;
    }
  }
  return undefined as unknown as ReturnType<typeof refreshButton>;
}

/** 复用现有详情测试的 hook/effect 驱动方式，运行真实组件与 fetch 分支。 */
async function mount(t: TestContext, ignoreAbort = false) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-27T10:30:00Z") });
  (globalThis as unknown as { React: typeof React }).React = React;
  const originalCss = require.extensions[".css"];
  require.extensions[".css"] = (module) => {
    module.exports = {};
  };
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
    value: { setTimeout, clearTimeout, ...events },
  });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const slots: unknown[] = [];
  let cursor = 0;
  let id = "a";
  let previousId: string | undefined;
  let cleanup: (() => void) | undefined;
  let effect: (() => void | (() => void)) | undefined;
  t.mock.method(React, "useState", <S>(initial: S) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [
      slots[index],
      (value: S) => {
        slots[index] = value;
      },
    ];
  });
  t.mock.method(React, "useRef", <T>(initial: T) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  });
  t.mock.method(React, "useEffect", (callback: () => void | (() => void)) => {
    if (id !== previousId) effect = callback;
  });
  const requests: {
    url: string;
    init: RequestInit;
    signal: AbortSignal;
    finish(value: Response): void;
  }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (url: string, init: RequestInit) =>
      new Promise<Response>((finish, reject) => {
        const signal = init.signal as AbortSignal;
        if (!ignoreAbort)
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        requests.push({ url, init, signal, finish });
      }),
  );
  const { RepairActivityQueue } =
    await import("../../src/components/repair-activities/RepairActivityQueue");
  const view = () => {
    cursor = 0;
    const node = RepairActivityQueue({ activityId: id });
    if (effect) {
      cleanup?.();
      previousId = id;
      cleanup = effect() || undefined;
      effect = undefined;
    }
    return node;
  };
  t.after(async () => {
    cleanup?.();
    await setImmediate();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (originalCss) require.extensions[".css"] = originalCss;
    else delete require.extensions[".css"];
  });
  view();
  return {
    view,
    requests,
    visibility(value: string) {
      document.visibilityState = value;
      handlers.get("visibilitychange")?.();
    },
    focus() {
      handlers.get("focus")?.();
    },
    changeId(value: string) {
      id = value;
      view();
    },
    unmount() {
      cleanup?.();
      cleanup = undefined;
    },
    async finish(index: number, data: RepairActivityQueueView | null, code = "INTERNAL_ERROR") {
      requests[index].finish(
        data
          ? Response.json({ success: true, data })
          : Response.json(
              { success: false, error: { code } },
              { status: code === "INTERNAL_ERROR" ? 500 : 404 },
            ),
      );
      await setImmediate();
    },
  };
}

test("#244 首次失败不冒充 0，恢复显示 0；更新失败保留旧人数与时间", async (t) => {
  const ui = await mount(t);
  assert.equal(ui.requests[0].url, "/api/v1/repair-activities/a/queue");
  assert.equal(ui.requests[0].init.cache, "no-store");
  await ui.finish(0, null);
  assert.ok(text(ui.view()).includes(copy.unavailable));
  assert.equal(text(ui.view()).includes(copy.waiting), false);
  refreshButton(ui.view()).props.onClick();
  await ui.finish(1, sample(0));
  assert.ok(text(ui.view()).includes("0" + " " + copy.waiting));
  refreshButton(ui.view()).props.onClick();
  await ui.finish(2, null);
  assert.ok(text(ui.view()).includes(copy.stale));
  assert.ok(text(ui.view()).includes(copy.lastUpdated.split("{time}")[0]));
  assert.ok(text(ui.view()).includes("0" + " " + copy.waiting));
  refreshButton(ui.view()).props.onClick();
  await ui.finish(3, sample(6));
  assert.ok(text(ui.view()).includes("6" + " " + copy.waiting));
  assert.equal(text(ui.view()).includes(copy.stale), false);
});

test("#244 轮询不叠加；隐藏/切目标取消请求，迟到结果不覆盖，卸载后不再取数", async (t) => {
  const ui = await mount(t, true);
  await ui.finish(0, sample(6));
  t.mock.timers.tick(30_000);
  assert.equal(ui.requests.length, 2);
  ui.focus();
  assert.equal(ui.requests.length, 2);
  ui.visibility("hidden");
  assert.equal(ui.requests[1].signal.aborted, true);
  t.mock.timers.tick(90_000);
  assert.equal(ui.requests.length, 2);
  ui.visibility("visible");
  await ui.finish(2, sample(4));
  await ui.finish(1, sample(99));
  assert.ok(text(ui.view()).includes("4" + " " + copy.waiting));
  ui.focus();
  ui.changeId("b");
  assert.equal(ui.requests[3].signal.aborted, true);
  assert.equal(ui.requests[4].url, "/api/v1/repair-activities/b/queue");
  await ui.finish(4, sample(2));
  await ui.finish(3, sample(88));
  assert.ok(text(ui.view()).includes("2" + " " + copy.waiting));
  ui.unmount();
  t.mock.timers.tick(120_000);
  assert.equal(ui.requests.length, 5);
});

test("#244 未开放有独立提示，活动结束后停止自动与手动取数", async (t) => {
  const ui = await mount(t);
  await ui.finish(0, sample(null));
  assert.ok(text(ui.view()).includes(copy.notOpen));
  assert.equal(text(ui.view()).includes(copy.waiting), false);
  t.mock.timers.tick(30_000);
  await ui.finish(1, null, "ACTIVITY_ENDED");
  assert.ok(text(ui.view()).includes(copy.ended));
  assert.equal(refreshButton(ui.view()).props.disabled, true);
  ui.focus();
  t.mock.timers.tick(120_000);
  assert.equal(ui.requests.length, 2);
});

test("#244 请求超时解除忙碌并按 30 秒退避，不能永久挂住刷新", async (t) => {
  const ui = await mount(t);
  t.mock.timers.tick(10_000);
  await setImmediate();
  assert.equal(ui.requests[0].signal.aborted, true);
  assert.ok(text(ui.view()).includes(copy.unavailable));
  assert.equal(refreshButton(ui.view()).props.disabled, false);
  t.mock.timers.tick(29_999);
  assert.equal(ui.requests.length, 1);
  t.mock.timers.tick(1);
  assert.equal(ui.requests.length, 2);
});

test("#244 普通同步只更新时间，不重复宣告；人数变化、失败和结束有简短播报", async (t) => {
  const ui = await mount(t);
  assert.deepEqual(liveText(ui.view()), [""]);
  await ui.finish(0, sample(6));
  assert.deepEqual(liveText(ui.view()), [`6 ${copy.waiting}`]);

  t.mock.timers.tick(30_000);
  await ui.finish(1, { ...sample(6), observedAt: "2026-10-27T10:31:00Z" });
  assert.ok(text(ui.view()).includes("18:31"), "可见更新时间仍正常变化");
  assert.deepEqual(liveText(ui.view()), [`6 ${copy.waiting}`], "更新时间不能进入播报区域");

  ui.focus();
  await ui.finish(2, sample(3));
  assert.deepEqual(liveText(ui.view()), [`3 ${copy.waiting}`]);
  ui.focus();
  await ui.finish(3, null);
  assert.deepEqual(liveText(ui.view()), [copy.stale]);
  ui.focus();
  await ui.finish(4, null, "ACTIVITY_ENDED");
  assert.deepEqual(liveText(ui.view()), [copy.ended]);
});
