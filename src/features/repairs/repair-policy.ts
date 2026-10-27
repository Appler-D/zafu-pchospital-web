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

type AttachableRepair = {
  memberProfile: { userId: string };
  status: string;
  reviewedAt: Date | null;
  deletedAt: Date | null;
};

/**
 * 照片附件权限：比字段编辑多一个「提交后、审核前」窗口。
 *
 * 接待补单 / 新建均在提交时创建 `PENDING`，提交前没有记录可挂照片；允许记录本人在
 * **未审核的 PENDING** 阶段补附件，审核通过后关闭，退回后仍按可编辑状态开放。
 * 仅限记录本人，管理员不代传；是否真正落到某条照片还要由服务在事务内复核。
 */
export function canAttachRepairPhotos(actor: AuthorizedActor, record: AttachableRepair): boolean {
  return (
    actor.permissions.includes("repair:update") &&
    !record.deletedAt &&
    record.memberProfile.userId === actor.userId &&
    (record.status === "DRAFT" ||
      record.status === "REJECTED" ||
      (record.status === "PENDING" && record.reviewedAt === null))
  );
}

export function assertCanAttachRepairPhotos(
  actor: AuthorizedActor,
  record: AttachableRepair,
): void {
  requirePermission(actor, "repair:update");
  if (record.deletedAt) throw new AppError("REPAIR_NOT_FOUND", "维修记录不存在");
  if (record.memberProfile.userId !== actor.userId)
    throw new AppError("REPAIR_FORBIDDEN", "只能补充自己的维修记录");
  if (!canAttachRepairPhotos(actor, record))
    throw new AppError("REPAIR_STATE_INVALID", "审核完成后不能再修改照片");
}
