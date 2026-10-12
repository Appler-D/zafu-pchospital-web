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
