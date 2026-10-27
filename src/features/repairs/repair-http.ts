import { parseFilters } from "@/lib/api/list-filter";
import { checkedGroup } from "@/lib/table/group-summary";
import { REPAIR_FILTERABLE, TABLE_GROUPS } from "@/features/admin/table-fields";
import { REPAIR_SORTABLE } from "@/features/repairs/repair-sort";
import { AppError } from "@/lib/api/errors";
import { sortRules } from "@/lib/api/list-query";
import { RepairStatus, type RepairListInput, type RepairResult } from "@/types/contracts";

/**
 * 维修列表 URL `status` 查询参数（客户端 / 深链共用）。
 *
 * 白名单与 `RepairStatus` 一致；非法或空值返回空串（表示「全部」），
 * 不抛错 —— 工作台队列深链与列表页预选共用这一口径。
 */
export function parseRepairListStatus(value: string | null | undefined): "" | RepairStatus {
  if (!value) return "";
  return (RepairStatus as readonly string[]).includes(value) ? (value as RepairStatus) : "";
}

export function repairListInput(
  params: URLSearchParams,
  page: number,
  pageSize: number,
): RepairListInput {
  // 案例库准入：URL 值 "any" 过白名单后映射为契约值 "ANY"。
  // 空值 = 不过滤（保持既有调用方兼容）；非法值由 oneOf 抛 400，与 status / result 同模式。
  const flagged = oneOf(value(params, "flagged"), ["any"], "flagged");
  return {
    page,
    pageSize,
    filters: parseFilters(params.getAll("filter"), REPAIR_FILTERABLE),
    groupBy: checkedGroup(params.get("groupBy"), TABLE_GROUPS.repairs),
    memberId: value(params, "memberId"),
    categoryId: value(params, "categoryId"),
    status: oneOf(
      value(params, "status"),
      ["DRAFT", "PENDING", "APPROVED", "REJECTED"],
      "status",
    ) as RepairStatus | undefined,
    result: oneOf(value(params, "result"), ["COMPLETED", "NOT_COMPLETED"], "result") as
      RepairResult | undefined,
    repairDateFrom: value(params, "repairDateFrom"),
    repairDateTo: value(params, "repairDateTo"),
    isDifficult: bool(value(params, "isDifficult"), "isDifficult"),
    isTypical: bool(value(params, "isTypical"), "isTypical"),
    flagged: flagged === "any" ? "ANY" : undefined,
    query: value(params, "query"),
    // 与成员表同一形状：白名单 + 方向 + 去重 + 条数上限都在 `sortRules` 里，
    // 非法值一律 `VALIDATION_FAILED`，字段名不透传成列名。
    sort: sortRules(params.get("sort"), REPAIR_SORTABLE),
  };
}
export function draftInput(body: Record<string, unknown>) {
  return {
    repairDate: nullableString(body.repairDate),
    durationMinutes: nullableNumber(body.durationMinutes),
    categoryId: nullableString(body.categoryId),
    ownerName: nullableString(body.ownerName),
    ownerPhone: nullableString(body.ownerPhone),
    deviceModel: nullableString(body.deviceModel),
    content: nullableString(body.content),
    result: nullableResult(body.result),
    remark: nullableString(body.remark),
    // 参与维修人员：缺省表示「不动」；清理与去重在 `normalizeDraftFields`。
    participantIds: nullableStringArray(body.participantIds),
  };
}
export function idempotencyKey(request: Request): string {
  return request.headers.get("idempotency-key") ?? "";
}
/**
 * 请求体里的必填布尔字段。
 *
 * `RepairFlagsInput` 是**整体替换**语义（两个标记一起提交），所以缺字段不能静默当 false ——
 * 那会让「只想改一个标记」的调用把另一个标记悄悄清掉。缺字段或类型不对一律 400。
 */
export function requiredBool(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (typeof value !== "boolean") throw new AppError("VALIDATION_FAILED", `${name} 必须是布尔值`);
  return value;
}
/** 请求体里的必填字符串字段。空串视为缺失。 */
export function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim())
    throw new AppError("VALIDATION_FAILED", `${name} 不能为空`);
  return value;
}
/** 请求体里的字符串数组字段（批量操作入参）。 */
export function stringArray(body: Record<string, unknown>, name: string): string[] {
  const value = body[name];
  if (!Array.isArray(value)) throw new AppError("VALIDATION_FAILED", `${name} 必须是数组`);
  const items = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (items.some((item) => !item)) throw new AppError("VALIDATION_FAILED", `${name} 含非法元素`);
  return [...new Set(items)];
}
function value(params: URLSearchParams, key: string) {
  return params.get(key) || undefined;
}
function oneOf(value: string | undefined, values: readonly string[], name: string) {
  if (!value) return undefined;
  if (!values.includes(value)) throw new AppError("VALIDATION_FAILED", `${name} 参数无效`);
  return value;
}
function bool(value: string | undefined, name: string) {
  if (!value) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AppError("VALIDATION_FAILED", `${name} 参数无效`);
}
function nullableString(value: unknown): string | null | undefined {
  return value === undefined ? undefined : value === null ? null : String(value);
}
/** 可选字符串数组：缺省 = 「不动」；元素类型不对时不做静默拼接，直接拒绝。 */
function nullableStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new AppError("VALIDATION_FAILED", "participantIds 必须是数组");
  if (value.some((item) => typeof item !== "string"))
    throw new AppError("VALIDATION_FAILED", "participantIds 含非字符串元素");
  return value as string[];
}
function nullableNumber(value: unknown): number | null | undefined {
  return value === undefined ? undefined : value === null || value === "" ? null : Number(value);
}
function nullableResult(value: unknown): RepairResult | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (value === "COMPLETED" || value === "NOT_COMPLETED") return value;
  throw new AppError("VALIDATION_FAILED", "维修结果无效");
}
