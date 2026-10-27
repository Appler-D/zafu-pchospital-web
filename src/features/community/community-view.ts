import { canReadRepair } from "@/features/repairs/repair-policy";
import type { AuthorizedActor, FavoriteView, NotificationView } from "@/types/contracts";

type MemberNameSource = {
  id: string;
  nickname: string | null;
  realName: string;
  user?: { displayName: string | null } | null;
};

export function memberRef(row: MemberNameSource): { id: string; name: string } {
  return {
    id: row.id,
    name: row.nickname?.trim() || row.realName?.trim() || row.user?.displayName?.trim() || "成员",
  };
}

/**
 * 摘要取值链：备注优先，老记录的 `content` 回退；
 * 两者皆空时占位「未填写备注」。压平换行、截断到 `limit` 个码点。
 */
export function excerptText(
  record: { remark: string | null | undefined; content: string | null | undefined },
  limit = 60,
): string {
  const flat = (record.remark?.trim() || record.content || "").replace(/\s+/g, " ").trim();
  if (!flat) return "未填写备注";
  const chars = [...flat];
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : flat;
}

type FavoriteRow = {
  id: string;
  createdAt: Date;
  repairRecordId: string;
  record: {
    repairDate: Date | null;
    content: string | null;
    remark: string | null;
    isDifficult: boolean;
    isTypical: boolean;
    category: { name: string } | null;
    memberProfile: MemberNameSource;
  };
};

export function toFavoriteView(row: FavoriteRow): FavoriteView {
  return {
    id: row.id,
    repairRecordId: row.repairRecordId,
    repairDate: row.record.repairDate ? row.record.repairDate.toISOString().slice(0, 10) : null,
    categoryName: row.record.category?.name ?? null,
    contentExcerpt: excerptText(row.record),
    memberName: memberRef(row.record.memberProfile).name,
    isDifficult: row.record.isDifficult,
    isTypical: row.record.isTypical,
    createdAt: row.createdAt.toISOString(),
  };
}

type NotificationRow = {
  id: string;
  type: string;
  status: string;
  repairRecordId: string | null;
  commentId: string | null;
  createdAt: Date;
  readAt: Date | null;
  actor: MemberNameSource | null;
  record: {
    content: string | null;
    remark: string | null;
    status: string;
    deletedAt: Date | null;
    memberProfile: { userId: string };
  } | null;
};

export function toNotificationView(row: NotificationRow, actor: AuthorizedActor): NotificationView {
  const visibleRecord = row.record && canReadRepair(actor, row.record) ? row.record : null;
  return {
    id: row.id,
    type: row.type as NotificationView["type"],
    status: row.status as NotificationView["status"],
    repairRecordId: visibleRecord ? row.repairRecordId : null,
    commentId: null,
    actor: row.actor ? memberRef(row.actor) : null,
    repairExcerpt: visibleRecord ? excerptText(visibleRecord) : null,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}
