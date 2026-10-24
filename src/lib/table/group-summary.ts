import { AppError } from "@/lib/api/errors";
import type { TableGroupSummary } from "@/types/table";

export function checkedGroup(value: string | null | undefined, allowed: readonly string[]) {
  if (!value) return undefined;
  if (!allowed.includes(value)) throw new AppError("VALIDATION_FAILED", "分组字段无效");
  return value;
}

export function groupSummary(
  field: string,
  rows: readonly { value: string | null; count: number }[],
): TableGroupSummary {
  return {
    field,
    counts: [...rows].sort(
      (a, b) => b.count - a.count || (a.value ?? "").localeCompare(b.value ?? ""),
    ),
  };
}
