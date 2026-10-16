import "server-only";

import { redirect } from "next/navigation";

import { safeAccountReturnPath } from "@/lib/auth/account-access";
import { EMAIL_STEP_PATH } from "@/lib/auth/account-steps";
import { enforcePageAccountAccess, requirePagePrincipal } from "@/lib/auth/page-access";

/**
 * 成员页面（`/member/**`）的统一入口守卫。
 *
 * 只做两件与「身份认证」直接相关的事：未登录 → `/login`；
 * 其余按**当次**服务端状态走统一门禁（强制改密 → 邮箱验证 / 豁免 → 原目标或角色默认页），
 * 判定与业务 API 同源，见 `src/lib/auth/page-access.ts`。
 *
 * ⚠️ **不要在守卫里再重定向「已登录但没有有效成员档案」的用户**。
 * 曾写成 `redirect("/member")`，而 `/member` 自身也调用本守卫，
 * 于是这类用户会在 `/member` 上无限重定向（重定向自环）。
 * 该情形由 `/member` 页面自行渲染明确的「尚未开通成员身份」空态，
 * 其余 `/member/repairs/**` 页面用下面的 `requireActiveMemberPage()`。
 */
export async function requireMemberPage() {
  const principal = await requirePagePrincipal();
  await enforcePageAccountAccess(principal);
  return principal;
}

/**
 * 在 `requireMemberPage()` 之上再要求「有效成员档案」。
 *
 * 用于必须拥有成员身份才能操作的页面（`/member/repairs/**`）。
 * 此时重定向到改密页会让用户莫名改密，而重定向到 `/member` 又可能自环 ——
 * 因此统一回到 `/login` 并让用户重新登录；这不是死循环（`/login` 不调用本守卫）。
 */
export async function requireActiveMemberPage() {
  const principal = await requireMemberPage();
  if (!principal.memberProfileId || principal.memberStatus !== "ACTIVE") {
    redirect("/login");
  }
  return principal;
}

/**
 * 邮箱步骤页（`/account/email`）专用的守卫。
 *
 * 步骤页只豁免**邮箱**这一道：仍需先完成强制改密（`enforcePageAccountAccess`
 * 会把改密目标连同已校验的 `returnTo` 一并带上，链条不断）。调用方把查询串里的
 * `returnTo` 原样交进来，由服务端白名单 + 当前角色校验，界面只拿到校验后的值。
 *
 * `continueTo` 是服务端授予的「继续原目标」：邮箱已验证或豁免仍有效时给出
 * 落点（原目标或角色默认页），否则为 `null`（界面只能置灰，不能自行拼路径）。
 */
export async function requireEmailStepPage(returnTo: string | null | undefined) {
  const principal = await requirePagePrincipal();
  const target = safeAccountReturnPath(returnTo, principal.roles);
  const access = await enforcePageAccountAccess(principal, {
    selfPath: EMAIL_STEP_PATH,
    returnTo: target,
  });
  return {
    principal,
    target,
    continueTo: access.state === "READY" ? access.destination : null,
  };
}
