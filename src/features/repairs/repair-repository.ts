import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/api/errors";
import { Prisma } from "@/generated/prisma/client";

export const repairDetailInclude = {
  memberProfile: { include: { user: true } },
  category: true,
  photos: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  },
  /** 参与维修人员：创建人恒排第一；只取展示名所需的最小字段。 */
  participants: {
    include: {
      memberProfile: {
        select: {
          id: true,
          nickname: true,
          realName: true,
          user: { select: { displayName: true } },
        },
      },
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  },
  reviews: { include: { reviewer: true }, orderBy: { createdAt: "asc" } },
  timeline: { include: { actor: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.RepairRecordInclude;

export const repairRepository = {
  async activeMemberForUser(userId: string | undefined) {
    if (!userId) throw new AppError("MEMBER_REQUIRED", "需要有效成员身份");
    const member = await getDb().memberProfile.findFirst({
      where: { userId, status: "ACTIVE", deletedAt: null },
    });
    if (!member) throw new AppError("MEMBER_REQUIRED", "需要有效成员身份");
    return member;
  },
  /**
   * `activeMemberForUser` 的**可空**版本。
   *
   * 用于「有成员档案时是本人视角、没有成员档案但有管理权限时是管理视角」的分派场景：
   * 纯管理员账号（只有 ADMIN 角色、没有成员档案）是合法存在的（M1 的账号发放、
   * M6 的账号创建都会产生），此时抛 `MEMBER_REQUIRED` 会把管理能力一起挡掉。
   * 与 `repair-query-service.list` 的按权限分派同一处理方式。
   */
  async findActiveMemberForUser(userId: string | undefined) {
    if (!userId) return null;
    return getDb().memberProfile.findFirst({
      where: { userId, status: "ACTIVE", deletedAt: null },
    });
  },
  async getById(id: string) {
    const record = await getDb().repairRecord.findUnique({
      where: { id },
      include: repairDetailInclude,
    });
    if (!record || record.deletedAt) throw new AppError("REPAIR_NOT_FOUND", "维修记录不存在");
    return record;
  },
  /**
   * 本人最近一条「空白草稿」：所有业务字段为空、无有效照片、仍是 DRAFT。
   * 新建页进页面即建档，复用空白草稿避免成员反复进出攒下一堆空记录
   * 。`result` 建档即写默认值，不作为「空白」判据。
   */
  async latestEmptyDraft(memberProfileId: string) {
    return getDb().repairRecord.findFirst({
      where: {
        memberProfileId,
        status: "DRAFT",
        deletedAt: null,
        // 已撤回的草稿不算空白草稿：它带着提交痕迹，不能被新建流程复用。
        submittedAt: null,
        repairDate: null,
        durationMinutes: null,
        categoryId: null,
        content: null,
        remark: null,
        photos: { none: { deletedAt: null } },
      },
      orderBy: { createdAt: "desc" },
      include: repairDetailInclude,
    });
  },
};
