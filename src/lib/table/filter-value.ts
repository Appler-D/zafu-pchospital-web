import { parseUtcDateFilter } from "@/lib/api/date-filter";
import { AppError } from "@/lib/api/errors";
import {
  filterParamValues,
  parseFilters,
  type FilterRule,
  type FilterableFields,
} from "@/lib/api/list-filter";

export function checkedFilters(
  rules: readonly FilterRule[] | undefined,
  allowed: FilterableFields,
) {
  return parseFilters(filterParamValues(rules ?? []), allowed);
}

export function textFilter(rule: FilterRule) {
  if (rule.value.length > 80) throw new AppError("VALIDATION_FAILED", "筛选文本不能超过 80 字");
  return rule.op === "contains"
    ? { contains: rule.value }
    : rule.op === "neq"
      ? { not: rule.value }
      : { equals: rule.value };
}

export function enumFilter(rule: FilterRule, values: readonly string[]) {
  if (!values.includes(rule.value)) throw new AppError("VALIDATION_FAILED", "筛选选项无效");
  return rule.op === "neq" ? { not: rule.value } : { equals: rule.value };
}

export function numberFilter(rule: FilterRule) {
  const value = Number(rule.value);
  if (!/^\d+$/.test(rule.value) || !Number.isSafeInteger(value) || value > 1_000_000) {
    throw new AppError("VALIDATION_FAILED", "筛选数字必须是 0–1000000 的整数");
  }
  return { [rule.op === "gte" ? "gte" : rule.op === "lte" ? "lte" : "equals"]: value };
}

export function dateFilter(rule: FilterRule) {
  const range =
    rule.op === "gte"
      ? parseUtcDateFilter(rule.value, undefined, "筛选日期")
      : parseUtcDateFilter(undefined, rule.value, "筛选日期");
  return { gte: range.gte, lt: range.lt };
}
