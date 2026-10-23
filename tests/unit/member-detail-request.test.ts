import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { ReactElement, ReactNode } from "react";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
type Props = {
  children?: ReactNode;
  rowProps?: (row: { id: string }) => Record<string, unknown>;
  renderContext?: { onView(id: string): void };
  memberId?: string;
};
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

test("成员表悬停不读取敏感详情，显式查看仍打开原详情弹层", async (t) => {
  (globalThis as unknown as { React: typeof React }).React = React;
  const slots: unknown[] = [];
  let cursor = 0;
  t.mock.method(React, "useState", <S>(initial: S | (() => S)) => {
    const index = cursor++;
    if (!(index in slots)) {
      const value = typeof initial === "function" ? (initial as () => S)() : initial;
      slots[index] = value === "loading" ? "ready" : value;
    }
    return [
      slots[index],
      (value: S | ((old: S) => S)) => {
        slots[index] =
          typeof value === "function" ? (value as (old: S) => S)(slots[index] as S) : value;
      },
    ];
  });
  t.mock.method(React, "useRef", <T>(initial: T) => ({ current: initial }));
  t.mock.method(React, "useEffect", () => {});
  t.mock.method(React, "useLayoutEffect", () => {});
  t.mock.method(React, "useCallback", (callback: unknown) => callback);
  t.mock.method(React, "useMemo", (factory: () => unknown) => factory());
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ success: true, data: [] });
  });
  const { MemberAdminPanel } = await import("../../src/components/admin/MemberAdminPanel");
  const view = () => {
    cursor = 0;
    return MemberAdminPanel();
  };
  const table = elements(view()).find((element) => element.props.rowProps);
  assert.ok(table);
  for (const id of ["member-a", "member-b", "member-a"]) {
    const row = table.props.rowProps!({ id });
    assert.equal(row.onMouseEnter, undefined);
    assert.equal(row.onPointerEnter, undefined);
  }
  assert.equal(requests, 0);
  table.props.renderContext!.onView("member-a");
  assert.equal(
    elements(view()).filter((element) => element.props.memberId === "member-a").length,
    1,
  );
});
