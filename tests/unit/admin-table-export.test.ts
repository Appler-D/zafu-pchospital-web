import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ReactElement } from "react";
import { tableCopy } from "../../src/config/admin-tables";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");

test("导出计数缺失或非法时拒绝下载，不误报空结果或 NaN；真实零条仍提示空结果", async (t) => {
  (globalThis as unknown as { React: typeof React }).React = React;
  t.mock.method(React, "useState", <S>(initial: S) => [initial, () => {}]);
  t.mock.method(React, "useRef", <S>(initial: S) => ({ current: initial }));
  let response = new Response();
  t.mock.method(globalThis, "fetch", async () => response);
  const { AdminTableExport } = await import("../../src/components/admin/AdminTableExport");
  for (const rawCount of [null, "not-a-number", "0"]) {
    response = new Response("csv", {
      headers: rawCount === null ? {} : { "X-Export-Row-Count": rawCount },
    });
    let blobReads = 0;
    t.mock.method(response, "blob", async () => {
      blobReads++;
      return new Blob(["csv"]);
    });
    const errors: string[] = [];
    const successes: string[] = [];
    const view = AdminTableExport({
      path: "/export",
      params: () => new URLSearchParams(),
      disabled: false,
      onError: (message) => errors.push(message),
      onDone: (message) => successes.push(message),
    }) as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    view.props.children[0].props.onClick();
    await setImmediate();
    assert.equal(blobReads, 0);
    assert.deepEqual(successes, []);
    assert.equal(errors.at(-1), rawCount === "0" ? tableCopy.exportEmpty : tableCopy.exportFailed);
  }
});
