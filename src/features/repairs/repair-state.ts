import { AppError } from "@/lib/api/errors";
import type { RepairStatus } from "@/types/contracts";
const allowed = new Set([
  "DRAFT:PENDING",
  "REJECTED:PENDING",
  "PENDING:APPROVED",
  "PENDING:REJECTED",
  // 撤回审核（issue #165）：仅创建人，回到草稿后重新编辑并提交。
  "PENDING:DRAFT",
]);
export function isRepairTransitionAllowed(from: RepairStatus, to: RepairStatus): boolean {
  return allowed.has(`${from}:${to}`);
}
export function assertRepairTransition(from: RepairStatus, to: RepairStatus): void {
  if (!isRepairTransitionAllowed(from, to))
    throw new AppError("REPAIR_STATE_INVALID", `不允许从 ${from} 变更为 ${to}`);
}
