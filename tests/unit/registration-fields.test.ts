import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { joinSignupFields } from "../../src/config/join";
import { AppError } from "../../src/lib/api/errors";
import { normalizeMemberSignup } from "../../src/lib/member-signup";
import {
  CLASS_NAME_LENGTH_MESSAGE,
  CLASS_NAME_MAX_LENGTH,
  normalizeClassName,
  normalizeStudentId,
  PERSON_NAME_MAX_LENGTH,
  PERSON_NAME_MIN_LENGTH,
  STUDENT_ID_LENGTH_MESSAGE,
  STUDENT_ID_MAX_LENGTH,
} from "../../src/lib/security/normalization";

/**
 * 学号 / 班级约束的单元级钉子。
 *
 * 这里钉住四件事，都是「两处入口共用同一约束来源」的具体含义：
 * 1. 服务端规范化函数：trim、保留前导零、不强制转换非字符串、边界长度；
 * 2. `/join` 表单字段定义直接取自同一组常量（不是各写一份数字）；
 * 3. 客户端 `normalizeMemberSignup` 对学号只 trim，不剔字符、不转数字；
 * 4. 两个表单的姓名原生约束一致（文件末的 DOM 断言，）。
 *
 * 组件渲染需要全局 `React`（tsconfig 的 jsx 是 `preserve`，tsx 跑测试走经典运行时，
 * 组件源码里没有 `import React`）；模式与 `tests/unit/admin-table-render.test.ts` 相同。
 */
(globalThis as unknown as { React: typeof React }).React = React;

function isValidationError(error: unknown, field: "studentId" | "className", message: string) {
  return (
    error instanceof AppError &&
    error.code === "VALIDATION_FAILED" &&
    error.fieldErrors?.[field]?.[0] === message
  );
}

test("normalizeStudentId：trim 后 1–32 字符，保留前导零，非字符串直接拒绝", () => {
  assert.equal(normalizeStudentId("  001234  "), "001234");
  assert.equal(normalizeStudentId("1"), "1");
  assert.equal(normalizeStudentId("1".repeat(STUDENT_ID_MAX_LENGTH)), "1".repeat(32));
  // 不要求纯数字、不要求固定长度：带字母 / 连字符的学号照收。
  assert.equal(normalizeStudentId("ZAFU-2023-01"), "ZAFU-2023-01");

  for (const bad of [
    undefined,
    null,
    123456,
    { studentId: "001234" },
    ["001234"],
    "",
    "   ",
    "1".repeat(STUDENT_ID_MAX_LENGTH + 1),
  ]) {
    assert.throws(
      () => normalizeStudentId(bad),
      (error) => isValidationError(error, "studentId", STUDENT_ID_LENGTH_MESSAGE),
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

test("normalizeClassName：trim 后 1–80 字符，非字符串直接拒绝", () => {
  assert.equal(normalizeClassName("  计算机 233  "), "计算机 233");
  assert.equal(normalizeClassName("A"), "A");
  assert.equal(normalizeClassName("班".repeat(CLASS_NAME_MAX_LENGTH)), "班".repeat(80));

  for (const bad of [
    undefined,
    null,
    233,
    { name: "计算机 233" },
    "",
    "   ",
    "班".repeat(CLASS_NAME_MAX_LENGTH + 1),
  ]) {
    assert.throws(
      () => normalizeClassName(bad),
      (error) => isValidationError(error, "className", CLASS_NAME_LENGTH_MESSAGE),
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

test("/join 表单两字段直接使用共用约束常量，自由文本不设 pattern", () => {
  const student = joinSignupFields.find((field) => field.name === "studentId");
  const className = joinSignupFields.find((field) => field.name === "className");
  assert.ok(student, "缺少学号字段定义");
  assert.ok(className, "缺少班级字段定义");
  assert.equal(student.maxLength, STUDENT_ID_MAX_LENGTH);
  assert.equal(className.maxLength, CLASS_NAME_MAX_LENGTH);
  // 粘贴带空格的学号是常见输入：不设整串 pattern，交给 trim（服务端同样 trim）。
  assert.equal(student.pattern, undefined);
  assert.equal(className.pattern, undefined);
  assert.equal(student.hint.length > 0, true);
  assert.equal(className.hint.length > 0, true);
});

test("normalizeMemberSignup：学号只 trim 保留前导零，姓名 / 班级保留内部空格", () => {
  const data = new FormData();
  data.set("qq", " 800 147 0001 ");
  data.set("realName", " 张 三 ");
  data.set("phone", "139 0147 0001");
  data.set("email", "  Applicant+join@Example.COM ");
  data.set("studentId", "  001234 ");
  data.set("className", " 计算机 233 ");
  const result = normalizeMemberSignup(data);
  assert.equal(result.email, "applicant+join@example.com");
  assert.equal(result.studentId, "001234");
  assert.equal(result.className, "计算机 233");
  assert.equal(result.qq, "8001470001");
  assert.equal(result.phone, "13901470001");
  // 姓名只去首尾空白，不再删掉内部空白（此前是 `replace(/\s+/g, "")`）。
  assert.equal(result.realName, "张 三");
});

/** 从 SSR 输出里取指定 id 的 `<input>` 标签，供属性断言。 */
function inputTagOf(html: string, id: string): string {
  const match = new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`).exec(html);
  assert.ok(match, `HTML 里找不到 #${id} 的 <input>`);
  return match[0];
}

test("两表单的姓名原生约束一致：required + minLength=2 + maxLength=64（/join 无整串 pattern）", async () => {
  const [{ MemberSignup }, { InviteRegistrationForm }, { AppRouterContext }] = await Promise.all([
    import("../../src/components/join/MemberSignup"),
    import("../../src/components/auth/InviteRegistrationForm"),
    import("next/dist/shared/lib/app-router-context.shared-runtime"),
  ]);

  const joinHtml = renderToStaticMarkup(createElement(MemberSignup));
  const joinInput = inputTagOf(joinHtml, "signup-realName");
  assert.ok(/\brequired\b/.test(joinInput), "/join 姓名缺少 required");
  // React 19 的 SSR 输出里 minLength / maxLength 保持 camelCase，浏览器解析时大小写不敏感；
  // 这里按大小写不敏感断言，避免把 React 的输出大小写当成契约。
  const minPattern = new RegExp(`minlength="${PERSON_NAME_MIN_LENGTH}"`, "i");
  const maxPattern = new RegExp(`maxlength="${PERSON_NAME_MAX_LENGTH}"`, "i");
  assert.ok(minPattern.test(joinInput), "/join 姓名 minLength");
  assert.ok(maxPattern.test(joinInput), "/join 姓名 maxLength");
  assert.ok(!/pattern=/i.test(joinInput), "/join 姓名不应再有整串 pattern（会拒掉内部空格）");

  // 注册表单的 useRouter 需要 App Router 上下文（渲染期不调用任何 router 方法）。
  const fakeRouter = {
    replace() {},
    refresh() {},
  } as unknown as React.ContextType<typeof AppRouterContext>;
  const registerHtml = renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: fakeRouter },
      createElement(InviteRegistrationForm),
    ),
  );
  const registerInput = inputTagOf(registerHtml, "register-realName");
  assert.ok(/\brequired\b/.test(registerInput), "注册表单姓名缺少 required");
  assert.ok(minPattern.test(registerInput), "注册表单姓名 minLength");
  assert.ok(maxPattern.test(registerInput), "注册表单姓名 maxLength 应为 64（不再落到默认 80）");
});

test("I158 报名邮箱字段、规范化提交与服务端字段错误就地呈现", async (t) => {
  const { MemberSignup } = await import("../../src/components/join/MemberSignup");
  const { EMAIL_MAX_LENGTH } = await import("../../src/lib/security/normalization");
  const initialHtml = renderToStaticMarkup(createElement(MemberSignup));
  const tag = inputTagOf(initialHtml, "signup-email");
  assert.match(tag, /type="email"/);
  assert.match(tag, /required/);
  assert.match(tag, new RegExp(`maxlength="${EMAIL_MAX_LENGTH}"`, "i"));

  // 沿用项目已有 Node 原生 mock hooks / JSX 事件方式，无浏览器 / 新测试框架。
  const hooks = createRequire(import.meta.url)("react") as typeof React;
  const slots: unknown[] = [];
  let cursor = 0;
  t.mock.method(hooks, "useState", <S>(initial: S) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = initial;
    return [
      slots[i],
      (value: S) => {
        slots[i] = value;
      },
    ];
  });
  t.mock.method(hooks, "useRef", () => ({ current: null }));
  t.mock.method(hooks, "useEffect", () => {});
  type Props = {
    children?: React.ReactNode;
    id?: string;
    name?: string;
    "aria-invalid"?: boolean;
    "aria-describedby"?: string;
    onSubmit?: (e: { preventDefault(): void; currentTarget: HTMLFormElement }) => Promise<void>;
  };
  function nodes(node: React.ReactNode): React.ReactElement<Props>[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!React.isValidElement<Props>(node)) return [];
    return [node, ...nodes(node.props.children)];
  }
  const view = () => {
    cursor = 0;
    return nodes(MemberSignup());
  };
  const data = new FormData();
  for (const [name, value] of Object.entries({
    qq: "123456789",
    realName: "报名测试",
    phone: "13800000000",
    email: "  Applicant+tag@Example.COM  ",
    studentId: "001234",
    className: "计算机 233",
  }))
    data.set(name, value);
  t.mock.method(globalThis, "FormData", function () {
    return data;
  });
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json(
      {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "报名信息未通过校验",
          fieldErrors: { email: ["请填写有效邮箱"] },
        },
      },
      { status: 400 },
    );
  });
  const form = view().find((e) => e.type === "form")!;
  await form.props.onSubmit!({ preventDefault() {}, currentTarget: {} as HTMLFormElement });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].email, "applicant+tag@example.com");
  assert.equal(requests[0].privacyConsent, true);
  const email = view().find((e) => e.props.id === "signup-email")!;
  assert.equal(email.props["aria-invalid"], true);
  assert.match(email.props["aria-describedby"]!, /signup-email-error/);
  assert.deepEqual(
    view().find((e) => e.props.id === "signup-email-error")!.props.children,
    "请填写有效邮箱",
  );
});
