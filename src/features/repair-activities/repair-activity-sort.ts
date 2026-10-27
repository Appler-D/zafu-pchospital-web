import type { RepairActivityStatus } from "@/features/repair-activities/repair-activity-validation";

/** 公开列表排序所需最小字段（status 须已派生）。 */
export type PublicListSortable = {
  id: string;
  status: RepairActivityStatus;
  activityAt: string | Date;
  createdAt?: string | Date;
};

function toTime(value: string | Date): number {
  return typeof value === "string" ? new Date(value).getTime() : value.getTime();
}

function tieBreak(a: PublicListSortable, b: PublicListSortable): number {
  const ac = a.createdAt ? toTime(a.createdAt) : 0;
  const bc = b.createdAt ? toTime(b.createdAt) : 0;
  if (ac !== bc) return ac - bc;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 公开活动按状态优先级与时间排序。 */
export function sortRepairActivitiesForPublicList<T extends PublicListSortable>(
  items: readonly T[],
): T[] {
  const active: T[] = [];
  const ended: T[] = [];
  for (const item of items) {
    (item.status === "ENDED" ? ended : active).push(item);
  }
  active.sort((a, b) => {
    const d = toTime(a.activityAt) - toTime(b.activityAt);
    return d !== 0 ? d : tieBreak(a, b);
  });
  ended.sort((a, b) => {
    const d = toTime(b.activityAt) - toTime(a.activityAt);
    return d !== 0 ? d : tieBreak(a, b);
  });
  return [...active, ...ended];
}

/**
 * 首页预览的状态优先级：数字小者在前。
 *
 * 「还报得上名的」最该被看见 —— 只按 activityAt 升序时，报名已截止（CLOSED）
 * 或已满（FULL）的活动会挤掉报名开放中（OPEN）的卡片。
 */
const HOME_PREVIEW_STATUS_PRIORITY: Record<RepairActivityStatus, number> = {
  OPEN: 0,
  UPCOMING: 1,
  FULL: 2,
  CLOSED: 3,
  ENDED: 4,
};

/** 首页活动预览只选仍可报名的活动。 */
export function pickNonEndedRepairActivitiesForHomePreview<T extends PublicListSortable>(
  items: readonly T[],
  limit = 3,
): T[] {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3;
  return items
    .filter((item) => item.status !== "ENDED")
    .sort((a, b) => {
      const byStatus =
        HOME_PREVIEW_STATUS_PRIORITY[a.status] - HOME_PREVIEW_STATUS_PRIORITY[b.status];
      if (byStatus !== 0) return byStatus;
      const byActivityAt = toTime(a.activityAt) - toTime(b.activityAt);
      return byActivityAt !== 0 ? byActivityAt : tieBreak(a, b);
    })
    .slice(0, n);
}
