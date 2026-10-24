import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../../src/lib/api/errors";
import { permissionsForRoles } from "../../src/lib/auth/permissions";
import {
  assertCanAttachRepairPhotos,
  canAttachRepairPhotos,
} from "../../src/features/repairs/repair-policy";
import type { AuthorizedActor, RoleCode } from "../../src/types/contracts";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";

function actor(userId = OWNER_ID, roles: RoleCode[] = ["MEMBER"]): AuthorizedActor {
  return {
    actorType: "USER",
    userId,
    userStatus: "ACTIVE",
    permissions: permissionsForRoles(roles),
    requestId: "req_photo_policy",
  };
}

function record(
  overrides: {
    status?: string;
    reviewedAt?: Date | null;
    deletedAt?: Date | null;
    userId?: string;
  } = {},
) {
  return {
    memberProfile: { userId: overrides.userId ?? OWNER_ID },
    status: overrides.status ?? "PENDING",
    reviewedAt: overrides.reviewedAt === undefined ? null : overrides.reviewedAt,
    deletedAt: overrides.deletedAt === undefined ? null : overrides.deletedAt,
  };
}

function rejectsWith(code: string) {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

test("照片附件：本人未审核的 PENDING 允许补传", () => {
  assert.equal(canAttachRepairPhotos(actor(), record()), true);
  assert.doesNotThrow(() => assertCanAttachRepairPhotos(actor(), record()));
});

test("照片附件：DRAFT / REJECTED 保持可传", () => {
  assert.equal(canAttachRepairPhotos(actor(), record({ status: "DRAFT" })), true);
  assert.equal(canAttachRepairPhotos(actor(), record({ status: "REJECTED" })), true);
});

test("照片附件：审核完成后关闭（APPROVED / reviewedAt 已写）", () => {
  assert.equal(
    canAttachRepairPhotos(
      actor(),
      record({ status: "PENDING", reviewedAt: new Date("2026-10-24T00:00:00Z") }),
    ),
    false,
  );
  assert.throws(
    () =>
      assertCanAttachRepairPhotos(
        actor(),
        record({ status: "PENDING", reviewedAt: new Date("2026-10-24T00:00:00Z") }),
      ),
    rejectsWith("REPAIR_STATE_INVALID"),
  );
  assert.throws(
    () => assertCanAttachRepairPhotos(actor(), record({ status: "APPROVED" })),
    rejectsWith("REPAIR_STATE_INVALID"),
  );
});

test("照片附件：只能本人补传，管理员不代传", () => {
  assert.equal(canAttachRepairPhotos(actor("other-user"), record()), false);
  assert.throws(
    () => assertCanAttachRepairPhotos(actor("other-user"), record()),
    rejectsWith("REPAIR_FORBIDDEN"),
  );
  assert.throws(
    () => assertCanAttachRepairPhotos(actor("admin-user", ["ADMIN"]), record()),
    rejectsWith("REPAIR_FORBIDDEN"),
  );
});

test("照片附件：软删除记录视为不存在，缺 repair:update 权限直接拒绝", () => {
  assert.throws(
    () =>
      assertCanAttachRepairPhotos(actor(), record({ deletedAt: new Date("2026-10-24T00:00:00Z") })),
    rejectsWith("REPAIR_NOT_FOUND"),
  );
  assert.throws(
    () => assertCanAttachRepairPhotos(actor(OWNER_ID, []), record()),
    rejectsWith("FORBIDDEN"),
  );
});
