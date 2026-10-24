import { Prisma, type JoinApplication } from "@/generated/prisma/client";
import { JOIN_FILTERABLE, JOIN_SORTABLE, TABLE_GROUPS } from "@/features/admin/table-fields";
import { parseUtcDateFilter } from "@/lib/api/date-filter";
import { AppError } from "@/lib/api/errors";
import { sortParam, sortRules } from "@/lib/api/list-query";
import { getDb } from "@/lib/db/client";
import { checkedFilters } from "@/lib/table/filter-value";
import { checkedGroup, groupSummary } from "@/lib/table/group-summary";
import {
  JoinApplicationStatus,
  ProvisionStatus,
  type JoinApplicationExportInput,
} from "@/types/contracts";

// 只含固定 SQL 标识符。客户端值始终由 Prisma.sql 参数化；不接受任意列名。
const columns: Readonly<Record<string, Prisma.Sql>> = {
  ticketNo: Prisma.sql`j.ticket_no`,
  realName: Prisma.sql`j.real_name`,
  recruitmentCycle: Prisma.sql`j.recruitment_cycle`,
  status: Prisma.sql`j.status`,
  provisionStatus: Prisma.sql`j.provision_status`,
  submittedAt: Prisma.sql`j.submitted_at`,
  lastReviewedAt: Prisma.sql`j.last_reviewed_at`,
  approvedAt: Prisma.sql`(SELECT MIN(r.created_at) FROM join_application_reviews r WHERE r.application_id = j.id AND r.result = 'PASSED')`,
};

const like = (value: string) => `%${value.replace(/[=%_]/g, "=$&")}%`;

/** 列表、分页总数、分组及导出共用谓词，避免通过时间派生查询与 Prisma 两套口径。 */
export function joinQueryWhere(input: JoinApplicationExportInput): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`j.deleted_at IS NULL`];
  const cycle = input.recruitmentCycle?.trim();
  if (cycle && cycle.length > 32)
    throw new AppError("VALIDATION_FAILED", "招募批次不能超过 32 字符");
  if (cycle) conditions.push(Prisma.sql`j.recruitment_cycle = ${cycle}`);
  if (input.status) {
    if (!JoinApplicationStatus.includes(input.status))
      throw new AppError("VALIDATION_FAILED", "报名状态无效");
    conditions.push(Prisma.sql`j.status = ${input.status}`);
  }
  if (input.provisionStatus) {
    if (!ProvisionStatus.includes(input.provisionStatus))
      throw new AppError("VALIDATION_FAILED", "开通状态无效");
    conditions.push(Prisma.sql`j.provision_status = ${input.provisionStatus}`);
  }
  const submitted = parseUtcDateFilter(input.submittedFrom, input.submittedTo, "提交时间");
  if (submitted.gte) conditions.push(Prisma.sql`j.submitted_at >= ${submitted.gte}`);
  if (submitted.lt) conditions.push(Prisma.sql`j.submitted_at < ${submitted.lt}`);
  const query = input.query?.trim();
  if (query) {
    const matches = [
      Prisma.sql`j.ticket_no LIKE ${like(query)} ESCAPE '='`,
      Prisma.sql`j.real_name LIKE ${like(query)} ESCAPE '='`,
    ];
    const digits = query.replace(/\D/g, "");
    if (/^\d{5,11}$/.test(digits)) matches.push(Prisma.sql`j.qq_normalized = ${digits}`);
    if (/^1[3-9]\d{9}$/.test(digits)) matches.push(Prisma.sql`j.phone_normalized = ${digits}`);
    conditions.push(Prisma.sql`(${Prisma.join(matches, " OR ")})`);
  }
  for (const rule of checkedFilters(input.filters, JOIN_FILTERABLE)) {
    const column = columns[rule.field];
    if (rule.field === "status" || rule.field === "provisionStatus") {
      const allowed = rule.field === "status" ? JoinApplicationStatus : ProvisionStatus;
      if (!(allowed as readonly string[]).includes(rule.value))
        throw new AppError("VALIDATION_FAILED", "筛选选项无效");
      conditions.push(
        rule.op === "eq"
          ? Prisma.sql`${column} = ${rule.value}`
          : Prisma.sql`${column} <> ${rule.value}`,
      );
    } else if (rule.op === "contains") {
      if (rule.value.length > 80) throw new AppError("VALIDATION_FAILED", "筛选文本过长");
      conditions.push(Prisma.sql`${column} LIKE ${like(rule.value)} ESCAPE '='`);
    } else {
      const range =
        rule.op === "gte"
          ? parseUtcDateFilter(rule.value, undefined, "筛选日期")
          : parseUtcDateFilter(undefined, rule.value, "筛选日期");
      conditions.push(
        rule.op === "gte"
          ? Prisma.sql`${column} >= ${range.gte!}`
          : Prisma.sql`${column} < ${range.lt!}`,
      );
    }
  }
  return Prisma.join(conditions, " AND ");
}

type JoinListRow = Pick<
  JoinApplication,
  | "id"
  | "status"
  | "provisionStatus"
  | "admittedDepartment"
  | "lastReviewedAt"
  | "ticketNo"
  | "recruitmentCycle"
  | "realName"
  | "qqNormalized"
  | "phoneNormalized"
  | "submittedAt"
> & { approvedAt: Date | null };

function joinPageSql(
  input: JoinApplicationExportInput,
  take: number,
  skip: number,
  select: Prisma.Sql,
) {
  const rules = sortRules(sortParam(input.sort ?? []), JOIN_SORTABLE);
  const order = rules.length
    ? rules.map(
        (rule) =>
          Prisma.sql`${columns[rule.field]} ${rule.direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`}`,
      )
    : [Prisma.sql`j.submitted_at DESC`];
  return Prisma.sql`SELECT ${select} FROM join_applications j
    WHERE ${joinQueryWhere(input)} ORDER BY ${Prisma.join([...order, Prisma.sql`j.id DESC`])}
    LIMIT ${take} OFFSET ${skip}`;
}

export function joinQueryIds(input: JoinApplicationExportInput, take: number, skip = 0) {
  return getDb().$queryRaw<{ id: string }[]>(joinPageSql(input, take, skip, Prisma.sql`j.id`));
}

/** 列表一次仅读取 DTO 所需字段，不因派生时间额外读取整行资料。 */
export function joinQueryRows(input: JoinApplicationExportInput, take: number, skip = 0) {
  return getDb().$queryRaw<JoinListRow[]>(
    joinPageSql(
      input,
      take,
      skip,
      Prisma.sql`
    j.id, j.status, j.provision_status AS provisionStatus, j.admitted_department AS admittedDepartment,
    j.last_reviewed_at AS lastReviewedAt, j.ticket_no AS ticketNo, j.recruitment_cycle AS recruitmentCycle,
    j.real_name AS realName, j.qq_normalized AS qqNormalized, j.phone_normalized AS phoneNormalized,
    j.submitted_at AS submittedAt, ${columns.approvedAt} AS approvedAt`,
    ),
  );
}

export async function joinQueryTotal(input: JoinApplicationExportInput) {
  const [row] = await getDb().$queryRaw<{ total: bigint }[]>(
    Prisma.sql`SELECT COUNT(*) AS total FROM join_applications j WHERE ${joinQueryWhere(input)}`,
  );
  return Number(row.total);
}

export async function joinQuerySummary(input: JoinApplicationExportInput) {
  const group = checkedGroup(input.groupBy, TABLE_GROUPS["join-applications"]);
  if (!group) return undefined;
  const rows = await getDb().$queryRaw<{ value: string; count: bigint }[]>(Prisma.sql`
    SELECT ${columns[group]} AS value, COUNT(*) AS count FROM join_applications j
    WHERE ${joinQueryWhere(input)} GROUP BY ${columns[group]}`);
  return groupSummary(
    group,
    rows.map((row) => ({ value: row.value, count: Number(row.count) })),
  );
}
