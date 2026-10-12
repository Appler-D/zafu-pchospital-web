import { canReadRepair } from "@/features/repairs/repair-policy";
import type {
  AuthorizedActor,
  FavoriteView,
  NotificationView,
  RepairCommentView,
} from "@/types/contracts";

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
 * 摘要取值链（issue #79 第 6 项）：备注优先，老记录的 `content` 回退；
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

type CommentRow = {
  id: string;
  body: string;
  parentCommentId: string | null;
  createdAt: Date;
  authorMemberProfileId: string;
  author: MemberNameSource;
  mentions: Array<{ mentioned: MemberNameSource }>;
};

/**
 * `selfMemberProfileId` 允许为 `null`：管理员可能没有成员档案（纯管理员账号），
 * 此时「是不是我写的」恒为假，`canDelete` 退化为按权限判断。
 */
export function toCommentView(
  row: CommentRow,
  actor: AuthorizedActor,
  selfMemberProfileId: string | null,
): RepairCommentView {
  const author = memberRef(row.author);
  return {
    id: row.id,
    body: row.body,
    author,
    parentCommentId: row.parentCommentId,
    mentions: row.mentions.map((entry) => memberRef(entry.mentioned)),
    createdAt: row.createdAt.toISOString(),
    canDelete:
      (selfMemberProfileId !== null && row.authorMemberProfileId === selfMemberProfileId) ||
      actor.permissions.includes("comment:delete"),
    replies: [],
  };
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
    commentId: visibleRecord ? row.commentId : null,
    actor: row.actor ? memberRef(row.actor) : null,
    repairExcerpt: visibleRecord ? excerptText(visibleRecord) : null,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}
