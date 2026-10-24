import { AppError } from "@/lib/api/errors";
import { sortParam, sortRules } from "@/lib/api/list-query";
import type { SortRule } from "@/types/table";

/** 只调用领域声明的映射；即使绕过 HTTP 也校验方向、字段与条数。 */
export function tableOrderBy<T>(
  rules: readonly SortRule[] | undefined,
  fields: Readonly<Record<string, (direction: SortRule["direction"]) => T>>,
  defaults: readonly T[],
  tieBreaker: T,
): T[] {
  if (!rules?.length) return [...defaults];
  const valid = sortRules(sortParam(rules), Object.keys(fields));
  return [
    ...valid.map((rule) => {
      const build = Object.hasOwn(fields, rule.field) ? fields[rule.field] : undefined;
      if (!build) throw new AppError("VALIDATION_FAILED", "排序字段无效");
      return build(rule.direction);
    }),
    tieBreaker,
  ];
}
