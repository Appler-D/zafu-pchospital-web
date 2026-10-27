import { Button } from "@/components/ui/Button";
import { adminCopy } from "@/config/admin";
import { auditTargetLabel, formatAuditDateTime, shortAuditId } from "@/config/audit";
import type { AuditLogEntry } from "@/types/contracts";
import type { TableViewSpec } from "@/types/table";

/** 审计记录表列定义。 */

/** 页面上会被 `render` 用到的运行时值（`<AdminTable renderContext>` 传入）。 */
export type AuditTableContext = {
  /** 打开变更摘要窗口。 */
  onDetail: (entry: AuditLogEntry) => void;
};

const copy = adminCopy.audit;

export const auditTableSpec: TableViewSpec<AuditLogEntry, AuditTableContext> = {
  id: "audit",
  title: copy.title,
  rowKey: (entry) => entry.id,
  fields: [
    {
      key: "createdAt",
      label: copy.table.createdAt,
      kind: "datetime",

      numeric: false,
      render: (entry) => formatAuditDateTime(entry.createdAt),
    },
    {
      key: "action",
      label: copy.table.action,
      kind: "text",
      headClassName: "admin-table__grow",
      cellClassName: "admin-table__grow",
      render: (entry) => <code>{entry.action}</code>,
    },
    {
      key: "actor",
      sortable: false,
      label: copy.table.actor,
      kind: "text",
      render: (entry) => entry.actorName ?? copy.actorSystem,
    },
    {
      key: "target",
      sortKey: "targetType",
      label: copy.table.target,
      kind: "text",
      // 完整 ID 放 `title`：格子里只显示短 ID，需要时也能复制。
      title: (entry) => entry.targetId,
      render: (entry) => (
        // 目标类型 + 短 ID 排在一行：分成两行会让每一行都高 10px，
        // 而这个 ID 平时只需要能对上号。
        <span className="admin-contacts">
          <span>{auditTargetLabel(entry.targetType)}</span>
          <code>{shortAuditId(entry.targetId)}</code>
        </span>
      ),
    },
    {
      key: "requestId",
      label: copy.table.requestId,
      kind: "text",
      render: (entry) => <code>{entry.requestId}</code>,
    },
    {
      key: "result",
      label: copy.table.result,
      kind: "select",
      render: (entry) => (
        <span
          className={
            entry.result === "SUCCESS"
              ? "repair-tag repair-tag--approved"
              : "repair-tag repair-tag--rejected"
          }
        >
          {copy.resultLabels[entry.result]}
          {entry.errorCode ? ` ${entry.errorCode}` : ""}
        </span>
      ),
    },
    {
      key: "actions",
      sortable: false,
      label: copy.table.actions,
      kind: "readonly",
      // 只读表：唯一的动作是看摘要（before / after 是 JSON，塞进列里会把行高撑成几屏）。
      render: (entry, _index, { onDetail }) => (
        <span className="admin-actions">
          <Button variant="ghost" icon="eye" onClick={() => onDetail(entry)}>
            {copy.action.detail}
          </Button>
        </span>
      ),
    },
  ],
};
