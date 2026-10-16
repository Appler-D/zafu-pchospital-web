import assert from "node:assert/strict";
import test from "node:test";
import { loginDestination } from "../../src/lib/auth/login-destination";
import { safeAccountReturnPath } from "../../src/lib/auth/account-access";
import { parseEmailChallenge, parseEmailConfirm } from "../../src/lib/api/account-email-routes";

test("自助输入严格拒绝 userId、找回用途和协助目标覆盖，不把对象强转文本", () => {
  for (const input of [
    { mode: "PASSWORD_RESET" },
    { mode: "BIND", targetEmail: "a@example.com", userId: "another" },
    { mode: "BIND", targetEmail: {} },
    {
      mode: "ASSISTED",
      assistanceId: "a",
      currentPassword: "p",
      targetEmail: "override@example.com",
    },
  ])
    assert.throws(() => parseEmailChallenge(input));
  const proof = { challengeId: "e1464444-0000-4000-8003-000000000001", code: "123456" };
  assert.deepEqual(
    parseEmailConfirm({ mode: "ASSISTED", assistanceId: "a", currentPassword: "p", proof }),
    { mode: "ASSISTED", assistanceId: "a", currentPassword: "p", proof, returnTo: undefined },
  );
  assert.throws(() =>
    parseEmailConfirm({
      mode: "BIND",
      targetEmail: "a@example.com",
      proof: { ...proof, code: 123456 },
    }),
  );
});
test("回跳由服务端业务路径白名单及当前角色限定（门禁与邮箱共用同一规则）", () => {
  for (const path of [
    "https://evil.invalid",
    "//evil.invalid",
    "/member\\evil",
    "/member/%2fadmin",
    "/api/v1/me",
    "/login",
    "/account/email",
    "/account/change-password",
    "/member/../admin",
    "/member?next=evil",
    "/member\n",
  ])
    assert.equal(safeAccountReturnPath(path, ["MEMBER"]), null);
  assert.equal(safeAccountReturnPath("/admin/members", ["MEMBER"]), null);
  assert.equal(safeAccountReturnPath("/admin/members", ["ADMIN"]), "/admin/members");
  assert.equal(safeAccountReturnPath("/member/repairs", ["MEMBER"]), "/member/repairs");
  // 非法 / 无权目标由编排层回角色默认页，不是把原始值透传出去。
  assert.equal(loginDestination({ roles: ["MEMBER"], mustChangePassword: false }), "/member");
});
