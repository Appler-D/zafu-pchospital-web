import assert from "node:assert/strict";
import test from "node:test";
import { emailReturnDestination } from "../../src/features/email/account-email-service";
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
test("邮箱成功回跳由服务端业务路径白名单及当前角色限定", () => {
  for (const path of [
    "https://evil.invalid",
    "//evil.invalid",
    "/member\\evil",
    "/member/%2fadmin",
    "/api/v1/me",
    "/login",
    "/account/email",
    "/member/../admin",
    "/member?next=evil",
    "/member\n",
  ])
    assert.equal(emailReturnDestination(path, ["MEMBER"]), "/member");
  assert.equal(emailReturnDestination("/admin/members", ["MEMBER"]), "/member");
  assert.equal(emailReturnDestination("/admin/members", ["ADMIN"]), "/admin/members");
  assert.equal(emailReturnDestination("/member/repairs", ["MEMBER"]), "/member/repairs");
});
