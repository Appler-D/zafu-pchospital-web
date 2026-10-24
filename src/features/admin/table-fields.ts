import type { FilterableFields } from "@/lib/api/list-filter";

export const TABLE_GROUPS = {
  members: ["status", "department"],
  repairs: ["status", "result"],
  "join-applications": ["status", "provisionStatus"],
  "invite-codes": ["status"],
  audit: ["result", "actorType"],
} as const;

// 客户端与 HTTP 共用；Prisma 映射留在各领域 Service。
export const JOIN_SORTABLE = [
  "ticketNo",
  "realName",
  "recruitmentCycle",
  "status",
  "provisionStatus",
  "submittedAt",
  "lastReviewedAt",
  "approvedAt",
] as const;
export const JOIN_FILTERABLE: FilterableFields = {
  ticketNo: ["contains"],
  realName: ["contains"],
  recruitmentCycle: ["contains"],
  status: ["eq", "neq"],
  provisionStatus: ["eq", "neq"],
  submittedAt: ["gte", "lte"],
  lastReviewedAt: ["gte", "lte"],
  approvedAt: ["gte", "lte"],
};
export const INVITE_SORTABLE = [
  "displayPrefix",
  "activeFrom",
  "expiresAt",
  "maxUses",
  "usedCount",
  "createdAt",
] as const;
export const INVITE_FILTERABLE: FilterableFields = {
  status: ["eq", "neq"],
  displayPrefix: ["contains"],
  activeFrom: ["gte", "lte"],
  expiresAt: ["gte", "lte"],
  maxUses: ["gte", "lte"],
  usedCount: ["gte", "lte"],
  createdAt: ["gte", "lte"],
};
export const AUDIT_SORTABLE = [
  "createdAt",
  "action",
  "actorType",
  "targetType",
  "targetId",
  "result",
  "requestId",
  "errorCode",
] as const;
export const AUDIT_FILTERABLE: FilterableFields = {
  actorUserId: ["eq"],
  createdAt: ["gte", "lte"],
  action: ["contains"],
  actorType: ["eq", "neq"],
  targetType: ["contains"],
  targetId: ["contains"],
  requestId: ["contains"],
  result: ["eq", "neq"],
  errorCode: ["contains"],
};
export const REPAIR_FILTERABLE: FilterableFields = {
  isDifficult: ["eq", "neq"],
  isTypical: ["eq", "neq"],
  repairDate: ["gte", "lte"],
  durationMinutes: ["gte", "lte"],
  status: ["eq", "neq"],
  result: ["eq", "neq"],
  deviceModel: ["contains"],
  memberName: ["contains"],
  categoryName: ["contains"],
  createdAt: ["gte", "lte"],
};
