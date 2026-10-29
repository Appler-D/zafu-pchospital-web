import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { GET } from "../../src/app/api/v1/me/route";
import { authService } from "../../src/features/auth/auth-service";
import { resetServerEnvForTests } from "../../src/lib/env";
import type { AccountMeView } from "../../src/types/contracts";

test("轮换后迟到的 /me 保留会话视图，但不能通过 Set-Cookie 覆盖新令牌", async (t) => {
  const environment = {
    DATABASE_URL: "mysql://unused",
    AUTH_SECRET: "unit-test-auth-secret-at-least-32-bytes",
    INVITE_CODE_PEPPER: "unit-test-invite-pepper-at-least-32-bytes",
    PII_AUDIT_PEPPER: "unit-test-audit-pepper-at-least-32-bytes",
    EMAIL_GATE_MODE: "off",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  resetServerEnvForTests();
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServerEnvForTests();
  });
  let finish!: (value: Awaited<ReturnType<typeof authService.authenticate>>) => void;
  t.mock.method(authService, "authenticate", (token: string) => {
    assert.equal(token, "old-token");
    return new Promise<Awaited<ReturnType<typeof authService.authenticate>>>((resolve) => {
      finish = resolve;
    });
  });
  const pending = GET(
    new Request("http://localhost/api/v1/me?returnTo=%2Fadmin%2Fmembers", {
      headers: { cookie: "pc_hospital_session=old-token" },
    }),
  );
  await setImmediate();
  // 模拟浏览器已收到改密响应设置的新 Cookie，此时旧检查才完成。
  let browserCookie = "new-token";
  const principal = {
    userId: "admin-a",
    sessionId: "old-session",
    displayName: "管理员",
    roles: ["ADMIN"] as const,
    permissions: [],
    memberProfileId: null,
    memberStatus: null,
    mustChangePassword: false,
    rememberMe: true,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  finish({ ...principal, roles: [...principal.roles] });
  const response = await pending;
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) browserCookie = setCookie.split(";")[0].split("=")[1];
  assert.equal(response.status, 200);
  assert.equal(setCookie, null);
  assert.equal(browserCookie, "new-token");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const json = (await response.json()) as { success: boolean; data: AccountMeView };
  assert.equal(json.success, true);
  assert.equal(json.data.sessionId, "old-session");
  assert.equal(json.data.rememberMe, true);
  assert.equal(json.data.expiresAt, principal.expiresAt);
  assert.equal(json.data.accountAccess.destination, "/admin/members");
});
