/**
 * 新建维修的本地暂存。
 *
 * 只放**非图片**表单字段，存 `sessionStorage`：不随请求发送、不进 nginx / 代理日志，
 * 随标签页关闭清除。刷新、站内跳走都还能恢复；12 小时内的暂存才认，避免隔天填一半的
 * 旧内容突然回来。手机号等 PII 不写 cookie、不写 localStorage。
 */
export type CreateDraftSnapshot = {
  repairDate: string | null;
  durationMinutes: number | null;
  categoryId: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  /** 机型：新建页未建档时的本地暂存也要带上，否则刷新会丢。 */
  deviceModel: string | null;
  remark: string | null;
  participantIds: string[];
};

const STORAGE_KEY = "pc:repair-create-draft:v1";
const TTL_MS = 12 * 60 * 60 * 1000;

/** 接待补单按报名 id 分桶暂存，不会和普通新建流程互相覆盖。 */
function storageKey(scope?: string): string {
  return scope ? `${STORAGE_KEY}:${scope}` : STORAGE_KEY;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function readCreateDraft(scope?: string): CreateDraftSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; fields?: Record<string, unknown> };
    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > TTL_MS) {
      clearCreateDraft(scope);
      return null;
    }
    const fields = parsed.fields ?? {};
    return {
      repairDate: text(fields.repairDate),
      durationMinutes: typeof fields.durationMinutes === "number" ? fields.durationMinutes : null,
      categoryId: text(fields.categoryId),
      ownerName: text(fields.ownerName),
      ownerPhone: text(fields.ownerPhone),
      deviceModel: text(fields.deviceModel),
      remark: text(fields.remark),
      participantIds: Array.isArray(fields.participantIds)
        ? fields.participantIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export function writeCreateDraft(fields: CreateDraftSnapshot, scope?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      storageKey(scope),
      JSON.stringify({ savedAt: Date.now(), fields }),
    );
  } catch {
    // 隐私模式 / 存储被禁用：暂存失败不影响填写与提交。
  }
}

export function clearCreateDraft(scope?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(storageKey(scope));
  } catch {
    // 同上：清理失败不影响主流程。
  }
}

/**
 * 活动接待补单的初始快照：只要存在本机暂存就**整体采用**——
 * 暂存是完整表单快照，包含用户显式清空的 null；不能再用 `stored.x ?? prefill.x`，
 * 否则清空分类等字段后，暂存返回再进入会被预填重新填上。
 */
export function mergeServePrefill(
  stored: CreateDraftSnapshot | null,
  prefill: {
    name: string;
    phone: string;
    deviceModel: string | null;
    categoryId: string | null;
    repairDate: string;
  },
): CreateDraftSnapshot {
  if (stored) return stored;
  return {
    repairDate: prefill.repairDate,
    durationMinutes: null,
    categoryId: prefill.categoryId,
    ownerName: prefill.name,
    ownerPhone: prefill.phone,
    deviceModel: prefill.deviceModel,
    remark: null,
    participantIds: [],
  };
}

/** 只有「用户真的填过」才算有内容；维修日期默认今天，不计入。 */
export function hasCreateDraftContent(fields: CreateDraftSnapshot): boolean {
  return Boolean(
    fields.durationMinutes !== null ||
    fields.categoryId ||
    fields.ownerName ||
    fields.ownerPhone ||
    fields.remark ||
    fields.participantIds.length > 0,
  );
}
