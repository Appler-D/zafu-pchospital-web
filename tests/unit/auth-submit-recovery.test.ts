import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import type { FormEvent, ReactElement } from "react";

import { loginCopy, registerCopy } from "../../src/config/auth";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
(globalThis as unknown as { React: typeof React }).React = React;

type FormKind = "login" | "register";
type FormProps = {
  children: ReactElement<{ type?: string; disabled?: boolean; children?: string }>[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

// 与 SessionMonitor 的测试一样，调用真实组件，只替换 hooks 的存储和外部请求。
async function mount(t: TestContext, kind: FormKind) {
  const state: unknown[] = [];
  let cursor = 0;
  t.mock.method(React, "useState", <S>(initial: S) => {
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [
      state[index] as S,
      (value: S) => {
        state[index] = value;
      },
    ] as [S, (value: S) => void];
  });
  const registrationKey = { current: "registration-retry-key" };
  t.mock.method(React, "useRef", <S>() => registrationKey as unknown as { current: S });
  const destinations: string[] = [];
  let refreshes = 0;
  t.mock.method(React, "useContext", () => ({
    replace: (destination: string) => destinations.push(destination),
    refresh: () => {
      refreshes++;
    },
  }));

  const fields: Record<string, string> = {
    qq: "12345678",
    password: "test-password-123",
    ...(kind === "login" ? { rememberMe: "on" } : {}),
    ...(kind === "register"
      ? {
          code: "test-invite-code",
          realName: "测试成员",
          phone: "13800000000",
          studentId: "20260001",
          className: "测试班级",
          passwordConfirmation: "test-password-123",
        }
      : {}),
  };
  const NativeFormData = globalThis.FormData;
  t.mock.method(
    globalThis,
    "FormData",
    class extends NativeFormData {
      constructor() {
        super();
        for (const [key, value] of Object.entries(fields)) this.append(key, value);
      }
    },
  );
  let resets = 0;
  const form = {
    reset: () => {
      resets++;
    },
  } as unknown as HTMLFormElement;
  const Component =
    kind === "login"
      ? (await import("../../src/components/auth/LoginForm")).LoginForm
      : (await import("../../src/components/auth/InviteRegistrationForm")).InviteRegistrationForm;
  function render() {
    cursor = 0;
    return Component({ returnTo: "/member/repairs" }) as ReactElement<FormProps>;
  }
  function button() {
    const child = render().props.children.find((item) => item?.props?.type === "submit");
    assert.ok(child, "表单应保留提交按钮");
    return child.props;
  }
  return {
    fields,
    destinations,
    button,
    problem: () => state[0],
    refreshes: () => refreshes,
    resets: () => resets,
    submit: () =>
      render().props.onSubmit({
        preventDefault() {},
        currentTarget: form,
      } as FormEvent<HTMLFormElement>),
  };
}

for (const kind of ["login", "register"] as const) {
  const copy = kind === "login" ? loginCopy : registerCopy;

  for (const failure of ["network", "aborted", "non-json", "empty", "null"] as const) {
    test(`${kind}: ${failure} 后恢复按钮、保留输入，并可直接重试成功`, async (t) => {
      const ui = await mount(t, kind);
      const originalFields = { ...ui.fields };
      const requests: { url: string; body: Record<string, unknown> }[] = [];
      let finish!: (response: Response) => void;
      let fail!: (error: Error) => void;
      t.mock.method(globalThis, "fetch", (url: unknown, options: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(options.body)) });
        return new Promise<Response>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      });

      const pending = ui.submit();
      assert.equal(ui.button().disabled, true);
      assert.equal(ui.button().children, copy.submitting);
      if (failure === "network") fail(new TypeError("fetch failed"));
      else if (failure === "aborted") fail(new DOMException("aborted", "AbortError"));
      else if (failure === "non-json")
        finish(new Response("<html>gateway error</html>", { status: 502 }));
      else if (failure === "empty") finish(new Response("", { status: 200 }));
      else finish(Response.json(null));
      await pending;

      assert.equal(ui.button().disabled, false);
      assert.equal(ui.button().children, copy.submit);
      assert.equal(
        ui.problem(),
        failure === "network" || failure === "aborted"
          ? "网络异常，请检查连接后重试"
          : `服务返回了无法解析的响应（HTTP ${failure === "non-json" ? 502 : 200}）`,
      );
      assert.deepEqual(ui.destinations, []);
      assert.equal(ui.refreshes(), 0);
      assert.equal(ui.resets(), 0);
      assert.deepEqual(ui.fields, originalFields);

      const retry = ui.submit();
      assert.equal(ui.problem(), "", "重试时清除旧错误提示");
      assert.equal(ui.button().disabled, true);
      finish(
        Response.json({
          success: true,
          data: { destination: "/account/email?returnTo=%2Fmember%2Frepairs" },
        }),
      );
      await retry;
      assert.equal(ui.button().disabled, false);
      assert.deepEqual(ui.destinations, ["/account/email?returnTo=%2Fmember%2Frepairs"]);
      assert.equal(ui.refreshes(), 1);
      assert.equal(requests.length, 2);
      assert.equal(
        requests[0].url,
        kind === "login" ? "/api/v1/auth/login" : "/api/v1/member-registrations/invite",
      );
      assert.deepEqual(requests[0].body, requests[1].body, "重试沿用输入、returnTo 和注册幂等键");
      assert.equal(requests[1].body.returnTo, "/member/repairs");
      if (kind === "register")
        assert.equal(requests[1].body.idempotencyKey, "registration-retry-key");
      else assert.equal(requests[1].body.rememberMe, true);
    });
  }

  for (const reply of [
    {
      status: 400,
      payload: { success: false, error: { message: "请检查输入内容" } },
      message: "请检查输入内容",
    },
    { status: 200, payload: { success: false }, message: copy.failed },
    { status: 200, payload: { success: true, data: {} }, message: copy.failed },
  ]) {
    test(`${kind}: HTTP ${reply.status} / ${JSON.stringify(reply.payload)} 时可纠正并重试`, async (t) => {
      const ui = await mount(t, kind);
      t.mock.method(globalThis, "fetch", async () =>
        Response.json(reply.payload, { status: reply.status }),
      );
      await ui.submit();
      assert.equal(ui.button().disabled, false);
      assert.equal(ui.problem(), reply.message);
      assert.deepEqual(ui.destinations, []);
      assert.equal(ui.resets(), 0);
    });
  }
}

test("register: 两次密码不一致时不发请求，纠正后可提交", async (t) => {
  const ui = await mount(t, "register");
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: { destination: "/member" },
    }),
  );
  ui.fields.passwordConfirmation = "different-password";
  await ui.submit();
  assert.equal(ui.button().disabled, false);
  assert.equal(ui.problem(), registerCopy.passwordMismatch);
  assert.equal(fetchMock.mock.callCount(), 0);
  ui.fields.passwordConfirmation = ui.fields.password;
  await ui.submit();
  assert.equal(ui.problem(), "");
  assert.equal(ui.button().disabled, false);
  assert.deepEqual(ui.destinations, ["/member"]);
});
