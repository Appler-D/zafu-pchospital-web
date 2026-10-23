import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";

import { maskActivityPhone } from "@/features/repair-activities/phone-mask";
import {
  canCheckInRegistration,
  assertActivityStaffOpen,
  canServeRegistration,
  canWithdrawRegistration,
  deriveRepairActivityStatus,
  EFFECTIVE_REGISTRATION_STATUSES,
  mapIssueTypeToCategoryCode,
  remainingCapacity,
  repairActivityIssueTypeLabels,
  shanghaiCalendarDay,
  sortQueueByCheckedInAt,
  type RepairActivityIssueType,
  type RepairActivityStatus,
  assertValidIssueType,
  validateCheckInIssueTypeUpdates,
  type StaffCheckInIssueTypeUpdate,
} from "@/features/repair-activities/repair-activity-validation";
import { resolveDisplayName } from "@/features/analytics/analytics-policy";
import { createServeDraftForActivity } from "@/features/repairs/repair-service";
import { localRepairPhotoStorage } from "@/features/repairs/repair-photo-storage";
import { repairRepository } from "@/features/repairs/repair-repository";
import { AppError } from "@/lib/api/errors";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { requirePermission } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import type { AuthorizedActor, RepairStatus } from "@/types/contracts";

export type StaffActivityListItem = {
  id: string;
  title: string;
  activityAt: string;
  capacity: number;
  signupOpensAt: string;
  signupClosesAt: string;
  status: RepairActivityStatus;
  registeredCount: number;
  remaining: number;
  attended: boolean;
};

export type StaffRegistrationView = {
  id: string;
  activityId: string;
  name: string;
  phoneMasked: string;
  issueType: RepairActivityIssueType;
  issueTypeLabel: string;
  /** 机型，选填（issue #68）：接待落单时随维修记录一起带过去。 */
  deviceModel: string | null;
  status: string;
  checkedInAt: string | null;
  servedAt: string | null;
  repairRecordId: string | null;
  createdAt: string;
};

/** 已接待行：报名视图 + 对应维修单状态（`null` = 记录缺失或已软删除）。 */
export type StaffServedRow = StaffRegistrationView & {
  recordStatus: RepairStatus | null;
  /** 这条记录已从审核中撤回（issue #165）：状态是 DRAFT，但曾经提交过。 */
  recordWithdrawn: boolean;
  /** 当前操作者能否撤销这次接待：接待者本人或活动管理员，且草稿仍未提交（issue #166）。 */
  canRevert: boolean;
};

/** 未提交的接待草稿：看板弹层与全局接单拦截共用（issue #79 第 6 项）。 */
export type StaffServeDraft = {
  repairRecordId: string;
  registrationId: string;
  ownerName: string;
  activityTitle: string;
};

/** 撤销接待（issue #166）：报名回到接待前状态，草稿及照片已删除。 */
export type RevertServeResultView = {
  registration: StaffRegistrationView;
  deletedRecordId: string;
  photosDeleted: number;
};

/**
 * 出勤成员条目（issue #107）：只下发展示名与签到时间，
 * 不含 QQ、手机号、学号等身份字段。
 */
export type StaffAttendanceMemberView = {
  memberProfileId: string;
  name: string;
  checkedInAt: string;
};

export type StaffBoardView = {
  activity: StaffActivityListItem;
  attended: boolean;
  attendanceCheckedInAt: string | null;
  /**
   * 当前账号是否具备活动管理员权限（`activity:admin`，issue #108）：
   * 决定「待签到」区与「撤回」按钮的可见性；签到 / 撤回接口同样只对管理员开放。
   */
  canAdmin: boolean;
  /**
   * 本场出勤成员（按签到时间升序，issue #107）。仅对管理员下发，
   * 成员恒为空数组（数据最小化，issue #108）。
   */
  attendanceMembers: StaffAttendanceMemberView[];
  /** 可签到（REGISTERED）。仅对管理员下发，成员恒为空数组（数据最小化，issue #108）。 */
  eligible: StaffRegistrationView[];
  /** 排队（CHECKED_IN，按 checkedInAt ASC） */
  queue: StaffRegistrationView[];
  /** 本场已接待（按 servedAt 倒序）；常驻区块的数据来源。 */
  served: StaffServedRow[];
  /** 全局拦截：本成员存在未提交的接待草稿时非 null，供点击「接待」时直接弹提示。 */
  pendingServeDraft: StaffServeDraft | null;
};

export type ServeResultView = {
  registration: StaffRegistrationView;
  repairRecordId: string;
};

const effectiveStatusFilter = {
  deletedAt: null as null,
  status: { in: [...EFFECTIVE_REGISTRATION_STATUSES] },
};

function toStaffReg(row: {
  id: string;
  activityId: string;
  name: string;
  phone: string;
  issueType: string;
  deviceModel: string | null;
  status: string;
  checkedInAt: Date | null;
  servedAt: Date | null;
  repairRecordId: string | null;
  createdAt: Date;
}): StaffRegistrationView {
  const issueType = assertValidIssueType(row.issueType);
  return {
    id: row.id,
    activityId: row.activityId,
    name: row.name,
    phoneMasked: maskActivityPhone(row.phone),
    issueType,
    issueTypeLabel: repairActivityIssueTypeLabels[issueType],
    deviceModel: row.deviceModel,
    status: row.status,
    checkedInAt: row.checkedInAt?.toISOString() ?? null,
    servedAt: row.servedAt?.toISOString() ?? null,
    repairRecordId: row.repairRecordId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireStaffMember(actor: AuthorizedActor) {
  requirePermission(actor, "activity:staff");
  return repairRepository.activeMemberForUser(actor.userId);
}

/** 签到 / 撤回收紧为活动管理员（issue #108）：权限之外仍要求有效成员档案。 */
async function requireAdminMember(actor: AuthorizedActor) {
  requirePermission(actor, "activity:admin");
  return repairRepository.activeMemberForUser(actor.userId);
}

async function loadActivityOrThrow(activityId: string) {
  const activity = await getDb().repairActivity.findFirst({
    where: { id: activityId, deletedAt: null },
  });
  if (!activity) throw new AppError("ACTIVITY_NOT_FOUND", "活动不存在");
  return activity;
}

/** 活动锁后读最新窗口并取时；每次事务重试重新判断，避免改期与等锁越界。 */
async function requireStaffOpen(tx: Prisma.TransactionClient, activityId: string) {
  await tx.$queryRaw`SELECT id FROM repair_activities WHERE id = ${activityId} FOR UPDATE`;
  const activity = await tx.repairActivity.findFirst({
    where: { id: activityId, deletedAt: null },
  });
  if (!activity) throw new AppError("ACTIVITY_NOT_FOUND", "活动不存在");
  const now = new Date();
  assertActivityStaffOpen(activity, now);
  return { activity, now };
}

async function requireAttendance(
  activityId: string,
  memberProfileId: string,
): Promise<{ id: string; checkedInAt: Date }> {
  const attendance = await getDb().repairActivityAttendance.findUnique({
    where: {
      activityId_memberProfileId: { activityId, memberProfileId },
    },
  });
  if (!attendance) {
    throw new AppError("ACTIVITY_ATTENDANCE_REQUIRED", "请先完成本场出勤后再操作");
  }
  return attendance;
}

async function countEffective(activityId: string): Promise<number> {
  return getDb().repairActivityRegistration.count({
    where: { activityId, ...effectiveStatusFilter },
  });
}

/**
 * 「未完成的接待草稿」判据（issue #79 第 6 项，看板与 serve 拦截共用）。
 *
 * 命中条件：记录归属本人、`status = DRAFT`、未软删除，且由报名接待产生
 * （反向关系 `activityRegistration` 非空）。手工草稿与已软删除草稿都不算，
 * `PENDING` / `REJECTED` 也不拦截。
 */
function pendingServeDraftWhere(memberProfileId: string) {
  return {
    memberProfileId,
    status: "DRAFT" as const,
    deletedAt: null,
    // 已撤回审核的草稿（submittedAt 非空）不算「未提交的接待草稿」（issue #165）：
    // 它已经走过一次提交流程，不应再拦截下一位客户的接待。
    submittedAt: null,
    activityRegistration: { isNot: null },
  };
}

async function findPendingServeDraft(memberProfileId: string): Promise<StaffServeDraft | null> {
  const draft = await getDb().repairRecord.findFirst({
    where: pendingServeDraftWhere(memberProfileId),
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      ownerName: true,
      activityRegistration: {
        select: { id: true, name: true, activity: { select: { title: true } } },
      },
    },
  });
  if (!draft) return null;
  return {
    repairRecordId: draft.id,
    registrationId: draft.activityRegistration?.id ?? "",
    // 接待草稿按定义必有 ownerName；回退到报名姓名与「客户」只为类型兜底。
    ownerName: draft.ownerName ?? draft.activityRegistration?.name ?? "客户",
    activityTitle: draft.activityRegistration?.activity.title ?? "",
  };
}

function toListItem(
  row: {
    id: string;
    title: string;
    activityAt: Date;
    capacity: number;
    signupOpensAt: Date;
    signupClosesAt: Date;
  },
  registeredCount: number,
  attended: boolean,
  now: Date,
): StaffActivityListItem {
  const status = deriveRepairActivityStatus({
    now,
    activityAt: row.activityAt,
    signupOpensAt: row.signupOpensAt,
    signupClosesAt: row.signupClosesAt,
    effectiveRegistrationCount: registeredCount,
    capacity: row.capacity,
  });
  return {
    id: row.id,
    title: row.title,
    activityAt: row.activityAt.toISOString(),
    capacity: row.capacity,
    signupOpensAt: row.signupOpensAt.toISOString(),
    signupClosesAt: row.signupClosesAt.toISOString(),
    status,
    registeredCount,
    remaining: remainingCapacity(row.capacity, registeredCount),
    attended,
  };
}

export const repairActivityStaffService = {
  async getRegistrationPhone(
    activityId: string,
    registrationId: string,
    actor: AuthorizedActor,
  ): Promise<{ phone: string }> {
    await requireStaffMember(actor);
    return inSerializableTransaction(async (tx) => {
      const activity = await tx.repairActivity.findFirst({
        where: { id: activityId, deletedAt: null },
        select: { id: true },
      });
      if (!activity) throw new AppError("ACTIVITY_NOT_FOUND", "活动不存在");
      const registration = await tx.repairActivityRegistration.findFirst({
        where: { id: registrationId, activityId, ...effectiveStatusFilter },
        select: { id: true, phone: true },
      });
      if (!registration) {
        throw new AppError("ACTIVITY_REGISTRATION_NOT_FOUND", "报名不存在");
      }
      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair_activity.registration_phone.viewed",
        targetType: "RepairActivityRegistration",
        targetId: registration.id,
        result: "SUCCESS",
        after: { activityId },
      });
      return { phone: registration.phone };
    });
  },

  async listForStaff(actor: AuthorizedActor): Promise<StaffActivityListItem[]> {
    const member = await requireStaffMember(actor);
    const now = new Date();
    const rows = await getDb().repairActivity.findMany({
      where: { deletedAt: null },
      orderBy: [{ activityAt: "asc" }, { createdAt: "asc" }],
    });
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const [countGroups, attendances] = await Promise.all([
      getDb().repairActivityRegistration.groupBy({
        by: ["activityId"],
        where: { activityId: { in: ids }, ...effectiveStatusFilter },
        _count: { _all: true },
      }),
      getDb().repairActivityAttendance.findMany({
        where: { activityId: { in: ids }, memberProfileId: member.id },
        select: { activityId: true },
      }),
    ]);
    const counts = new Map(countGroups.map((g) => [g.activityId, g._count._all]));
    const attendedSet = new Set(attendances.map((a) => a.activityId));
    return rows.map((row) =>
      toListItem(row, counts.get(row.id) ?? 0, attendedSet.has(row.id), now),
    );
  },

  async markAttendance(
    activityId: string,
    actor: AuthorizedActor,
  ): Promise<{ attended: boolean; checkedInAt: string }> {
    const member = await requireStaffMember(actor);
    await loadActivityOrThrow(activityId);

    return inSerializableTransaction(async (tx) => {
      const { now } = await requireStaffOpen(tx, activityId);
      const existing = await tx.repairActivityAttendance.findUnique({
        where: {
          activityId_memberProfileId: { activityId, memberProfileId: member.id },
        },
      });
      if (existing) {
        return { attended: true, checkedInAt: existing.checkedInAt.toISOString() };
      }
      const created = await tx.repairActivityAttendance.create({
        data: {
          id: randomUUID(),
          activityId,
          memberProfileId: member.id,
          checkedInAt: now,
        },
      });
      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair_activity.attendance_marked",
        targetType: "RepairActivityAttendance",
        targetId: created.id,
        result: "SUCCESS",
        after: { activityId, memberProfileId: member.id },
      });
      return { attended: true, checkedInAt: created.checkedInAt.toISOString() };
    });
  },

  async getBoard(activityId: string, actor: AuthorizedActor): Promise<StaffBoardView> {
    const member = await requireStaffMember(actor);
    const canAdmin = actor.permissions.includes("activity:admin");
    const activity = await loadActivityOrThrow(activityId);
    const now = new Date();
    const [memberCount, attendance, registrations, pendingDraft, attendanceRows] =
      await Promise.all([
        // 管理员会读取全部有效报名，可直接计数；成员仍只在库层取排队/已接待的资料。
        canAdmin ? Promise.resolve(null) : countEffective(activityId),
        canAdmin
          ? Promise.resolve(null)
          : getDb().repairActivityAttendance.findUnique({
              where: {
                activityId_memberProfileId: { activityId, memberProfileId: member.id },
              },
            }),
        getDb().repairActivityRegistration.findMany({
          where: {
            activityId,
            deletedAt: null,
            // 成员只取「排队 + **本人**接待」（issue #207）：他人接待的客户资料（含脱敏
            // 电话与记录状态）在库层就不进入成员请求，而不是前端隐藏。管理员仍是全部有效报名。
            ...(canAdmin
              ? { status: { in: [...EFFECTIVE_REGISTRATION_STATUSES] } }
              : {
                  OR: [
                    { status: "CHECKED_IN" },
                    { status: "SERVED", servedByMemberProfileId: member.id },
                  ],
                }),
          },
          include: {
            repairRecord: {
              select: { id: true, status: true, submittedAt: true, deletedAt: true },
            },
          },
        }),
        findPendingServeDraft(member.id),
        // 出勤名单仅管理员视图需要；成员在库层就不取（issue #108）。
        canAdmin
          ? getDb().repairActivityAttendance.findMany({
              where: { activityId },
              orderBy: [{ checkedInAt: "asc" }, { id: "asc" }],
              select: {
                memberProfileId: true,
                checkedInAt: true,
                memberProfile: {
                  select: {
                    nickname: true,
                    realName: true,
                    user: { select: { displayName: true } },
                  },
                },
              },
            })
          : Promise.resolve([]),
      ]);

    const registeredCount = canAdmin ? registrations.length : memberCount!;
    const ownAttendance = canAdmin
      ? attendanceRows.find((row) => row.memberProfileId === member.id)
      : attendance;

    const eligible = canAdmin
      ? registrations
          .filter((r) => r.status === "REGISTERED")
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(toStaffReg)
      : [];

    const queue = sortQueueByCheckedInAt(
      registrations.filter((r) => r.status === "CHECKED_IN"),
    ).map(toStaffReg);

    const served: StaffServedRow[] = registrations
      // 查询已经把成员范围收窄；这里再兜一层，防止以后改查询时把他人接待记录漏给成员。
      .filter(
        (row) => row.status === "SERVED" && (canAdmin || row.servedByMemberProfileId === member.id),
      )
      .sort((a, b) => (b.servedAt?.getTime() ?? 0) - (a.servedAt?.getTime() ?? 0))
      .map((row) => {
        const recordStatus =
          row.repairRecord && !row.repairRecord.deletedAt
            ? (row.repairRecord.status as RepairStatus)
            : null;
        // 已撤回的草稿仍可编辑，但不再算「未提交的接待草稿」（issue #165）。
        const recordWithdrawn = recordStatus === "DRAFT" && Boolean(row.repairRecord?.submittedAt);
        return {
          ...toStaffReg(row),
          recordStatus,
          recordWithdrawn,
          // 撤销接待：仅接待者本人或活动管理员；已提交 / 已审核 / 已撤回的记录不能撤（issue #166）。
          canRevert:
            recordStatus === "DRAFT" &&
            !recordWithdrawn &&
            (canAdmin || row.servedByMemberProfileId === member.id),
        };
      });

    const attendanceMembers: StaffAttendanceMemberView[] = attendanceRows.map((row) => ({
      memberProfileId: row.memberProfileId,
      name: resolveDisplayName({
        nickname: row.memberProfile.nickname,
        realName: row.memberProfile.realName,
        displayName: row.memberProfile.user.displayName,
      }),
      checkedInAt: row.checkedInAt.toISOString(),
    }));

    return {
      activity: toListItem(activity, registeredCount, Boolean(ownAttendance), now),
      attended: Boolean(ownAttendance),
      attendanceCheckedInAt: ownAttendance?.checkedInAt.toISOString() ?? null,
      canAdmin,
      attendanceMembers,
      eligible,
      queue,
      served,
      pendingServeDraft: pendingDraft,
    };
  },

  async checkIn(
    activityId: string,
    registrationIds: string[],
    actor: AuthorizedActor,
    issueTypeUpdates: StaffCheckInIssueTypeUpdate[] = [],
  ): Promise<{ checkedIn: StaffRegistrationView[] }> {
    const member = await requireAdminMember(actor);
    await loadActivityOrThrow(activityId);
    await requireAttendance(activityId, member.id);

    const uniqueIds = [...new Set(registrationIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      throw new AppError("VALIDATION_FAILED", "请至少选择一条报名记录", {
        fieldErrors: { registrationIds: ["请至少选择一条"] },
      });
    }
    if (uniqueIds.length > 100) {
      throw new AppError("VALIDATION_FAILED", "单次最多签到 100 条");
    }
    const updates = new Map(
      validateCheckInIssueTypeUpdates(issueTypeUpdates, uniqueIds).map((item) => [
        item.registrationId,
        item.issueType,
      ]),
    );

    return inSerializableTransaction(async (tx) => {
      const { now } = await requireStaffOpen(tx, activityId);
      const checkedIn: StaffRegistrationView[] = [];

      for (const registrationId of uniqueIds) {
        const reg = await tx.repairActivityRegistration.findFirst({
          where: { id: registrationId, activityId, deletedAt: null },
        });
        if (!reg) {
          throw new AppError("ACTIVITY_REGISTRATION_NOT_FOUND", "报名记录不存在");
        }
        if (reg.status === "CHECKED_IN") {
          if (updates.has(registrationId) && updates.get(registrationId) !== reg.issueType) {
            throw new AppError(
              "ACTIVITY_REGISTRATION_STATE_INVALID",
              "已入队客户不可在签到重试中修改故障类型",
            );
          }
          checkedIn.push(toStaffReg(reg));
          continue;
        }
        if (!canCheckInRegistration(reg.status)) {
          throw new AppError(
            "ACTIVITY_REGISTRATION_STATE_INVALID",
            `报名「${reg.name}」当前状态不可签到`,
          );
        }
        const updated = await tx.repairActivityRegistration.update({
          where: { id: registrationId },
          data: {
            status: "CHECKED_IN",
            checkedInAt: now,
            ...(updates.has(registrationId) ? { issueType: updates.get(registrationId) } : {}),
          },
        });
        if (updated.issueType !== reg.issueType) {
          await appendAuditLog(tx, {
            actor,
            actorType: "USER",
            actorUserId: actor.userId,
            action: "repair_activity.registration_issue_type_updated",
            targetType: "RepairActivityRegistration",
            targetId: registrationId,
            result: "SUCCESS",
            before: { issueType: reg.issueType },
            after: { issueType: updated.issueType },
          });
        }
        checkedIn.push(toStaffReg(updated));
      }

      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair_activity.registrations_checked_in",
        targetType: "RepairActivity",
        targetId: activityId,
        result: "SUCCESS",
        after: {
          registrationIds: checkedIn.map((r) => r.id),
          memberProfileId: member.id,
        },
      });
      return { checkedIn };
    });
  },

  async withdraw(
    activityId: string,
    registrationId: string,
    actor: AuthorizedActor,
  ): Promise<StaffRegistrationView> {
    const member = await requireAdminMember(actor);
    await loadActivityOrThrow(activityId);
    await requireAttendance(activityId, member.id);
    if (!registrationId.trim()) {
      throw new AppError("VALIDATION_FAILED", "报名 ID 无效");
    }

    return inSerializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM repair_activities WHERE id = ${activityId} FOR UPDATE`;
      const reg = await tx.repairActivityRegistration.findFirst({
        where: { id: registrationId, activityId, deletedAt: null },
      });
      if (!reg) {
        throw new AppError("ACTIVITY_REGISTRATION_NOT_FOUND", "报名记录不存在");
      }
      if (reg.status === "SERVED") {
        throw new AppError("ACTIVITY_REGISTRATION_STATE_INVALID", "已接待的报名不可撤回");
      }
      if (!canWithdrawRegistration(reg.status)) {
        throw new AppError("ACTIVITY_REGISTRATION_STATE_INVALID", "当前状态不可撤回排队");
      }
      const updated = await tx.repairActivityRegistration.update({
        where: { id: registrationId },
        data: { status: "REGISTERED", checkedInAt: null },
      });
      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair_activity.registration_withdrawn",
        targetType: "RepairActivityRegistration",
        targetId: registrationId,
        result: "SUCCESS",
        before: { status: "CHECKED_IN" },
        after: { status: "REGISTERED", memberProfileId: member.id },
      });
      return toStaffReg(updated);
    });
  },

  /**
   * 撤销接待（issue #166）：把接错客户的已接待报名恢复成接待前的状态，并删掉那次接待
   * 自动创建的**未提交**草稿（连同参与行、时间线与照片文件）。
   *
   * 权限：接待者本人或活动管理员（`activity:admin`）。已提交 / 已审核的记录不能撤销 ——
   * 那属于审核流程，仍走退回与管理员纠正。每一步都写审计。
   */
  async revertServe(
    activityId: string,
    registrationId: string,
    actor: AuthorizedActor,
  ): Promise<RevertServeResultView> {
    const member = await requireStaffMember(actor);
    await loadActivityOrThrow(activityId);
    const isAdmin = actor.permissions.includes("activity:admin");
    const photoKeys: string[] = [];
    const result = await inSerializableTransaction(async (tx) => {
      const reg = await tx.repairActivityRegistration.findFirst({
        where: { id: registrationId, activityId, deletedAt: null },
      });
      if (!reg) throw new AppError("ACTIVITY_REGISTRATION_NOT_FOUND", "报名记录不存在");
      if (reg.status !== "SERVED" || !reg.repairRecordId)
        throw new AppError("ACTIVITY_REGISTRATION_STATE_INVALID", "该报名当前不是已接待状态");
      if (!isAdmin && reg.servedByMemberProfileId !== member.id)
        throw new AppError("FORBIDDEN", "只有接待者本人或活动管理员可以撤销接待");

      const record = await tx.repairRecord.findFirst({
        where: { id: reg.repairRecordId, deletedAt: null },
        select: { id: true, status: true, submittedAt: true },
      });
      // 已撤回审核的草稿（submittedAt 非空）曾进入审核流程，不允许按「撤销接待」整条删除。
      if (!record || record.status !== "DRAFT" || record.submittedAt)
        throw new AppError(
          "ACTIVITY_REGISTRATION_STATE_INVALID",
          "维修记录已提交或不存在，不能撤销接待",
        );

      const photos = await tx.repairPhoto.findMany({
        where: { repairRecordId: record.id },
        select: { storageKey: true },
      });
      // 报名先解除对草稿的外键引用（RESTRICT），再删草稿本身。
      // 接待前的具体状态没有单独留存，用「是否签过到」还原：签过到回排队，否则回待签到。
      const restoredStatus = reg.checkedInAt ? "CHECKED_IN" : "REGISTERED";
      const updated = await tx.repairActivityRegistration.update({
        where: { id: reg.id },
        data: {
          status: restoredStatus,
          servedAt: null,
          servedByMemberProfileId: null,
          repairRecordId: null,
        },
      });

      // 社区与通知子表同样以 RESTRICT 引用记录：作者能读自己的 DRAFT，就可能留下
      // 评论 / 收藏 / 通知（审查 #195），不先清掉删记录会撞外键、把撤销打成 500。
      const commentIds = (
        await tx.repairComment.findMany({
          where: { repairRecordId: record.id },
          select: { id: true },
        })
      ).map((row) => row.id);
      const favoritesDeleted = await tx.repairFavorite.deleteMany({
        where: { repairRecordId: record.id },
      });
      const notificationsDeleted = await tx.notification.deleteMany({
        where: { OR: [{ repairRecordId: record.id }, { commentId: { in: commentIds } }] },
      });
      await tx.commentMention.deleteMany({ where: { commentId: { in: commentIds } } });
      // 评论自引用 RESTRICT：先删回复，再删顶层。
      const repliesDeleted = await tx.repairComment.deleteMany({
        where: { repairRecordId: record.id, parentCommentId: { not: null } },
      });
      const topCommentsDeleted = await tx.repairComment.deleteMany({
        where: { repairRecordId: record.id },
      });
      const commentsDeleted = repliesDeleted.count + topCommentsDeleted.count;

      // 草稿及子表按外键顺序硬删：参与行、照片、时间线都是 RESTRICT。
      await tx.repairRecordParticipant.deleteMany({ where: { repairRecordId: record.id } });
      await tx.repairPhoto.deleteMany({ where: { repairRecordId: record.id } });
      await tx.repairTimelineEvent.deleteMany({ where: { repairRecordId: record.id } });
      await tx.repairRecord.delete({ where: { id: record.id } });

      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair_activity.registration_serve_reverted",
        targetType: "RepairActivityRegistration",
        targetId: reg.id,
        result: "SUCCESS",
        before: { status: "SERVED", repairRecordId: record.id },
        after: {
          status: restoredStatus,
          deletedRecordId: record.id,
          photosDeleted: photos.length,
          commentsDeleted,
          favoritesDeleted: favoritesDeleted.count,
          notificationsDeleted: notificationsDeleted.count,
        },
      });

      photoKeys.push(...photos.map((photo) => photo.storageKey));
      return {
        registration: toStaffReg(updated),
        deletedRecordId: record.id,
        photosDeleted: photos.length,
      };
    });
    // 事务提交后再删磁盘文件：回滚时不会删掉仍被引用的照片。
    await Promise.all(
      photoKeys.map((key) => localRepairPhotoStorage.delete(key).catch(() => undefined)),
    );
    return result;
  },

  async serve(
    activityId: string,
    registrationId: string,
    actor: AuthorizedActor,
  ): Promise<ServeResultView> {
    const member = await requireStaffMember(actor);
    await loadActivityOrThrow(activityId);
    await requireAttendance(activityId, member.id);
    if (!registrationId.trim()) {
      throw new AppError("VALIDATION_FAILED", "报名 ID 无效");
    }

    return inSerializableTransaction(async (tx) => {
      const { activity, now } = await requireStaffOpen(tx, activityId);
      const reg = await tx.repairActivityRegistration.findFirst({
        where: { id: registrationId, activityId, deletedAt: null },
      });
      if (!reg) {
        throw new AppError("ACTIVITY_REGISTRATION_NOT_FOUND", "报名记录不存在");
      }
      if (!canServeRegistration(reg.status)) {
        throw new AppError("ACTIVITY_REGISTRATION_STATE_INVALID", "仅排队中的报名可接待落单");
      }

      // 全局拦截（issue #79 第 6 项）：本成员存在未提交的接待草稿时，任何活动都不能再接单。
      // 客户端已先行拦截（不发请求），这里是并发 / 多标签下的服务端兜底。
      const pending = await tx.repairRecord.findFirst({
        where: pendingServeDraftWhere(member.id),
        select: {
          ownerName: true,
          activityRegistration: { select: { name: true } },
        },
      });
      if (pending) {
        const customer = pending.ownerName ?? pending.activityRegistration?.name ?? "客户";
        throw new AppError(
          "ACTIVITY_SERVE_DRAFT_PENDING",
          `有未完成的接待记录（机主「${customer}」），请先填写并提交后再接待下一位。`,
        );
      }

      // 分类映射失败降级（issue #79 第 6 项）：映射不到 / 已停用时置空，
      // 由成员在表单里补选 —— 接待动作本身必须成功。
      const issueType = assertValidIssueType(reg.issueType);
      const categoryCode = mapIssueTypeToCategoryCode(issueType);
      const category = await tx.repairCategory.findFirst({
        where: { code: categoryCode, deletedAt: null, isActive: true },
        select: { id: true },
      });

      const { repairRecordId } = await createServeDraftForActivity(
        tx,
        {
          memberProfileId: member.id,
          categoryId: category?.id ?? null,
          repairDate: shanghaiCalendarDay(activity.activityAt),
          // 机主姓名 / 电话完整带自报名（可见性收口在视图层，不在这里掩码）。
          ownerName: reg.name,
          ownerPhone: reg.phone,
          // 报名时填的机型随记录带过去（issue #68）；没填就是 null。
          deviceModel: reg.deviceModel,
          createRequestKey: `activity-serve:${registrationId}`,
          registrationId,
          activityId,
        },
        actor,
        now,
      );

      const updated = await tx.repairActivityRegistration.update({
        where: { id: registrationId },
        data: {
          status: "SERVED",
          servedAt: now,
          servedByMemberProfileId: member.id,
          repairRecordId,
        },
      });

      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair_activity.registration_served",
        targetType: "RepairActivityRegistration",
        targetId: registrationId,
        result: "SUCCESS",
        after: {
          status: "SERVED",
          repairRecordId,
          categoryCode,
          memberProfileId: member.id,
        },
      });

      return {
        registration: toStaffReg(updated),
        repairRecordId,
      };
    });
  },
};
