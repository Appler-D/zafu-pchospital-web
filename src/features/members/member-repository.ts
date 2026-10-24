import { checkedGroup, groupSummary } from "@/lib/table/group-summary";
import { TABLE_GROUPS } from "@/features/admin/table-fields";
import type { TableListExtras } from "@/types/table";
import { Prisma } from "@/generated/prisma/client";
import { approvedRepairSql } from "@/features/analytics/analytics-repository";
import { memberFilterWhere } from "@/features/members/member-filter";
import { memberOrderBy } from "@/features/members/member-sort";
import { AppError } from "@/lib/api/errors";
import { getDb } from "@/lib/db/client";
import { maskEmail, maskPhone, maskQq } from "@/lib/audit/redaction";
import {
  EXPORT_MAX_ROWS,
  type MemberExportInput,
  type MemberListEntry,
  type MemberListInput,
  type RoleCode,
} from "@/types/contracts";

/**
 * 成员管理端数据访问（M6）。
 *
 * 与 `member-profile-repository.ts` 的分工：那个只服务「我自己的资料」，
 * 这个服务管理端的跨成员查询与写入。两者都不做权限判断 —— 权限与审计在 Service 层。
 *
 * 硬约束：本文件是管理端唯一读取 QQ / 手机号明文的地方，且只通过
 * `findSensitiveContacts` 暴露，调用方必须写审计（见 `MemberService.getDetail`）。
 */

const adminProfileSelect = {
  id: true,
  userId: true,
  realName: true,
  department: true,
  nickname: true,
  studentId: true,
  className: true,
  status: true,
  version: true,
  joinedAt: true,
  createdAt: true,
  /* 技能标签随列表一起取（第六轮验收）：成员表要直接显示「这个人会什么」，
     不必为此点开详情。用一次带 `in` 的关联查询取整页，不是逐行查询。
     顺序跟成员端一致（标签库的 sortOrder），空标签的成员是空数组。 */
  userSkills: {
    where: { deletedAt: null },
    select: { skill: { select: { id: true, name: true, isActive: true } } },
    orderBy: { skill: { sortOrder: "asc" } },
  },
  user: {
    select: {
      status: true,
      identities: {
        where: { deletedAt: null },
        select: { type: true, identifierNormalized: true, verifiedAt: true },
      },
      roles: {
        where: { revokedAt: null },
        select: { role: { select: { code: true } } },
      },
    },
  },
} as const;

type AdminProfileRow = {
  id: string;
  userId: string;
  realName: string;
  department: string;
  nickname: string | null;
  studentId: string | null;
  className: string | null;
  status: string;
  version: number;
  joinedAt: Date;
  createdAt: Date;
  userSkills: { skill: { id: string; name: string; isActive: boolean } }[];
  user: {
    status: string;
    identities: { type: string; identifierNormalized: string; verifiedAt: Date | null }[];
    roles: { role: { code: string } }[];
  };
};

export const memberRepository = {
  async list(
    input: MemberListInput,
  ): Promise<TableListExtras & { rows: MemberListEntry[]; total: number }> {
    const where = memberListWhere(input);

    const group = checkedGroup(input.groupBy, TABLE_GROUPS.members);
    const [total, rows, summary] = await Promise.all([
      getDb().memberProfile.count({ where }),
      getDb().memberProfile.findMany({
        where,
        select: adminProfileSelect,
        // 用户点过表头就按用户的选择排（白名单与映射见 `member-sort.ts`）；
        // 没点过则是管理员拖出来的 `sortOrder` 顺序。两条路径都由 `memberOrderBy`
        // 补 tiebreaker —— 主排序键重复时名次不确定，`skip` / `take` 的分页会重复或漏行。
        orderBy: memberOrderBy(input.sort),
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      group
        ? getDb()
            .memberProfile.groupBy({
              by: [group as "status" | "department"],
              where,
              _count: { _all: true },
            })
            .then((rows) =>
              groupSummary(
                group,
                rows.map((row) => ({
                  value: group === "status" ? row.status : row.department,
                  count: row._count._all,
                })),
              ),
            )
        : undefined,
    ]);

    const stats = await approvedRepairStats(rows.map((row) => row.id));
    return {
      total,
      summary,
      rows: rows.map((row) => toEntry(row, stats.get(row.id) ?? { count: 0, minutes: 0 })),
    };
  },

  /** 导出读取全量匹配数据；先判超限，再批量读取维修统计，不逐成员查询。 */
  async exportRows(input: MemberExportInput): Promise<MemberListEntry[]> {
    const rows = await getDb().memberProfile.findMany({
      where: memberListWhere(input),
      select: adminProfileSelect,
      orderBy: memberOrderBy(input.sort),
      take: EXPORT_MAX_ROWS + 1,
    });
    if (rows.length > EXPORT_MAX_ROWS)
      throw new AppError(
        "EXPORT_ROW_LIMIT_EXCEEDED",
        `导出行数超过上限 ${EXPORT_MAX_ROWS} 条，请缩小筛选范围后重试`,
      );
    const stats = await approvedRepairStats(rows.map((row) => row.id));
    return rows.map((row) => toEntry(row, stats.get(row.id) ?? { count: 0, minutes: 0 }));
  },

  /**
   * 按当前显示顺序取出全部成员档案 id（拖动排序用，第九轮验收）。
   *
   * 排序规则必须与 `list` **逐字一致**：拖动算的是「整份顺序」，落点前后关系一旦与
   * 列表不一致，就会出现「拖到 A 前面，刷新后 A 还在我后面」。
   * 只取 id、不分页：一次拖动要重排的是整份顺序（几十行规模，几十条 update 可接受）。
   * 传 `tx` 时在调用方的事务里执行 —— 顺序读与写必须同事务，否则并发拖动会互相覆盖。
   */
  async orderedIds(tx: Prisma.TransactionClient = getDb()): Promise<string[]> {
    const rows = await tx.memberProfile.findMany({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    return rows.map((row) => row.id);
  },

  async findById(
    memberProfileId: string,
    tx: Prisma.TransactionClient = getDb(),
  ): Promise<MemberListEntry | null> {
    const row = await tx.memberProfile.findFirst({
      where: { id: memberProfileId, deletedAt: null },
      select: adminProfileSelect,
    });
    if (!row) return null;
    const stats = await approvedRepairStats([row.id], tx);
    return toEntry(row, stats.get(row.id) ?? { count: 0, minutes: 0 });
  },

  /**
   * 读取明文联系方式。**仅供管理端详情使用**：返回值必须伴随一条审计日志。
   * 已软删除的身份不计入（避免把历史解绑的 QQ 当成当前联系方式）。
   */
  async findSensitiveContacts(
    memberProfileId: string,
    tx: Prisma.TransactionClient = getDb(),
  ): Promise<{ qq: string | null; phone: string | null }> {
    const row = await tx.memberProfile.findFirst({
      where: { id: memberProfileId, deletedAt: null },
      select: {
        user: {
          select: {
            identities: {
              where: { deletedAt: null, type: { in: ["QQ", "PHONE"] } },
              select: { type: true, identifierNormalized: true },
            },
          },
        },
      },
    });
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "成员不存在");
    return {
      qq: row.user.identities.find((item) => item.type === "QQ")?.identifierNormalized ?? null,
      phone:
        row.user.identities.find((item) => item.type === "PHONE")?.identifierNormalized ?? null,
    };
  },

  /**
   * 当前仍持有指定角色且账号有效的用户数。
   * 用于「不能撤销最后一个管理员」这道闸门。
   */
  async countActiveRoleHolders(roleCode: RoleCode): Promise<number> {
    return getDb().userRole.count({
      where: {
        revokedAt: null,
        role: { code: roleCode },
        user: { status: "ACTIVE", deletedAt: null },
      },
    });
  },
};

/** 正式统计口径下的维修次数与总时长（一次聚合取整页，不是逐行查询）。 */
type RepairStats = { count: number; minutes: number };

/**
 * 按**参与关系**统计（issue #114）：与排行榜 / 个人摘要同一口径 ——
 * 一条记录对每名参与者各计一次，时长不分人、取记录上的同一值；
 * 「有效记录」谓词复用 `approvedRepairSql`，不在这里重写第二份。
 */
async function approvedRepairStats(
  memberProfileIds: string[],
  tx: Prisma.TransactionClient = getDb(),
): Promise<Map<string, RepairStats>> {
  if (memberProfileIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<
    Array<{ memberProfileId: string; count: unknown; minutes: unknown }>
  >`
    SELECT p.member_profile_id AS memberProfileId,
           COUNT(*) AS count,
           COALESCE(SUM(rr.duration_minutes), 0) AS minutes
    FROM repair_record_participants p
    JOIN repair_records rr ON rr.id = p.repair_record_id
    WHERE p.member_profile_id IN (${Prisma.join(memberProfileIds)})
      AND ${approvedRepairSql("rr")}
    GROUP BY p.member_profile_id
  `;
  return new Map(
    rows.map((row) => [
      row.memberProfileId,
      { count: Number(row.count), minutes: Number(row.minutes) },
    ]),
  );
}

function toEntry(row: AdminProfileRow, stats: RepairStats): MemberListEntry {
  const qq = row.user.identities.find((item) => item.type === "QQ")?.identifierNormalized;
  const phone = row.user.identities.find((item) => item.type === "PHONE")?.identifierNormalized;
  const emails = row.user.identities.filter(
    (identity) => identity.type === "EMAIL" && identity.verifiedAt,
  );
  const email = emails.length === 1 ? emails[0]! : null;
  return {
    id: row.id,
    userId: row.userId,
    realName: row.realName,
    department: row.department as MemberListEntry["department"],
    nickname: row.nickname,
    studentId: row.studentId,
    className: row.className,
    status: row.status as MemberListEntry["status"],
    roles: row.user.roles
      .map((item) => item.role.code)
      .filter((code): code is RoleCode => code === "MEMBER" || code === "ADMIN")
      // 稳定顺序，避免同一成员两次请求返回不同顺序导致界面抖动。
      .sort(),
    userStatus: row.user.status as MemberListEntry["userStatus"],
    emailMasked: email ? maskEmail(email.identifierNormalized) : null,
    emailVerified: !!email,
    qqMasked: qq ? maskQq(qq) : null,
    phoneMasked: phone ? maskPhone(phone) : null,
    skills: row.userSkills.map((item) => ({
      id: item.skill.id,
      name: item.skill.name,
      isActive: item.skill.isActive,
    })),
    approvedRepairCount: stats.count,
    approvedRepairMinutes: stats.minutes,
    joinedAt: row.joinedAt.toISOString(),
    version: row.version,
  };
}

/** 列表、计数、分组与导出共用同一个成员筛选谓词。 */
function memberListWhere(input: MemberExportInput): Prisma.MemberProfileWhereInput {
  const query = input.query?.trim();
  return {
    deletedAt: null,
    status: input.status,
    user: {
      deletedAt: null,
      roles: input.role ? { some: { revokedAt: null, role: { code: input.role } } } : undefined,
    },
    // 列级筛选各自是一条 AND 条件（同一字段的 `gte` + `lte` 因此天然是区间，
    // 不会被 OR 拆开）。映射与取值校验见 `member-filter.ts`。
    ...(input.filters && input.filters.length > 0 ? { AND: memberFilterWhere(input.filters) } : {}),
    // 关键字命中的四个「资料字段」与两个「身份字段」必须是**同一个 OR**。
    // 曾经把身份匹配写在 `user.identities.some` 里与姓名 OR 并列，结果是两者被 AND：
    // 按姓名搜索永远不命中（因为 QQ/手机号里不含姓名），只有搜数字才有效。
    ...(query
      ? {
          OR: [
            { realName: { contains: query } },
            { nickname: { contains: query } },
            { studentId: { contains: query } },
            { className: { contains: query } },
            {
              user: {
                identities: {
                  some: {
                    type: { in: ["QQ", "PHONE"] },
                    deletedAt: null,
                    identifierNormalized: { contains: query },
                  },
                },
              },
            },
          ],
        }
      : {}),
  };
}
