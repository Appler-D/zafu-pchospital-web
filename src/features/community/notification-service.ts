import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { paginationMeta } from "@/lib/api/pagination";
import { AppError } from "@/lib/api/errors";
import { requirePermission } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { repairRepository } from "@/features/repairs/repair-repository";
import { toNotificationView } from "./community-view";
import type {
  AuthorizedActor,
  NotificationListResult,
  NotificationServiceContract,
  NotificationView,
} from "@/types/contracts";
import { MEMBER_DASHBOARD_NOTIFICATION_LIMIT, NotificationType } from "@/types/contracts";

/** 历史评论 / 提及通知保留在库中，所有对外查询与操作共用这份可见范围。 */
const visibleNotificationWhere = { type: { in: [...NotificationType] } };

const notificationInclude = {
  actor: { include: { user: { select: { displayName: true } } } },
  record: {
    select: {
      content: true,
      remark: true,
      status: true,
      deletedAt: true,
      memberProfile: { select: { userId: true } },
    },
  },
} as const;

function notFound(): never {
  throw new AppError("NOTIFICATION_NOT_FOUND", "通知不存在");
}

export const notificationService: NotificationServiceContract = {
  async list(input, actor): Promise<NotificationListResult> {
    requirePermission(actor, "notification:read");
    const self = await repairRepository.activeMemberForUser(actor.userId);
    const where = {
      ...visibleNotificationWhere,
      recipientMemberProfileId: self.id,
      deletedAt: null,
      status: input.status,
    };
    const [total, unreadCount, rows] = await Promise.all([
      getDb().notification.count({ where }),
      getDb().notification.count({
        where: {
          ...visibleNotificationWhere,
          recipientMemberProfileId: self.id,
          deletedAt: null,
          status: "UNREAD",
        },
      }),
      getDb().notification.findMany({
        where,
        include: notificationInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => toNotificationView(row, actor)),
      unreadCount,
      pagination: paginationMeta(input, total),
    };
  },

  async markRead(notificationId, actor): Promise<NotificationView> {
    requirePermission(actor, "notification:read");
    const self = await repairRepository.activeMemberForUser(actor.userId);
    const now = new Date();
    const row = await inSerializableTransaction(async (tx) => {
      const current = await tx.notification.findFirst({
        where: {
          ...visibleNotificationWhere,
          id: notificationId,
          recipientMemberProfileId: self.id,
          deletedAt: null,
        },
      });
      if (!current) notFound();
      if (current.status === "READ") {
        return tx.notification.findUniqueOrThrow({
          where: { id: current.id },
          include: notificationInclude,
        });
      }
      return tx.notification.update({
        where: { id: current.id },
        data: { status: "READ", readAt: now },
        include: notificationInclude,
      });
    });
    return toNotificationView(row, actor);
  },

  async markAllRead(actor) {
    requirePermission(actor, "notification:read");
    const self = await repairRepository.activeMemberForUser(actor.userId);
    const now = new Date();
    const updated = await getDb().notification.updateMany({
      where: {
        ...visibleNotificationWhere,
        recipientMemberProfileId: self.id,
        deletedAt: null,
        status: "UNREAD",
      },
      data: { status: "READ", readAt: now },
    });
    return { updatedCount: updated.count };
  },

  async softDelete(notificationId, actor): Promise<void> {
    requirePermission(actor, "notification:read");
    const self = await repairRepository.activeMemberForUser(actor.userId);
    const now = new Date();
    const updated = await getDb().notification.updateMany({
      where: {
        ...visibleNotificationWhere,
        id: notificationId,
        recipientMemberProfileId: self.id,
        deletedAt: null,
      },
      data: { deletedAt: now },
    });
    if (updated.count !== 1) notFound();
  },
};

export async function summarizeNotifications(memberProfileId: string, actor: AuthorizedActor) {
  const where = {
    ...visibleNotificationWhere,
    recipientMemberProfileId: memberProfileId,
    deletedAt: null,
  };
  const [unreadCount, latest] = await Promise.all([
    getDb().notification.count({ where: { ...where, status: "UNREAD" } }),
    getDb().notification.findMany({
      where,
      include: notificationInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MEMBER_DASHBOARD_NOTIFICATION_LIMIT,
    }),
  ]);
  return { unreadCount, latest: latest.map((row) => toNotificationView(row, actor)) };
}

/** 审核事务内通知全部参与者；去重并跳过审核人本人，兼容无成员档案管理员。 */
export async function createReviewNotification(
  tx: Prisma.TransactionClient,
  input: {
    recordId: string;
    recipientMemberProfileIds: readonly string[];
    actorMemberProfileId: string | null;
    decision: "APPROVED" | "REJECTED";
    now: Date;
  },
): Promise<void> {
  const recipients = [
    ...new Set(input.recipientMemberProfileIds.filter((id) => id !== input.actorMemberProfileId)),
  ];
  if (recipients.length === 0) return;
  await tx.notification.createMany({
    data: recipients.map((recipientMemberProfileId) => ({
      id: randomUUID(),
      recipientMemberProfileId,
      type: input.decision === "APPROVED" ? "REPAIR_APPROVED" : "REPAIR_REJECTED",
      status: "UNREAD",
      repairRecordId: input.recordId,
      actorMemberProfileId: input.actorMemberProfileId,
      createdAt: input.now,
    })),
  });
}
