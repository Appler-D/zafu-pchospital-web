import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ReactElement, ReactNode } from "react";
import { accountEmailCopy as copy } from "../../src/config/account-email";
import { adminCopy } from "../../src/config/admin";
import { passwordRecoveryCopy as recoveryCopy } from "../../src/config/password-recovery";
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
  name?: string;
  href?: string;
  "aria-label"?: string;
  onSubmit?: (event: { preventDefault(): void }) => void;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void;
  /** 恢复工具窗口的关闭回调：用它数「当前挂着几个弹层」。 */
  onClose?: () => void;
  /** 登录 / 注册表单收到的候选回跳目标。 */
  returnTo?: string | null;
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
 * `emailProps` 只用于门禁（任务 6）用例：这些值在生产里一律由服务端页面组件传入。
 */
async function form(
  t: TestContext,
  state: AccountEmailState,
  responses: unknown[],
  component?: () => ReactElement,
  emailProps?: { continueTo?: string | null; returnTo?: string | null; canRecover?: boolean },
) {
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
  const destinations: string[] = [];
  /** 「刷新状态」有没有真的重放当前 RSC 请求；由服务端重算页面 props。 */
  const refreshes: string[] = [];
  t.mock.method(React, "useContext", (context: unknown) => {
    if (context === AppRouterContext)
      return {
        replace(path: string) {
          destinations.push(path);
        },
        refresh() {
          refreshes.push("refresh");
        },
      };
    if (context === SearchParamsContext) return new URLSearchParams();
    throw new Error("Unexpected context");
  });
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({ success: true, data: state });
    requests.push(JSON.parse(String(init.body)));
    const response = await responses.shift();
    assert.ok(response, "Unexpected extra request / automatic resend");
    if (response instanceof Error) throw response;
    return Response.json(response);
  });
  const { AccountEmailForm } = await import("../../src/components/account/AccountEmailForm");
  const view = () => {
    cursor = 0;
    if (component) return component();
    return AccountEmailForm({
      continueTo: null,
      returnTo: null,
      canRecover: false,
      ...emailProps,
    });
  };
  const button = (label: string) => {
    const found = elements(view()).find(
      (element) =>
        typeof element.type !== "string" &&
        (element.props.children === label || element.props["aria-label"] === label),
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
  const field = (name: string) => {
    const found = elements(view()).find(
      (element) => element.type === "input" && element.props.name === name,
    );
    assert.ok(found, `Missing field: ${name}`);
    return found.props;
  };
  const submit = () =>
    elements(view()).find((element) => element.type === "form")!.props.onSubmit!({
      preventDefault() {},
    });
  return {
    view,
    button,
    input,
    code,
    field,
    submit,
    requests,
    destinations,
    refreshes,
    settle: setImmediate,
  };
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
  assert.equal(
    elements(ui.view()).some((element) => element.type === "input"),
    false,
  );
  ui.button(copy.change).onClick!();
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
  ui.submit();
  await ui.settle();
  ui.code().onChange!({ target: { value: "123456" } });
  assert.equal(ui.button(copy.confirm).disabled, false);
  t.mock.timers.tick(60_000);
  assert.equal(ui.button(copy.resend).disabled, false);
  ui.button(copy.resend).onClick!();
  await ui.settle();
  assert.equal(ui.code().value, "");
  assert.equal(ui.button(copy.confirm).disabled, true);
  assert.equal(ui.button(copy.resend).disabled, true);
  assert.ok(text(ui.view()).includes(`60${copy.seconds}`));
  assert.ok(text(ui.view()).includes(state.email!));
  assert.equal(ui.requests.length, 2);
});

test("首次绑定按邮箱、验证码分两步，返回修改后旧证明不能提交，确认使用服务端落点", async (t) => {
  const ui = await form(
    t,
    { ...state, email: null, verified: false },
    [challenge, challenge, { success: true, data: { destination: "/member/repairs" } }],
    undefined,
    { returnTo: "/member/repairs" },
  );
  ui.input("email").onChange!({ target: { value: "first@example.com" } });
  assert.equal(
    elements(ui.view()).some((element) => element.props.name === "newCode"),
    false,
  );
  ui.submit();
  await ui.settle();
  assert.equal(
    elements(ui.view()).some((element) => element.props.type === "email"),
    false,
  );
  ui.field("newCode").onChange!({ target: { value: "123456" } });
  ui.button(copy.previous).onClick!();
  ui.input("email").onChange!({ target: { value: "second@example.com" } });
  t.mock.timers.tick(60_000);
  ui.submit();
  await ui.settle();
  assert.equal(ui.field("newCode").value, "");
  assert.equal(ui.button(copy.confirm).disabled, true);
  ui.field("newCode").onChange!({ target: { value: "654321" } });
  ui.submit();
  await ui.settle();
  assert.deepEqual(ui.requests, [
    { mode: "BIND", targetEmail: "first@example.com" },
    { mode: "BIND", targetEmail: "second@example.com" },
    {
      mode: "BIND",
      targetEmail: "second@example.com",
      proof: { challengeId: challenge.data.challengeId, code: "654321" },
      returnTo: "/member/repairs",
    },
  ]);
  assert.deepEqual(ui.destinations, ["/member/repairs"]);
});

test("换绑先保留密码与旧邮箱证明，下一步仅显示新邮箱验证码并完整提交", async (t) => {
  const ui = await form(t, state, [
    challenge,
    challenge,
    { success: true, data: { destination: "/admin" } },
  ]);
  ui.button(copy.change).onClick!();
  ui.input("password").onChange!({ target: { value: "current password" } });
  ui.button(copy.sendOld).onClick!();
  await ui.settle();
  ui.field("oldCode").onChange!({ target: { value: "123456" } });
  ui.input("email").onChange!({ target: { value: "next@example.com" } });
  assert.equal(ui.button(copy.sendNew).disabled, true);
  t.mock.timers.tick(60_000);
  ui.submit();
  await ui.settle();
  assert.equal(elements(ui.view()).filter((element) => element.type === "input").length, 1);
  ui.field("newCode").onChange!({ target: { value: "654321" } });
  ui.submit();
  await ui.settle();
  assert.deepEqual(ui.requests.at(-1), {
    mode: "CHANGE",
    targetEmail: "next@example.com",
    currentPassword: "current password",
    old: { challengeId: challenge.data.challengeId, code: "123456" },
    proof: { challengeId: challenge.data.challengeId, code: "654321" },
  });
  assert.deepEqual(ui.destinations, ["/admin"]);
});

test("服务端未授予继续落点时不显示链接，成员看不到恢复入口", async (t) => {
  const blocked = await form(t, state, []);
  assert.equal(
    elements(blocked.view()).some((element) => element.props.children === copy.continueAction),
    false,
  );
  assert.equal(
    elements(blocked.view()).some((element) => element.props.children === copy.adminTitle),
    false,
    "成员不该看到管理员恢复入口",
  );
});

test("服务端授予落点后「继续」成为链接；恢复窗口常驻但一次只挂一个", async (t) => {
  const dialogs = (node: ReactNode) =>
    elements(node).filter((element) => typeof element.props.onClose === "function");
  const granted = await form(t, state, [], undefined, {
    continueTo: "/member/repairs",
    returnTo: "/member/repairs",
    canRecover: true,
  });
  assert.equal(granted.button(copy.continueAction).href, "/member/repairs");
  assert.equal(granted.button(copy.continueAction).disabled, undefined);
  assert.equal(
    elements(granted.view()).some((element) => element.type === "input"),
    false,
  );
  granted.button(adminCopy.members.account.action).onClick!();
  assert.equal(dialogs(granted.view()).length, 1);
  granted.button(copy.adminTitle).onClick!();
  // 一次只挂一个窗口：切到账号邮箱时恢复窗口必须已经撤下。
  assert.equal(dialogs(granted.view()).length, 1);
});

test("「刷新状态」同时刷新服务端授予的继续落点，不是只重取邮箱状态（返修 F3）", async (t) => {
  const props: {
    continueTo: string | null;
    returnTo: string | null;
    canRecover: boolean;
  } = { continueTo: null, returnTo: "/member/repairs", canRecover: false };
  const ui = await form(t, state, [], undefined, props);
  assert.equal(
    elements(ui.view()).some((element) => element.props.children === copy.continueAction),
    false,
  );
  assert.equal(ui.refreshes.length, 0);

  // 期间另一位管理员授予了有效豁免。客户端唯一能做的是让**服务端**重算本页 props ——
  // 既没有新的「门禁状态」接口，也不许前端看见豁免就自行拼落点。
  ui.button(copy.reload).onClick!();
  assert.equal(ui.refreshes.length, 1, "刷新状态必须重放当前 RSC 请求");
  assert.equal(ui.requests.length, 0, "不新增状态端点");

  props.continueTo = "/member/repairs"; // 服务端重算后的结论（同一 returnTo，链条不断）
  const after = ui.button(copy.continueAction);
  assert.equal(after.href, "/member/repairs");
  assert.equal(after.disabled, undefined);
  assert.equal(after.href, props.continueTo);
});

test("匿名找回在途互斥、验码后自设密码、字段错误保留授权并可纠正重提", async (t) => {
  const { ForgotPasswordForm } = await import("../../src/components/account/ForgotPasswordForm");
  let accept!: (response: unknown) => void;
  const pending = new Promise((resolve) => {
    accept = resolve;
  });
  const ui = await form(
    t,
    state,
    [
      pending,
      { success: true, data: { authorized: true, expiresAt: challenge.data.expiresAt } },
      {
        success: false,
        error: { code: "PASSWORD_CONFIRMATION_MISMATCH", message: "两次输入不一致" },
      },
      { success: true, data: { changed: true, destination: "/login" } },
    ],
    ForgotPasswordForm,
  );
  assert.ok(text(ui.view()).includes(recoveryCopy.help));
  assert.equal(text(ui.view()).includes(recoveryCopy.success), false);
  ui.field("qq").onChange!({ target: { value: "123456" } });
  ui.submit();
  ui.submit();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.field("qq").disabled, true);
  assert.equal(ui.button(recoveryCopy.back).disabled, true);
  accept({ success: true, data: { ...challenge.data, message: recoveryCopy.accepted } });
  await ui.settle();
  assert.equal(ui.button(recoveryCopy.resend).disabled, true);
  ui.field("code").onChange!({ target: { value: "123456" } });
  ui.submit();
  await ui.settle();
  ui.field("newPassword").onChange!({ target: { value: " new password " } });
  ui.field("newPasswordConfirmation").onChange!({ target: { value: "mismatch" } });
  ui.submit();
  await ui.settle();
  assert.equal(ui.field("newPassword").value, " new password ");
  assert.equal(ui.button(recoveryCopy.confirm).disabled, false);
  ui.field("newPasswordConfirmation").onChange!({ target: { value: " new password " } });
  ui.submit();
  await ui.settle();
  assert.deepEqual(ui.destinations, ["/login"]);
  assert.deepEqual(ui.requests.at(-1), {
    newPassword: " new password ",
    newPasswordConfirmation: " new password ",
  });
  assert.equal(ui.field("qq").value, "123456");
  const { LoginPanel } = await import("../../src/components/auth/LoginPanel");
  const { LoginForm } = await import("../../src/components/auth/LoginForm");
  const { InviteRegistrationForm } =
    await import("../../src/components/auth/InviteRegistrationForm");
  const login = elements(LoginPanel({}));
  assert.ok(
    login.findIndex((e) => e.props.href === "/account/forgot-password") >
      login.findIndex((e) => e.type === LoginForm),
  );
  assert.equal(
    elements(LoginPanel({ mode: "register" })).some(
      (e) => e.props.href === "/account/forgot-password",
    ),
    false,
  );
  // 登录 ↔ 注册切换与注册表单都带着同一个候选原目标：链条不能在切换处掉链子。
  assert.equal(
    login.find((e) => e.type === LoginForm)!.props.returnTo,
    undefined,
    "没有候选时不凭空造 returnTo",
  );
  assert.ok(
    login.some((e) => e.props.href === "/login?mode=register"),
    "无候选时切换链接保持原样",
  );
  const chained = elements(LoginPanel({ returnTo: "/member/repairs" }));
  assert.ok(
    chained.some((e) => e.props.href === "/login?mode=register&returnTo=%2Fmember%2Frepairs"),
    "登录 → 注册的切换链接带着候选",
  );
  assert.equal(chained.find((e) => e.type === LoginForm)!.props.returnTo, "/member/repairs");
  const register = elements(LoginPanel({ mode: "register", returnTo: "/member/repairs" }));
  assert.ok(
    register.some((e) => e.props.href === "/login?returnTo=%2Fmember%2Frepairs"),
    "注册 → 登录的返回链接同样带着候选",
  );
  assert.equal(
    register.find((e) => e.type === InviteRegistrationForm)!.props.returnTo,
    "/member/repairs",
    "注册表单收到候选（提交时由服务端按白名单 + 当次角色重判）",
  );
});

test("匿名找回重发网络未知清旧证明且等待；改 QQ 不留凭据，公共 429 不猜冷却", async (t) => {
  const { ForgotPasswordForm } = await import("../../src/components/account/ForgotPasswordForm");
  const ui = await form(
    t,
    state,
    [
      { success: true, data: { ...challenge.data, message: recoveryCopy.accepted } },
      new TypeError("network unavailable"),
      { success: false, error: { code: "EMAIL_RATE_LIMITED", message: "稍后重试" } },
    ],
    ForgotPasswordForm,
  );
  ui.field("qq").onChange!({ target: { value: "123456" } });
  ui.submit();
  await ui.settle();
  ui.field("code").onChange!({ target: { value: "123456" } });
  t.mock.timers.tick(60_000);
  ui.button(recoveryCopy.resend).onClick!();
  await ui.settle();
  assert.equal(
    elements(ui.view()).some((e) => e.props.name === "code"),
    false,
  );
  assert.equal(ui.button(recoveryCopy.request).disabled, true);
  assert.ok(text(ui.view()).includes(`60${recoveryCopy.seconds}`));
  ui.field("qq").onChange!({ target: { value: "234567" } });
  t.mock.timers.tick(60_000);
  ui.submit();
  await ui.settle();
  assert.equal(ui.button(recoveryCopy.request).disabled, false);
  assert.equal(
    elements(ui.view()).some((e) => e.props.name === "newPassword"),
    false,
  );
  assert.equal(ui.requests.length, 3);
});
