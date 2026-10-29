import type { FieldErrors } from "@/lib/api/errors";
import type { PaginationMeta } from "@/types/contracts";
import type { TableGroupSummary } from "@/types/table";
import { authRequestCopy } from "@/config/auth";
import {
  clientSessionRevision,
  getClientSession,
  invalidateClientSession,
  onClientSessionEvent,
} from "@/lib/auth/client-session";
import { AdminGetCache } from "./admin-get-cache";

/** 后台和账号恢复工具的 API 信封、会话隔离与结构化错误结果。 */
export type AdminApiResult<T> =
  | { ok: true; data: T; pagination?: PaginationMeta; summary?: TableGroupSummary }
  | {
      ok: false;
      code: string;
      message: string;
      fieldErrors?: FieldErrors;
      status: number;
    };

/**
 * 仅在已确认的就绪管理员会话内复用 GET，最多 100 项、15 秒。
 * 写操作和身份失效都会清空；缓存代次管数据回填，会话代次另外隔离迟到结果。
 */
const getCache = new AdminGetCache<AdminApiResult<unknown>>();
let cacheVersion = 0;
let activeWrites = 0;

onClientSessionEvent(() => clearAdminCache());

/** 预热：鼠标悬停在「详情」之类按钮上时先把数据取回来，点下去就不用等。 */
export function prefetchAdmin(path: string): void {
  void adminFetch(path);
}

/** 手动失效（测试或已知数据变化的场景用；正常写路径会自动清空）。 */
export function clearAdminCache(): void {
  cacheVersion++;
  getCache.clear();
}

export async function adminFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<AdminApiResult<T>> {
  const method = (init.method ?? "GET").toUpperCase();
  const isRead = method === "GET";
  const sessionRevision = clientSessionRevision();
  const cancelled = (): AdminApiResult<T> | undefined => {
    if (init.signal?.aborted)
      return { ok: false, code: "REQUEST_ABORTED", message: authRequestCopy.aborted, status: 0 };
    if (clientSessionRevision() !== sessionRevision)
      return {
        ok: false,
        code: "CLIENT_SESSION_CHANGED",
        message: authRequestCopy.sessionChanged,
        status: 0,
      };
  };
  const alreadyCancelled = cancelled();
  if (alreadyCancelled) return alreadyCancelled;
  const session = await getClientSession(init.signal);
  const sessionCancelled = cancelled();
  if (sessionCancelled) return sessionCancelled;
  if (!session.ok && session.stale)
    return {
      ok: false,
      code: "CLIENT_SESSION_CHANGED",
      message: authRequestCopy.sessionChanged,
      status: 0,
    };
  if (!session.ok && session.status === 401)
    return {
      ok: false,
      code: "UNAUTHENTICATED",
      message: sessionMessage("UNAUTHENTICATED"),
      status: 401,
    };
  // 写操作不能在身份未知时沿用旧页面选择；读操作仍可由服务端实时授权返回。
  if (!session.ok && !isRead)
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: authRequestCopy.networkError,
      status: 0,
    };
  // 无法确认身份时走真实业务请求，不复用或写入任何身份的缓存。
  const cacheKey =
    session.ok &&
    session.data.accountAccess.state === "READY" &&
    session.data.roles.includes("ADMIN")
      ? `${session.scope}\0${path}`
      : undefined;
  if (isRead && cacheKey && activeWrites === 0) {
    const hit = getCache.get(cacheKey);
    if (hit) return hit as AdminApiResult<T>;
  }
  if (!isRead) {
    activeWrites++;
    clearAdminCache();
  }
  const requestCacheVersion = cacheVersion;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: "no-store",
      signal: init.signal,
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return (
      cancelled() ?? {
        ok: false,
        code: "NETWORK_ERROR",
        message: authRequestCopy.networkError,
        status: 0,
      }
    );
  } finally {
    if (!isRead) {
      activeWrites--;
      clearAdminCache();
    }
  }

  const responseCancelled = cancelled();
  if (responseCancelled) return responseCancelled;
  if (response.status === 401 || response.status === 403) invalidateClientSession(true);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return (
      cancelled() ?? {
        ok: false,
        code: "INVALID_RESPONSE",
        message: "服务返回了无法解析的响应",
        status: response.status,
      }
    );
  }

  const bodyCancelled = cancelled();
  if (bodyCancelled && response.status !== 401 && response.status !== 403) return bodyCancelled;

  const envelope = json as {
    success?: boolean;
    data?: T;
    error?: { code?: string; message?: string; fieldErrors?: FieldErrors };
    meta?: { pagination?: PaginationMeta; summary?: TableGroupSummary };
  };

  if (response.ok && envelope?.success === true) {
    const ok: AdminApiResult<T> = {
      ok: true,
      data: envelope.data as T,
      pagination: envelope.meta?.pagination,
      ...(envelope.meta?.summary ? { summary: envelope.meta.summary } : {}),
    };
    // 删除等写操作之前开始的 GET 可能迟到，不能把已失效的分页重新写回缓存。
    if (isRead && cacheKey && activeWrites === 0 && requestCacheVersion === cacheVersion) {
      getCache.set(cacheKey, ok);
    }
    return ok;
  }
  const code = envelope?.error?.code ?? "UNKNOWN_ERROR";
  return {
    ok: false,
    code,
    message: sessionMessage(code, envelope?.error?.message),
    fieldErrors: envelope?.error?.fieldErrors,
    status: response.status,
  };
}

/** 会话/权限类错误统一成对管理员可操作的文案；其余沿用服务端文案。 */
function sessionMessage(code: string, fallback?: string): string {
  if (
    code === "UNAUTHENTICATED" ||
    code === "AUTH_SESSION_INVALID" ||
    code === "AUTH_SESSION_EXPIRED"
  )
    return "登录状态已失效，请重新登录后再操作。";
  if (code === "PASSWORD_CHANGE_REQUIRED") return "请先修改初始密码，再使用管理后台。";
  if (code === "FORBIDDEN") return "当前账号没有执行该操作的权限。";
  return fallback ?? "操作失败，请稍后重试";
}

/** 把服务端的 `fieldErrors` 摊平成一行可展示文案（取首个字段的第一条）。 */
export function firstFieldError(fieldErrors: FieldErrors | undefined): string | undefined {
  if (!fieldErrors) return undefined;
  for (const messages of Object.values(fieldErrors)) {
    if (messages && messages.length > 0) return messages[0];
  }
  return undefined;
}
