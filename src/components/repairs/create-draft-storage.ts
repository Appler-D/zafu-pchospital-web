/**
 * 新建维修的本地暂存（issue #162）。
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
  remark: string | null;
  participantIds: string[];
};

const STORAGE_KEY = "pc:repair-create-draft:v1";
const TTL_MS = 12 * 60 * 60 * 1000;

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function readCreateDraft(): CreateDraftSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; fields?: Record<string, unknown> };
    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > TTL_MS) {
      clearCreateDraft();
      return null;
    }
    const fields = parsed.fields ?? {};
    return {
      repairDate: text(fields.repairDate),
      durationMinutes: typeof fields.durationMinutes === "number" ? fields.durationMinutes : null,
      categoryId: text(fields.categoryId),
      ownerName: text(fields.ownerName),
      ownerPhone: text(fields.ownerPhone),
      remark: text(fields.remark),
      participantIds: Array.isArray(fields.participantIds)
        ? fields.participantIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export function writeCreateDraft(fields: CreateDraftSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), fields }));
  } catch {
    // 隐私模式 / 存储被禁用：暂存失败不影响填写与提交。
  }
}

export function clearCreateDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上：清理失败不影响主流程。
  }
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
