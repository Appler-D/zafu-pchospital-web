import type { AccountAccessView } from "@/types/contracts";

/**
 * 门禁的两个解决步骤页。
 *
 * 单独成模块：常量与「当前页是不是这一步」的对应关系要被**服务端守卫**与
 * 客户端 `SessionMonitor` 共用，而判定模块 `account-access.ts` 连着数据库客户端，
 * 不能被客户端组件 import。这里只有常量与纯函数，不引入任何服务端依赖。
 */
export const PASSWORD_STEP_PATH = "/account/change-password";
export const EMAIL_STEP_PATH = "/account/email";

/**
 * 该受限状态下**允许停留**的步骤页（服务端守卫与 SessionMonitor 共用同一份语义）。
 *
 * 停在本页不再重定向，否则会自环；「能不能停」按判定顺序展开，不是简单的一一对应：
 *
 * - `PASSWORD_CHANGE_REQUIRED`：只有改密页。邮箱页在改密之前到达不了（会被换到改密页），
 *   停在邮箱页也不解决问题。
 * - `EMAIL_VERIFICATION_REQUIRED`：邮箱页**和改密页**。任务书要求「仅邮箱受限」的账号
 *   仍能用改密页与改密接口，因此这类账号站在 `/account/change-password` 上是合法的，
 *   不该被踢回邮箱步骤。
 */
export function isAccountStepPage(
  state: AccountAccessView["state"],
  pathname: string | null | undefined,
): boolean {
  if (!pathname) return false;
  if (state === "PASSWORD_CHANGE_REQUIRED") return pathname === PASSWORD_STEP_PATH;
  if (state === "EMAIL_VERIFICATION_REQUIRED")
    return pathname === EMAIL_STEP_PATH || pathname === PASSWORD_STEP_PATH;
  return false;
}
