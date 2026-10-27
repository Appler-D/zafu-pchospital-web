import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { useBoardResource } from "../../src/components/repair-activities/useBoardResource";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
type Effect = { deps?: unknown[]; setup: () => void | (() => void); cleanup?: () => void };

/** refs 与已提交树共享，memo/effect 的候选槽位可丢弃，复现并发 render 的提交边界。 */
function harness(t: TestContext) {
  const original = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: () => 1,
      clearInterval() {},
      addEventListener() {},
      removeEventListener() {},
    },
  });
  let slots: unknown[] = [],
    draft: unknown[] = [],
    cursor = 0;
  let effects: Effect[] = [],
    nextEffects: Effect[] = [];
  const same = (a?: unknown[], b?: unknown[]) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);
  t.mock.method(React, "useState", (initial: unknown) => {
    const index = cursor++;
    draft[index] ??= initial;
    return [draft[index], () => {}];
  });
  t.mock.method(React, "useRef", (initial: unknown) => {
    const index = cursor++;
    draft[index] ??= { current: initial };
    return draft[index];
  });
  t.mock.method(React, "useMemo", (factory: () => unknown, deps: unknown[]) => {
    const index = cursor++;
    const old = draft[index] as { deps: unknown[]; value: unknown } | undefined;
    if (!same(old?.deps, deps)) draft[index] = { deps, value: factory() };
    return (draft[index] as { value: unknown }).value;
  });
  const effect = (setup: Effect["setup"], deps?: unknown[]) => {
    nextEffects.push({ setup, deps });
  };
  t.mock.method(React, "useLayoutEffect", effect);
  t.mock.method(React, "useEffect", effect);
  const useResource = (id: string, options = { paused: false, succeeded: () => {} }) => {
    draft = [...slots];
    cursor = 0;
    nextEffects = [];
    return useBoardResource<{ value: string }>(id, "live", {
      ...options,
      automatic: true,
      interval: 5_000,
    });
  };
  const commit = () => {
    slots = draft;
    for (const [i, next] of nextEffects.entries()) {
      const old = effects[i];
      if (old && same(old.deps, next.deps)) next.cleanup = old.cleanup;
      else {
        old?.cleanup?.();
        const cleanup = next.setup();
        if (typeof cleanup === "function") next.cleanup = cleanup;
      }
    }
    effects = nextEffects;
  };
  t.after(() => {
    for (const effect of effects) effect.cleanup?.();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { render: useResource, commit };
}

test("放弃 B 的候选渲染不终止 A 在途读取，也不泄漏 B 的暂停状态或成功回调", async (t) => {
  const ui = harness(t);
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const callbacks: string[] = [];
  t.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  const a = ui.render("A", { paused: false, succeeded: () => callbacks.push("A") });
  ui.commit();
  ui.render("B", { paused: true, succeeded: () => callbacks.push("B") });
  assert.equal(signal?.aborted, false);
  resolve(Response.json({ success: true, data: { value: "A snapshot" } }));
  await setImmediate();
  assert.equal(a.state.data?.value, "A snapshot");
  assert.deepEqual(callbacks, ["A"]);
  assert.equal(ui.render("A"), a, "放弃候选后继续复用已提交的 A 读取器");
});

test("提交 A→B→A 同步失效旧请求，迟到的第一轮 A 不覆盖新 A", async (t) => {
  const ui = harness(t);
  const requests: { resolve: (response: Response) => void; signal?: AbortSignal | null }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve) => requests.push({ resolve, signal: init?.signal })),
  );
  const a = ui.render("A");
  ui.commit();
  ui.render("B");
  ui.commit();
  const nextA = ui.render("A");
  ui.commit();
  assert.notEqual(a, nextA);
  assert.equal(requests[0].signal?.aborted, true);
  assert.equal(requests[1].signal?.aborted, true);
  requests[2].resolve(Response.json({ success: true, data: { value: "new A" } }));
  await setImmediate();
  requests[0].resolve(Response.json({ success: true, data: { value: "old A" } }));
  await setImmediate();
  assert.equal(nextA.state.data?.value, "new A");
  assert.equal(a.state.data, null);
});
