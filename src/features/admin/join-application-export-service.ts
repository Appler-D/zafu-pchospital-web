import { auditTableQuery } from "@/lib/table/audit-query";
import { joinApplicationStatusLabels, provisionStatusLabels } from "@/config/admin";
import { joinQueryIds } from "@/features/recruitment/join-application-query";
import { AppError } from "@/lib/api/errors";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { requirePermission } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { toCsvWith, type ExportColumn } from "./export-csv";
import { toXlsxWith } from "./export-xlsx";
import {
  EXPORT_MAX_ROWS,
  type AuthorizedActor,
  type ExportFormat,
  type JoinApplicationExportInput,
  type JoinApplicationExportResult,
  type JoinApplicationExportRow,
  type JoinApplicationExportServiceContract,
  type JoinApplicationStatus,
  type ProvisionStatus,
} from "@/types/contracts";

/**
 * 列定义。顺序即表头顺序，CSV 与 XLSX 共用（与维修导出同一份列模型）。
 *
 * 这里**故意包含 QQ 与手机号明文**：需求 §4.4 把「导出新成员报名数据」列为管理员能力，
 * 招募联系本人必须拿到真实联系方式；而需求 §34 对维修导出的要求是「只输出图片 URL /
 * 记录 ID」，两者口径本就不同。代价是这条路径**必须**有独立的权限与审计动作，
 * 不能蹭 `repair.exported`。
 */
export const APPLICATION_EXPORT_COLUMNS: readonly ExportColumn<JoinApplicationExportRow>[] = [
  { key: "ticketNo", header: "报名编号" },
  { key: "recruitmentCycle", header: "招募批次" },
  { key: "realName", header: "姓名" },
  { key: "studentId", header: "学号" },
  { key: "className", header: "班级" },
  { key: "qq", header: "QQ 号" },
  { key: "phone", header: "手机号" },
  { key: "status", header: "报名状态" },
  { key: "provisionStatus", header: "账号发放" },
  { key: "preferredDirection", header: "意向方向" },
  { key: "submittedAt", header: "提交时间" },
  { key: "lastReviewedAt", header: "最近面试时间" },
  { key: "applicationId", header: "报名记录 ID" },
];

const COLUMN_WIDTHS: Record<string, number> = {
  ticketNo: 30,
  recruitmentCycle: 14,
  realName: 14,
  studentId: 18,
  className: 18,
  qq: 16,
  phone: 16,
  status: 14,
  provisionStatus: 12,
  preferredDirection: 20,
  submittedAt: 20,
  lastReviewedAt: 20,
  applicationId: 38,
};

/**
 * 报名数据导出（M6 批次 2，需求 §4.4）。
 *
 * 与维修导出共用三条硬规则：筛选条件与列表**同源**（复用 `joinQueryIds`）、
 * 超限**拒绝而不是截断**、导出**必写审计**。
 * 审计动作用 `join.applications.exported`，与 `repair.exported` 分开 ——
 * 这份文件里带明文联系方式，检索时不该和维修导出混在一起。
 */
export const joinApplicationExportService: JoinApplicationExportServiceContract = {
  async export(
    input: JoinApplicationExportInput,
    format: ExportFormat,
    actor: AuthorizedActor,
  ): Promise<JoinApplicationExportResult> {
    requirePermission(actor, "data:export");
    const rows = await loadRows(input);
    const body =
      format === "CSV"
        ? toCsvWith(APPLICATION_EXPORT_COLUMNS, rows)
        : await toXlsxWith(rows, {
            sheetName: "报名记录",
            columns: APPLICATION_EXPORT_COLUMNS,
            widths: COLUMN_WIDTHS,
            // QQ / 手机号是长数字，学号要保住前导零：一律按文本写入，
            // 避免 Excel 转成科学计数法或把 `001234` 改成 `1234`。
            textColumns: ["qq", "phone", "studentId", "applicationId"],
          });
    const fileName = buildFileName(format);
    await inSerializableTransaction(async (tx) => {
      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "join.applications.exported",
        targetType: "JoinApplicationExport",
        targetId: actor.userId ?? "00000000-0000-0000-0000-000000000000",
        result: "SUCCESS",
        after: { format, rowCount: rows.length, filter: auditTableQuery(input) },
      });
    });
    return {
      format,
      fileName,
      contentType:
        format === "CSV"
          ? "text/csv; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body,
      rowCount: rows.length,
    };
  },
};

async function loadRows(input: JoinApplicationExportInput): Promise<JoinApplicationExportRow[]> {
  const ids = await joinQueryIds(input, EXPORT_MAX_ROWS + 1);
  if (ids.length > EXPORT_MAX_ROWS)
    throw new AppError(
      "EXPORT_ROW_LIMIT_EXCEEDED",
      `导出行数超过上限 ${EXPORT_MAX_ROWS} 条，请缩小筛选范围后重试`,
    );
  const found = await getDb().joinApplication.findMany({
    where: { id: { in: ids.map((row) => row.id) }, deletedAt: null },
    select: {
      id: true,
      ticketNo: true,
      recruitmentCycle: true,
      realName: true,
      studentId: true,
      className: true,
      qqNormalized: true,
      phoneNormalized: true,
      status: true,
      provisionStatus: true,
      preferredDirection: true,
      submittedAt: true,
      lastReviewedAt: true,
    },
    // 多取一行判断是否超限，避免额外一次 count。
    take: EXPORT_MAX_ROWS + 1,
  });
  const byId = new Map(found.map((row) => [row.id, row]));
  const records = ids.flatMap((row) => {
    const record = byId.get(row.id);
    return record ? [record] : [];
  });
  if (records.length > EXPORT_MAX_ROWS) {
    throw new AppError(
      "EXPORT_ROW_LIMIT_EXCEEDED",
      `导出行数超过上限 ${EXPORT_MAX_ROWS} 条，请缩小筛选范围后重试`,
    );
  }
  return records.map((record) => ({
    ticketNo: record.ticketNo,
    recruitmentCycle: record.recruitmentCycle,
    realName: record.realName,
    // 历史报名（迁移前）两列为 NULL：导出空字符串，不出现字面量 `null`。
    studentId: record.studentId ?? "",
    className: record.className ?? "",
    qq: record.qqNormalized,
    phone: record.phoneNormalized,
    status: joinApplicationStatusLabels[record.status as JoinApplicationStatus],
    provisionStatus: provisionStatusLabels[record.provisionStatus as ProvisionStatus],
    preferredDirection: record.preferredDirection ?? "",
    submittedAt: formatShanghaiDateTime(record.submittedAt),
    lastReviewedAt: record.lastReviewedAt ? formatShanghaiDateTime(record.lastReviewedAt) : "",
    applicationId: record.id,
  }));
}

function buildFileName(format: ExportFormat): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `join-applications-${stamp}.${format === "CSV" ? "csv" : "xlsx"}`;
}

/** `Asia/Shanghai` 的 `YYYY-MM-DD HH:mm`。导出给人看，因此用本地作息时区而非 UTC。 */
function formatShanghaiDateTime(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(value)
    .replace(",", "");
}
