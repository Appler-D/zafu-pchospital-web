import { AppError } from "@/lib/api/errors";
import { requirePermission } from "@/lib/auth/permissions";
import type { AuthorizedActor } from "@/types/contracts";

type ReadableRepair = {
  memberProfile: { userId: string };
  status: string;
  deletedAt: Date | null;
};

/** 详情与通知共用同一可见性判据，通知不扩大记录读取权限。 */
export function canReadRepair(actor: AuthorizedActor, record: ReadableRepair): boolean {
  return (
    actor.permissions.includes("repair:read") &&
    !record.deletedAt &&
    (record.memberProfile.userId === actor.userId ||
      actor.permissions.includes("repair:review") ||
      record.status === "APPROVED")
  );
}

export function assertCanReadRepair(actor: AuthorizedActor, record: ReadableRepair): void {
  requirePermission(actor, "repair:read");
  if (!canReadRepair(actor, record)) throw new AppError("REPAIR_NOT_FOUND", "维修记录不存在");
}

export function assertCanEditRepair(
  actor: AuthorizedActor,
  record: { memberProfile: { userId: string }; status: string; deletedAt: Date | null },
): void {
  requirePermission(actor, "repair:update");
  if (record.deletedAt) throw new AppError("REPAIR_NOT_FOUND", "维修记录不存在");
  if (record.memberProfile.userId !== actor.userId)
    throw new AppError("REPAIR_FORBIDDEN", "只能编辑自己的维修记录");
  if (record.status !== "DRAFT" && record.status !== "REJECTED")
    throw new AppError("REPAIR_STATE_INVALID", "当前状态不能编辑");
}

/**
 * 撤回审核（issue #165）：只有创建人、且记录仍在待审核时可以撤回。
 *
 * `allowNonPending` 只给幂等重放用：同一个 Idempotency-Key 已经撤回过时，
 * 即使记录后来又被提交 / 通过，也直接返回当前状态，而不是再撤一次或报错。
 */
export function assertCanWithdrawRepair(
  actor: AuthorizedActor,
  record: { memberProfile: { userId: string }; status: string; deletedAt: Date | null },
  options: { allowNonPending?: boolean } = {},
): void {
  requirePermission(actor, "repair:submit");
  if (record.deletedAt) throw new AppError("REPAIR_NOT_FOUND", "维修记录不存在");
  if (record.memberProfile.userId !== actor.userId)
    throw new AppError("REPAIR_FORBIDDEN", "只能撤回自己的维修记录");
  if (!options.allowNonPending && record.status !== "PENDING")
    throw new AppError("REPAIR_STATE_INVALID", "只有待审核的维修记录可以撤回");
}
