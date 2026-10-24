import type { TableListOptions } from "@/types/table";

/** 保留条件结构，不把新增文本筛选值或搜索词带入业务审计。 */
export function auditTableQuery<T extends TableListOptions & { query?: string }>(input: T) {
  return {
    ...input,
    query: input.query ? "[已隐藏]" : undefined,
    filters: input.filters?.map(({ field, op }) => ({ field, op })),
  };
}
