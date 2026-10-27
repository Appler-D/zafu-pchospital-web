import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { authService } from "@/features/auth/auth-service";
import { accountReturnCandidate, resolveAccountAccess } from "@/lib/auth/account-access";
import { isAccountStepPage } from "@/lib/auth/account-steps";
import { INTERNAL_PATHNAME_HEADER } from "@/lib/auth/internal-pathname";
import { SESSION_COOKIE_NAME } from "@/lib/auth/request";
import type { AccountAccessView, SessionPrincipal } from "@/types/contracts";

/**
 * 页面侧的门禁执行点。
 *
 * 与业务 API 的 `authenticateRequest` 共用 `resolveAccountAccess` 同一份判定：
 * 有效 Session / 账号资格 → 必须改密 → 当前模式需要邮箱且无有效豁免
 * → 原目标或角色默认页。每次**页面 / RSC 请求**都重新按数据库判定，不读登录快照，
 * 也不接受任何来自前端的「已豁免」标志。
 *
 * 关于当前路径：只有 `middleware.ts` 用 `NextRequest.nextUrl` 无条件覆写的
 * `x-internal-pathname` 才是服务端可见的路径（客户端伪造的同名 Header 会被覆盖）。
 * 它**只**用作候选回跳目标 —— 先按形状白名单（{@link accountReturnCandidate}）过滤，
 * 再由 `safeAccountReturnPath` 按当前角色复查，最坏情况是在站内选一个该账号本来
 * 就能访问的落点，不构成开放重定向；**是否重定向、去哪一步**只看数据库里的
 * 角色 / 改密 / 邮箱 / 豁免状态，绝不参考这个 Header。
 * 中间件缺失时读到 `null`，落点退化为角色默认页，行为仍然安全。
 */
export type PageAccessOptions = {
  /** 调用方**自己就是**步骤页时传入其固定路径（编译期常量，不接受请求值）。 */
  selfPath?: string;
  /** 步骤页由调用方显式提供已校验的回跳目标，业务页缺省读当前路径。 */
  returnTo?: string | null;
};

/** 当前请求的**候选**回跳目标：只按形状过滤，此刻还没有角色可查。 */
export async function pageReturnCandidate(): Promise<string | null> {
  return accountReturnCandidate((await headers()).get(INTERNAL_PATHNAME_HEADER));
}

/**
 * 页面守卫共用的第一步：有效 Session / 账号资格。
 *
 * 拿不到会话时去登录页，并**带上当前业务页作为候选原目标**：
 * 不带的话 `/login` 的 `returnTo` 无值可用，登录接口再怎么校验也接不出原目标，
 * 「先撞登录页再回原处」这条链就断了。此处只可能带形状合法的业务 pathname。
 */
export async function requirePagePrincipal(): Promise<SessionPrincipal> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? "";
  try {
    return await authService.authenticate(token);
  } catch {
    const candidate = await pageReturnCandidate();
    redirect(
      candidate
        ? `/login?reason=expired&returnTo=${encodeURIComponent(candidate)}`
        : "/login?reason=expired",
    );
  }
}

export async function enforcePageAccountAccess(
  principal: SessionPrincipal,
  options: PageAccessOptions = {},
): Promise<AccountAccessView> {
  const access = await resolveAccountAccess({
    principal,
    returnTo: options.returnTo ?? (options.selfPath ? null : await pageReturnCandidate()),
  });
  // 允许停留的步骤页由 `isAccountStepPage` 决定（含「仅邮箱受限仍可停在改密页」）。
  if (access.state !== "READY" && !isAccountStepPage(access.state, options.selfPath ?? null))
    redirect(access.destination);
  return access;
}
