import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
import type { AdminApiResult } from "../../src/features/admin/admin-client";

test("共用列表：切换条件取消旧请求，迟到页不混入新查询，连续加载单飞", async (t) => {
  const slots: { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !a || !b || a.length !== b.length || a.some((entry, i) => !Object.is(entry, b[i]));
  t.mock.method(React, "useState", <S>(initial: S | (() => S)) => {
    const i = cursor++;
    if (!(i in slots))
      slots[i] = { value: typeof initial === "function" ? (initial as () => S)() : initial };
    return [
      slots[i].value as S,
      (next: S | ((value: S) => S)) => {
        slots[i].value =
          typeof next === "function" ? (next as (value: S) => S)(slots[i].value as S) : next;
      },
    ];
  });
  t.mock.method(React, "useRef", <S>(initial: S) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { value: { current: initial } };
    return slots[i].value as { current: S };
  });
  t.mock.method(React, "useCallback", <F>(callback: F, deps: readonly unknown[]) => {
    const i = cursor++;
    if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: callback, deps };
    return slots[i].value as F;
  });
  t.mock.method(
    React,
    "useEffect",
    (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = cursor++;
      const old = slots[i];
      if (!old || changed(old.deps, deps))
        effects.push(() => {
          old?.cleanup?.();
          slots[i] = { deps, cleanup: effect() || undefined };
        });
    },
  );
  const { useAdminList } = await import("../../src/components/admin/useAdminList");
  const pending: {
    page: number;
    key: string;
    signal?: AbortSignal;
    finish: (value: AdminApiResult<{ id: string }[]>) => void;
  }[] = [];
  function Render(key: string) {
    cursor = 0;
    effects = [];
    const view = useAdminList(
      (page, signal) =>
        new Promise<AdminApiResult<{ id: string }[]>>((finish) =>
          pending.push({ page, key, signal, finish }),
        ),
      { queryKey: key },
    );
    effects.forEach((effect) => effect());
    return view;
  }
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const result = (id: string): AdminApiResult<{ id: string }[]> => ({
    ok: true,
    data: [{ id }],
    pagination: { page: 1, pageSize: 20, total: 25, totalPages: 2 },
  });
  Render("old");
  assert.equal(pending.length, 1);
  Render("new");
  assert.equal(pending[0].signal?.aborted, true);
  pending[0].finish(result("old"));
  await settle();
  assert.equal(pending.length, 2);
  assert.equal(pending[1].key, "new");
  pending[1].finish(result("new"));
  await settle();
  let view = Render("new");
  assert.deepEqual(view.items, [{ id: "new" }]);
  view.loadMore();
  view.loadMore();
  assert.equal(pending.length, 3);
  assert.equal(pending[2].page, 2);
  Render("reset");
  assert.equal(pending[2].signal?.aborted, true);
  pending[2].finish(result("stale-page"));
  await settle();
  pending[3].finish(result("reset"));
  await settle();
  view = Render("reset");
  assert.deepEqual(view.items, [{ id: "reset" }]);
  assert.equal(view.page, 1);
  slots.forEach((slot) => slot.cleanup?.());
});
