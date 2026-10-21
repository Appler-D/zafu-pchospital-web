import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../../src/lib/api/errors";
import { permissionsForRoles, requirePermission } from "../../src/lib/auth/permissions";

test("管理员与成员权限边界固定", () => {
  assert.equal(permissionsForRoles(["MEMBER"]).includes("join:read"), false);
  assert.equal(permissionsForRoles(["ADMIN"]).includes("join:review"), true);
  assert.equal(permissionsForRoles(["MEMBER"]).includes("member:manage"), false);
  assert.equal(permissionsForRoles(["ADMIN"]).includes("member:manage"), true);
});

test("评论权限退役；成员和管理员继续收藏与读取通知", () => {
  const member = permissionsForRoles(["MEMBER"]);
  const admin = permissionsForRoles(["ADMIN"]);
  for (const permission of ["favorite:manage", "notification:read"] as const) {
    assert.equal(member.includes(permission), true);
    assert.equal(admin.includes(permission), true);
  }
  assert.equal(
    [...member, ...admin].some((permission) => permission.startsWith("comment:")),
    false,
  );
});

test("未登录、禁用账号与普通成员均不能读取报名", () => {
  assert.throws(
    () => requirePermission(null, "join:read"),
    (error) => hasCode(error, "UNAUTHENTICATED"),
  );
  assert.throws(
    () =>
      requirePermission(
        {
          actorType: "USER",
          userId: "user",
          userStatus: "DISABLED",
          permissions: ["join:read"],
          requestId: "req",
        },
        "join:read",
      ),
    (error) => hasCode(error, "FORBIDDEN"),
  );
  assert.throws(
    () =>
      requirePermission(
        {
          actorType: "USER",
          userId: "user",
          userStatus: "ACTIVE",
          permissions: permissionsForRoles(["MEMBER"]),
          requestId: "req",
        },
        "join:read",
      ),
    (error) => hasCode(error, "FORBIDDEN"),
  );
});

function hasCode(error: unknown, code: string): boolean {
  return error instanceof AppError && error.code === code;
}


test("维修活动权限：管理员可管，成员仅 staff", () => {
  const member = permissionsForRoles(["MEMBER"]);
  const admin = permissionsForRoles(["ADMIN"]);
  assert.equal(member.includes("activity:admin"), false);
  assert.equal(member.includes("activity:staff"), true);
  assert.equal(admin.includes("activity:admin"), true);
  assert.equal(admin.includes("activity:staff"), true);
});
