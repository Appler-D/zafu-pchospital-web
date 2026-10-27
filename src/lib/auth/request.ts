import { AppError } from "@/lib/api/errors";
import { clientIp } from "@/lib/api/client-ip";
import { getServerEnv } from "@/lib/env";
import { authService } from "@/features/auth/auth-service";
import { resolveAccountAccess } from "@/lib/auth/account-access";
import type {
  AccountAccessView,
  AuthorizedActor,
  PublicRequestContext,
  SessionPrincipal,
} from "@/types/contracts";

export const SESSION_COOKIE_NAME = "pc_hospital_session";

/**
 * 服务端固定的访问用途。
 *
 * 业务 API **缺省**就是 `business`：先改密、再邮箱，两道都拦。安全用途必须由
 * Route 在服务端写死，**不能**由请求里的任何 allow 标志跳过检查 —— 旧的布尔
 * 第三参数只放行「强制改密」，`/me` 是唯一使用者；这里把它收敛成显式用途，
 * 避免把一个 `true` 无意间扩散成「同时绕过改密与邮箱」。
 */
export type RequestAccessPurpose = "business" | "session-self" | "email-self" | "account-recovery";

/** 每种用途放行哪一类受限状态（任务书 §4 表的代码形态）。 */
const ACCESS_RULES: Record<
  RequestAccessPurpose,
  { allowForcedPasswordChange: boolean; allowEmailPending: boolean }
> = {
  // 普通成员 / 管理业务 API：两类受限都拒绝。
  business: { allowForcedPasswordChange: false, allowEmailPending: false },
  // `/me`：受限会话仍是有效会话，只报告状态，不拒绝（否则前端无法据此引导）。
  "session-self": { allowForcedPasswordChange: true, allowEmailPending: true },
  // 本人邮箱页 / 状态 / 发码 / 确认：豁免邮箱门禁，但仍要求先改密。
  "email-self": { allowForcedPasswordChange: false, allowEmailPending: true },
  // 本节限定的管理员恢复工具：同样只豁免邮箱门禁，权限 / SELF / 资格 / 审计照旧。
  "account-recovery": { allowForcedPasswordChange: false, allowEmailPending: true },
};

export function requestContext(request: Request, requestId: string): PublicRequestContext {
  return {
    requestId,
    ipAddress: clientIp(request),
    userAgent: request.headers.get("user-agent") ?? undefined,
  };
}

export function readSessionToken(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  return (
    cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(SESSION_COOKIE_NAME.length + 1) ?? ""
  );
}

/**
 * 业务 API 的统一认证入口：基础 Session / 账号资格之后，按**当次**服务端状态
 * 执行门禁（角色、邮箱、豁免都不取登录快照），再交给调用方做权限校验。
 *
 * `purpose` 只能由 Route 在服务端写死；判定规则与页面守卫同源于
 * `src/lib/auth/account-access.ts`，模式为 `off` 时不读邮箱表、行为与既有一致。
 *
 * `returnToCandidate` 只给 `session-self` 用（`/api/v1/me` 被客户端跟随器请求时，
 * 需要知道「用户此刻站在哪儿」才能在受限状态下给出**带链条**的落点）。它是纯候选：
 * 是否放行与最终去哪儿仍由 `resolveAccountAccess` 按白名单 + 当前角色判定；
 * 其它用途一律不读它，候选也永远不构成绕过标志。
 */
export async function authenticateRequest(
  request: Request,
  requestId: string,
  purpose: RequestAccessPurpose = "business",
  returnToCandidate?: string | null,
): Promise<{
  principal: SessionPrincipal & { sessionId: string; expiresAt: string; rememberMe: boolean };
  actor: AuthorizedActor;
  token: string;
  accountAccess: AccountAccessView;
}> {
  const context = requestContext(request, requestId);
  const token = readSessionToken(request);
  if (!token) throw new AppError("UNAUTHENTICATED", "请先登录");
  const principal = await authService.authenticate(token);
  const accountAccess = await resolveAccountAccess({
    principal,
    returnTo: purpose === "session-self" ? returnToCandidate : undefined,
  });
  const rules = ACCESS_RULES[purpose];
  if (accountAccess.state === "PASSWORD_CHANGE_REQUIRED" && !rules.allowForcedPasswordChange)
    throw new AppError("PASSWORD_CHANGE_REQUIRED", "请先修改初始密码");
  if (accountAccess.state === "EMAIL_VERIFICATION_REQUIRED" && !rules.allowEmailPending)
    throw new AppError("EMAIL_VERIFICATION_REQUIRED", "请先完成邮箱验证");
  return {
    principal,
    token,
    accountAccess,
    actor: {
      ...context,
      actorType: "USER",
      userId: principal.userId,
      userStatus: "ACTIVE",
      permissions: principal.permissions,
      mustChangePassword: principal.mustChangePassword,
    },
  };
}

/** 允许的请求来源：APP_BASE_URL（生产是站点正式域名）及其 www 变体。 */
function allowedOrigins(): Set<string> {
  let base: URL;
  try {
    base = new URL(getServerEnv().APP_BASE_URL);
  } catch {
    throw new AppError("INTERNAL_ERROR", "APP_BASE_URL 配置无效", { status: 500 });
  }
  const host = base.hostname.toLowerCase();
  const alternate = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  const port = base.port ? `:${base.port}` : "";
  return new Set([`${base.protocol}//${host}${port}`, `${base.protocol}//${alternate}${port}`]);
}

/**
 * 写接口的 CSRF 防线：Origin 必须落在允许来源白名单内。
 *
 * 不要拿 Origin 去比请求自身的 Host / X-Forwarded-Host —— 那两个值由请求方控制，
 * 伪造 `Host: evil.com` + `Origin: https://evil.com` 就能通过（2026-09 安全审计 F4 实测），
 * DNS rebinding 下可直接打穿全部写接口。
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new AppError("FORBIDDEN", "请求来源无效");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AppError("FORBIDDEN", "请求来源无效");
  }
  const candidate = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${
    parsed.port ? `:${parsed.port}` : ""
  }`;
  if (!allowedOrigins().has(candidate)) throw new AppError("FORBIDDEN", "请求来源无效");
}

export function sessionCookie(token: string, expiresAt: string) {
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(expiresAt),
  };
}
