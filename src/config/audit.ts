import { adminCopy } from "@/config/admin";

/** 审计表格与变更摘要共用的展示格式。 */

/** 表格里只显示短 ID（8 位）；完整值在单元格的 `title` 里，需要时也能复制。 */
export function shortAuditId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** 已知目标类型给中文名；未知的一律原样显示，不猜也不隐藏。 */
export function auditTargetLabel(targetType: string): string {
  const labels: Record<string, string> = adminCopy.audit.targetLabels;
  return labels[targetType] ?? targetType;
}

/** 审计时间是排查依据，精确到秒。 */
export function formatAuditDateTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(new Date(iso))
    .replace(/\//g, "-");
}
