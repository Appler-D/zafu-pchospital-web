import type { AccountMeView } from "@/types/contracts";

const SESSION_FRESH_MS = 15_000;
const CHANGE_KEY = "pc-hospital.session-change";
const CHANNEL_NAME = "pc-hospital.session";

type SessionEvent = { type: "invalidate"; recheck: boolean } | { type: "change" };
type SessionCheck =
  { ok: true; data: AccountMeView; scope: string } | { ok: false; status: number; stale?: boolean };

let revision = 0;
let identity: string | undefined;
let stamp: string | null | undefined;
let snapshot: { result: Extract<SessionCheck, { ok: true }>; until: number } | undefined;
let pending: { revision: number; candidate: string; promise: Promise<SessionCheck> } | undefined;
const listeners = new Set<(event: SessionEvent) => void>();

function emit(event: SessionEvent) {
  for (const listener of listeners) listener(event);
}

/** 只作客户端结果隔离；任何业务授权仍由服务端 Session 和权限检查决定。 */
export function invalidateClientSession(recheck = false): void {
  revision++;
  snapshot = undefined;
  pending = undefined;
  emit({ type: "invalidate", recheck });
}

/** 前台恢复只作废新鲜度；确认身份变化后再隔离在途业务结果。 */
export function refreshClientSession(): void {
  snapshot = undefined;
  emit({ type: "invalidate", recheck: true });
}

function syncStamp() {
  if (typeof window === "undefined") return;
  try {
    const current = window.localStorage.getItem(CHANGE_KEY);
    if (stamp !== undefined && current !== stamp) {
      stamp = current;
      invalidateClientSession(true);
    } else stamp = current;
  } catch {
    // 存储不可用时由 BroadcastChannel、前台复查和短期有效期兜底。
  }
}

export function clientSessionRevision(): number {
  syncStamp();
  return revision;
}

export function onClientSessionEvent(listener: (event: SessionEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 监听跨标签页变更；消息和 storage 都只携带随机失效标记，不存放身份或业务数据。 */
export function watchClientSession(listener: (event: SessionEvent) => void): () => void {
  syncStamp();
  const unsubscribe = onClientSessionEvent(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === CHANGE_KEY || event.key === null) syncStamp();
  };
  window.addEventListener("storage", onStorage);
  let channel: BroadcastChannel | undefined;
  try {
    if (window.BroadcastChannel) {
      channel = new window.BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "string" || event.data === stamp) return;
        stamp = event.data;
        invalidateClientSession(true);
      };
    }
  } catch {
    // 不支持或禁用消息通道时保留 storage 和前台复查。
  }
  return () => {
    unsubscribe();
    window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}

function publishChange() {
  identity = undefined;
  stamp = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CHANGE_KEY, stamp);
    } catch {
      // 不要求用户启用本地存储。
    }
    try {
      if (window.BroadcastChannel) {
        const channel = new window.BroadcastChannel(CHANNEL_NAME);
        channel.postMessage(stamp);
        channel.close();
      }
    } catch {
      // 消息不可用不影响会话请求。
    }
  }
  invalidateClientSession();
}

/** 登录、退出及会话轮换前后均失效；网络失败也可能已经收到 Set-Cookie。 */
export async function sessionMutationFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  publishChange();
  try {
    return await fetch(input, { ...init, cache: "no-store" });
  } finally {
    publishChange();
  }
}

export function clientSessionCandidate(): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  return (
    url.searchParams.get("returnTo") ??
    (/^\/(member|admin)(\/|$)/.test(url.pathname) ? url.pathname : "")
  );
}

function sessionScope(data: AccountMeView): string | undefined {
  if (
    !data ||
    typeof data.userId !== "string" ||
    !data.userId ||
    typeof data.sessionId !== "string" ||
    !data.sessionId ||
    !Array.isArray(data.roles) ||
    !Array.isArray(data.permissions) ||
    !data.accountAccess ||
    !["READY", "PASSWORD_CHANGE_REQUIRED", "EMAIL_VERIFICATION_REQUIRED"].includes(
      data.accountAccess.state,
    ) ||
    typeof data.accountAccess.destination !== "string" ||
    !data.accountAccess.destination.startsWith("/") ||
    data.accountAccess.destination.startsWith("//") ||
    !Number.isFinite(Date.parse(data.expiresAt))
  )
    return undefined;
  return JSON.stringify([
    data.userId,
    data.sessionId,
    [...data.roles].sort(),
    [...data.permissions].sort(),
    data.memberProfileId,
    data.memberStatus,
    data.mustChangePassword,
    data.accountAccess.state,
  ]);
}

/** 主动复查不缓存失败；同一代次、同一回跳候选的并发复查共用请求。 */
export function checkClientSession(candidate = clientSessionCandidate()): Promise<SessionCheck> {
  const requestRevision = clientSessionRevision();
  if (pending?.revision === requestRevision && pending.candidate === candidate)
    return pending.promise;
  const startedAt = Date.now();
  const promise = Promise.resolve().then(async (): Promise<SessionCheck> => {
    try {
      const response = await fetch(
        `/api/v1/me${candidate ? `?returnTo=${encodeURIComponent(candidate)}` : ""}`,
        { cache: "no-store", signal: AbortSignal.timeout(5_000) },
      );
      if (clientSessionRevision() !== requestRevision) return { ok: false, status: 0, stale: true };
      if (response.status === 401) {
        invalidateClientSession();
        return { ok: false, status: 401 };
      }
      const json = (await response.json()) as { success?: boolean; data?: AccountMeView };
      if (clientSessionRevision() !== requestRevision) return { ok: false, status: 0, stale: true };
      if (!response.ok || !json?.success || !json.data) {
        snapshot = undefined;
        return { ok: false, status: response.status };
      }
      const scope = sessionScope(json.data);
      if (!scope) {
        snapshot = undefined;
        return { ok: false, status: 0 };
      }
      const now = Date.now();
      const expiresAt = Date.parse(json.data.expiresAt);
      if (expiresAt <= now) {
        invalidateClientSession();
        return { ok: false, status: 401 };
      }
      const gateDeadline = Date.parse(json.data.accountAccess.exemptionExpiresAt ?? "");
      if (gateDeadline > startedAt && gateDeadline <= now) {
        snapshot = undefined;
        return { ok: false, status: 0 };
      }
      const changed = identity !== undefined && identity !== scope;
      if (changed) invalidateClientSession();
      identity = scope;
      const result = { ok: true as const, data: json.data, scope };
      snapshot = {
        result,
        until: Math.min(
          startedAt + SESSION_FRESH_MS,
          expiresAt,
          gateDeadline > now ? gateDeadline : Infinity,
        ),
      };
      if (changed) emit({ type: "change" });
      return result;
    } catch {
      if (clientSessionRevision() !== requestRevision) return { ok: false, status: 0, stale: true };
      snapshot = undefined;
      return { ok: false, status: 0 };
    } finally {
      if (pending?.promise === promise) pending = undefined;
    }
  });
  pending = { revision: requestRevision, candidate, promise };
  return promise;
}

/** 后台缓存命中前复用最近的会话确认；仅有业务访问时才按需复查，不增加后台轮询。 */
export async function getClientSession(signal?: AbortSignal): Promise<SessionCheck> {
  clientSessionRevision();
  if (signal?.aborted) return { ok: false, status: 0, stale: true };
  if (snapshot && Date.now() < snapshot.until) return snapshot.result;
  const task = checkClientSession();
  if (!signal) return task;
  let onAbort: () => void;
  const aborted = new Promise<SessionCheck>((resolve) => {
    onAbort = () => resolve({ ok: false, status: 0, stale: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([task, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}
