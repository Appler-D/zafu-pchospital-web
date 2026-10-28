import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { browserHintCopy, browserHintDismissedKey } from "../../src/config/browser-hint";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const ReactDOM = require("react-dom") as typeof import("react-dom");

async function mount(t: TestContext, options: { blockedStorage?: boolean } = {}) {
  (globalThis as unknown as { React: typeof React }).React = React;
  const storage = new Map<string, string>();
  const originals = ["navigator", "sessionStorage", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const handlers = new Map<string, (event: { key: string }) => void>();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: {},
      addEventListener: (name: string, handler: (event: { key: string }) => void) =>
        handlers.set(name, handler),
      removeEventListener: (name: string) => handlers.delete(name),
    },
  });
  t.mock.method(ReactDOM, "createPortal", (children: ReactNode) => children);
  t.mock.method(React, "useRef", () => ({ current: null }));
  t.mock.method(React, "useCallback", (callback: unknown) => callback);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile QQ/9.0.0",
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        if (options.blockedStorage) throw new Error("blocked");
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (options.blockedStorage) throw new Error("blocked");
        storage.set(key, value);
      },
    },
  });

  let slots: unknown[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  t.mock.method(React, "useState", (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], (value: unknown) => (slots[index] = value)];
  });
  t.mock.method(React, "useEffect", (callback: () => void) => {
    effects.push(callback);
  });
  const { BrowserHint } = await import("../../src/components/ui/BrowserHint");
  const view = () => {
    cursor = 0;
    effects = [];
    return BrowserHint() as unknown as React.ReactElement<{ children: ReactNode }> | null;
  };
  const hydrate = () => {
    const first = view();
    assert.equal(first, null, "首帧保持与 SSR 一致");
    effects[0]();
    const rendered = view();
    effects[1]();
    return rendered;
  };
  const notice = () => {
    const node = view();
    assert.ok(node);
    return node;
  };
  const html = () => renderToStaticMarkup(notice());
  const close = () => {
    const body = notice().props.children as React.ReactElement<{ children: ReactNode }>;
    const controls = React.Children.toArray(body.props.children);
    (controls.at(-1) as React.ReactElement<{ onClick: () => void }>).props.onClick();
  };
  t.after(() => {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    hydrate,
    html,
    view,
    storage,
    close,
    escape() {
      handlers.get("keydown")?.({ key: "Escape" });
    },
    remount() {
      slots = [];
      handlers.clear();
      return hydrate();
    },
  };
}

test("内置浏览器显示可关闭的提示浮条，关闭状态跨挂载保留", async (t) => {
  const hint = await mount(t);
  hint.hydrate();
  assert.ok(hint.html().includes(browserHintCopy.title));
  assert.match(hint.html(), /role="status"/);
  assert.match(hint.html(), /aria-label="关闭"/);
  assert.match(hint.html(), /当前可能在 QQ 内打开/);
  assert.equal((hint.html().match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(hint.html(), /复制|textarea|<a\b|aria-modal|role="dialog"/);
  hint.close();
  assert.equal(hint.view(), null);
  assert.equal(hint.storage.get(browserHintDismissedKey), "1");
  assert.equal(hint.remount(), null);
});

test("存储受限不影响关闭或 Esc", async (t) => {
  const hint = await mount(t, { blockedStorage: true });
  hint.hydrate();
  hint.close();
  assert.equal(hint.view(), null);
  hint.remount();
  hint.escape();
  assert.equal(hint.view(), null);
});

test("未知 UA 不提示；微信内置浏览器可通过 Esc 关闭", async (t) => {
  const hint = await mount(t);
  Object.assign(navigator, { userAgent: "unknown-client" });
  assert.equal(hint.hydrate(), null);
  Object.assign(navigator, {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) MicroMessenger/8.0.40",
  });
  hint.remount();
  assert.match(hint.html(), /当前可能在 微信 内打开/);
  hint.escape();
  assert.equal(hint.remount(), null);
});

test("桌面 QQ / 微信不渲染提醒，随后切换手机 UA 仍能显示", async (t) => {
  const hint = await mount(t);
  for (const marker of ["QQ/9.9.16", "MicroMessenger/4.0.0"]) {
    Object.assign(navigator, {
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${marker}`,
    });
    assert.equal(hint.remount(), null);
  }
  assert.equal(hint.storage.get(browserHintDismissedKey), undefined);
  Object.assign(navigator, { userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile QQ/9.0.0" });
  hint.remount();
  assert.match(hint.html(), /当前可能在 QQ 内打开/);
});

test("共用登录面板在两种模式保留流程入口，提醒与表单、账号链接顺序正确", async () => {
  (globalThis as unknown as { React: typeof React }).React = React;
  const [
    { LoginPanel },
    { BrowserHint },
    { RepairWorkflowLink },
    { LoginForm },
    { InviteRegistrationForm },
  ] = await Promise.all([
    import("../../src/components/auth/LoginPanel"),
    import("../../src/components/ui/BrowserHint"),
    import("../../src/components/ui/RepairWorkflowLink"),
    import("../../src/components/auth/LoginForm"),
    import("../../src/components/auth/InviteRegistrationForm"),
  ]);
  for (const mode of ["login", "register"] as const) {
    const panel = LoginPanel({ mode, returnTo: "/member/repair-activities/a" });
    const children = React.Children.toArray(panel.props.children) as React.ReactElement<{
      returnTo?: string;
      children?: ReactNode;
    }>[];
    assert.equal(children[0].type, BrowserHint);
    assert.equal(children[1].type, mode === "login" ? LoginForm : InviteRegistrationForm);
    assert.deepEqual(children[0].props, {});
    assert.equal(children[1].props.returnTo, "/member/repair-activities/a");
    const links = React.Children.toArray(children[2].props.children) as React.ReactElement<{
      className?: string;
    }>[];
    assert.equal(links.at(-2)?.type, RepairWorkflowLink);
    assert.equal(links.at(-1)?.props.className, "auth-login__home");
  }
  const html = renderToStaticMarkup(RepairWorkflowLink());
  assert.match(html, /href="\/handbook\/Manual\/Workflow.html"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /新标签页打开/);
});
