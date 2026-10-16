import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ReactElement, ReactNode } from "react";
import { accountEmailCopy as copy } from "../../src/config/account-email";
import type { AccountEmailState } from "../../src/types/contracts";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime");
const { SearchParamsContext } = require("next/dist/shared/lib/hooks-client-context.shared-runtime");
type Props = {
  children?: ReactNode;
  type?: string;
  disabled?: boolean;
  value?: string;
  role?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void;
};
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

/** Node 原生 mock 驱动真实表单的事件处理器；不启动 Next / DB，不复制业务状态机。
 * 只替换 React hook 的存储与路由上下文，返回的控件仍取自 AccountEmailForm JSX。
 */
async function form(t: TestContext, state: AccountEmailState, responses: unknown[]) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setInterval, clearInterval },
  });
  (globalThis as unknown as { React: typeof React }).React = React;
  const slots: unknown[] = [],
    effects: (() => void | (() => void))[] = [];
  let cursor = 0,
    mounted = false;
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
  t.mock.method(React, "useEffect", (effect: () => void | (() => void)) => {
    if (!mounted) effects.push(effect);
  });
  t.mock.method(React, "useMemo", (factory: () => unknown) => factory());
  t.mock.method(React, "useContext", (context: unknown) => {
    if (context === AppRouterContext) return { replace() {}, refresh() {} };
    if (context === SearchParamsContext) return new URLSearchParams();
    throw new Error("Unexpected context");
  });
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({ success: true, data: state });
    requests.push(JSON.parse(String(init.body)));
    const response = responses.shift();
    assert.ok(response, "Unexpected extra request / automatic resend");
    return Response.json(response);
  });
  const { AccountEmailForm } = await import("../../src/components/account/AccountEmailForm");
  const view = () => {
    cursor = 0;
    return AccountEmailForm();
  };
  const button = (label: string) => {
    const found = elements(view()).find(
      (element) => typeof element.type !== "string" && element.props.children === label,
    );
    assert.ok(found, `Missing button: ${label}`);
    return found.props;
  };
  const input = (type: string) => {
    const found = elements(view()).find(
      (element) => element.type === "input" && element.props.type === type,
    );
    assert.ok(found, `Missing input: ${type}`);
    return found.props;
  };
  const code = () => {
    const found = elements(view())
      .filter((element) => element.type === "input")
      .at(-1);
    assert.ok(found);
    return found.props;
  };
  view();
  mounted = true;
  const cleanup = effects.map((effect) => effect());
  t.after(() => {
    for (const run of cleanup) if (run) run();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  await setImmediate();
  return { view, button, input, code, requests, settle: setImmediate };
}
const challenge = {
  success: true,
  data: {
    challengeId: "test-challenge",
    maskedEmail: "t***@example.com",
    expiresAt: "2026-10-16T10:00:00Z",
  },
};
const state: AccountEmailState = {
  email: "old@example.com",
  verified: true,
  mailEnabled: true,
  assistance: null,
  exemption: null,
};

test("发码密码错误后，修改密码即可再次手动发送，不制造 60 秒冷却", async (t) => {
  const ui = await form(t, state, [
    { success: false, error: { code: "PASSWORD_CURRENT_INVALID", message: "mock rejection" } },
    challenge,
  ]);
  assert.ok(text(ui.view()).includes(copy.sessionNotice));
  assert.equal(text(ui.view()).includes(copy.success), false);
  ui.input("password").onChange!({ target: { value: "wrong" } });
  ui.button(copy.sendOld).onClick!();
  await ui.settle();
  assert.equal(ui.button(copy.sendOld).disabled, false);
  ui.input("password").onChange!({ target: { value: "correct" } });
  assert.equal(ui.button(copy.sendOld).disabled, false);
  ui.button(copy.sendOld).onClick!();
  await ui.settle();
  assert.deepEqual(ui.requests, [
    { mode: "OLD", currentPassword: "wrong" },
    { mode: "OLD", currentPassword: "correct" },
  ]);
  assert.equal(ui.button(copy.sendOld).disabled, true); // 成功发送才保留冷却；未推进模拟时间。
});

test("目标邮箱重发 SMTP 失败后，清除旧证明及验证码，禁用确认并保留发送冷却", async (t) => {
  const ui = await form(
    t,
    {
      ...state,
      assistance: {
        id: "fixed-assistance",
        targetEmail: "new@example.com",
        expiresAt: "2026-10-16T10:30:00Z",
      },
    },
    [
      challenge,
      { success: false, error: { code: "EMAIL_SEND_FAILED", message: "mock delivery failed" } },
    ],
  );
  ui.input("password").onChange!({ target: { value: "correct" } });
  ui.button(copy.sendNew).onClick!();
  await ui.settle();
  ui.code().onChange!({ target: { value: "123456" } });
  assert.equal(ui.button(copy.confirm).disabled, false);
  t.mock.timers.tick(60_000);
  assert.equal(ui.button(copy.sendNew).disabled, false);
  ui.button(copy.sendNew).onClick!();
  await ui.settle();
  assert.equal(ui.code().value, "");
  assert.equal(ui.button(copy.confirm).disabled, true);
  assert.equal(ui.button(copy.sendNew).disabled, true);
  assert.ok(text(ui.view()).includes(`60${copy.seconds}`));
  assert.ok(text(ui.view()).includes(state.email!));
  assert.equal(ui.requests.length, 2);
});
