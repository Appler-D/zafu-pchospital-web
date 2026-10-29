import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ReactElement, ReactNode } from "react";

import { repairActivitiesPage } from "../../src/config/repair-activities";
import type { RepairActivityPublicView } from "../../src/features/repair-activities/repair-activity-service";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");

type Props = { children?: ReactNode };

function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement<Props>(node)) return text(node.props.children);
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  return "";
}

function findButton(
  node: ReactNode,
  label: string,
): ReactElement<{ disabled?: boolean; onClick?: () => void }> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return undefined;
  }
  if (!React.isValidElement<Props>(node)) return undefined;
  if (text(node.props.children) === label) {
    return node as ReactElement<{ disabled?: boolean; onClick?: () => void }>;
  }
  return findButton(node.props.children, label);
}

function activity(id: string, title: string): RepairActivityPublicView {
  return {
    id,
    title,
    activityAt: "2026-10-24T10:00:00Z",
    capacity: 10,
    signupOpensAt: "2026-10-20T04:00:00Z",
    signupClosesAt: "2026-10-24T09:00:00Z",
    status: "CLOSED",
    registeredCount: 2,
    remaining: 8,
  };
}

function payload(ids: string[], page: number, total: number, totalPages: number) {
  return {
    success: true,
    data: ids.map((id) => activity(id, `活动 ${id}`)),
    meta: { pagination: { page, pageSize: 4, total, totalPages } },
  };
}

async function mount(t: TestContext) {
  const originals = ["fetch"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const requests: {
    url: string;
    init: RequestInit;
    finish(payload: unknown, status?: number): void;
  }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => {
        requests.push({
          url,
          init,
          finish(payload, status = 200) {
            resolve({
              ok: status >= 200 && status < 300,
              json: async () => payload,
            } as Response);
          },
        });
      }),
  );

  const slots: unknown[] = [];
  let cursor = 0;
  let effect: (() => void | (() => void)) | null = null;
  let effectHasRun = false;
  t.mock.method(React, "useState", (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) {
      slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    }
    return [
      slots[index],
      (next: unknown) => {
        slots[index] =
          typeof next === "function" ? (next as (old: unknown) => unknown)(slots[index]) : next;
      },
    ];
  });
  t.mock.method(React, "useRef", (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  });
  t.mock.method(React, "useCallback", (callback: unknown) => callback);
  t.mock.method(React, "useEffect", (callback: () => void | (() => void)) => {
    if (!effectHasRun) effect = callback;
  });
  (globalThis as unknown as { React: typeof React }).React = React;

  const { RepairActivityList } =
    await import("../../src/components/repair-activities/RepairActivityList");
  const view = () => {
    cursor = 0;
    const node = RepairActivityList();
    if (effect) {
      const run = effect;
      effect = null;
      effectHasRun = true;
      run();
    }
    return node;
  };
  t.after(() => {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    view,
    requests,
    async finish(index: number, body: unknown, status = 200) {
      requests[index]!.finish(body, status);
      await setImmediate();
    },
  };
}

test("活动列表首次加载只请求第 1 页，并按 meta.pagination 显示分页", async (t) => {
  const ui = await mount(t);
  ui.view();
  assert.equal(ui.requests.length, 1);
  assert.match(ui.requests[0]!.url, /page=1&pageSize=4/);

  await ui.finish(0, payload(["a", "b", "c", "d"], 1, 10, 3));
  const page = ui.view();
  assert.ok(text(page).includes("活动 a"));
  assert.ok(text(page).includes("1 / 3"));
  assert.equal(findButton(page, repairActivitiesPage.previousPage)?.props.disabled, true);
  assert.equal(findButton(page, repairActivitiesPage.nextPage)?.props.disabled, false);
});

test("翻页时保留上一页、禁用按钮并显示加载文案，成功后替换为新页", async (t) => {
  const ui = await mount(t);
  ui.view();
  await ui.finish(0, payload(["a", "b", "c", "d"], 1, 10, 3));

  findButton(ui.view(), repairActivitiesPage.nextPage)?.props.onClick?.();
  await setImmediate();
  assert.equal(ui.requests.length, 2);
  assert.match(ui.requests[1]!.url, /page=2&pageSize=4/);
  const loading = ui.view();
  assert.ok(text(loading).includes("活动 a"), "翻页中应保留上一页");
  assert.ok(text(loading).includes("正在加载第 2 页…"));
  assert.equal(findButton(loading, repairActivitiesPage.nextPage)?.props.disabled, true);
  assert.equal(findButton(loading, repairActivitiesPage.previousPage)?.props.disabled, true);

  await ui.finish(1, payload(["e", "f", "g", "h"], 2, 10, 3));
  const next = ui.view();
  assert.ok(text(next).includes("活动 e"));
  assert.ok(text(next).includes("2 / 3"));
  assert.equal(text(next).includes("活动 a"), false);
});

test("翻页失败保留当前页并就地提示，按钮恢复可用", async (t) => {
  const ui = await mount(t);
  ui.view();
  await ui.finish(0, payload(["a", "b", "c", "d"], 1, 10, 3));

  findButton(ui.view(), repairActivitiesPage.nextPage)?.props.onClick?.();
  await setImmediate();
  await ui.finish(1, { success: false, error: { message: "第 2 页加载失败" } }, 500);
  const page = ui.view();
  assert.ok(text(page).includes("活动 a"), "失败后应保留当前页");
  assert.ok(text(page).includes("第 2 页加载失败"));
  assert.ok(text(page).includes("1 / 3"));
  assert.equal(findButton(page, repairActivitiesPage.nextPage)?.props.disabled, false);
});

test("翻页中再次点击不会叠加第二个请求", async (t) => {
  const ui = await mount(t);
  ui.view();
  await ui.finish(0, payload(["a", "b", "c", "d"], 1, 10, 3));

  findButton(ui.view(), repairActivitiesPage.nextPage)?.props.onClick?.();
  await setImmediate();
  findButton(ui.view(), repairActivitiesPage.nextPage)?.props.onClick?.();
  await setImmediate();
  assert.equal(ui.requests.length, 2);
});
