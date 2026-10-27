import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { enforcePageAccountAccess, requirePagePrincipal } from "@/lib/auth/page-access";

/**
 * 管理后台页面（`/admin/**`）的统一入口守卫。
 *
 * 与 `member-page.ts` 的档位规则一致，只是最后一条换成角色判定：
 * 1. 无有效会话 / 会话失效 → `/login`（带上当前的业务页作为候选原目标）；
 * 2. 统一账号门禁（强制改密 → 邮箱验证 / 豁免），与业务 API 同源、每次请求重判；
 *    未过门禁的管理员连管理接口都会被 `authenticateRequest` 拒掉，先按引导走完
 *    步骤才不会一进后台就处处 403；
 * 3. 已登录但不是管理员 → `/member`（这是权限判定，门禁不授予也不绕过权限）。
 *
 * ⚠️ `/admin` 首页也调用本守卫，因此这里**不能**把非管理员重定向到 `/admin` 自身
 * （会形成重定向自环），必须指向站内另一处合法落点：成员工作台。
 *
 * **用 `cache()` 包住**：`/admin/**` 的 layout 与 page 都要走这道判定，
 * `cache` 让**同一个请求**里它们共用一次求值 —— 页面级重判不会翻倍查库，也不会各算各的。
 * 请求之间不共享：每次页面 / RSC 请求都重新按数据库判定（撤销豁免立刻生效）。
 *
 * 这只是「页面能不能渲染」的第一道闸门。所有数据都来自 `/api/v1/admin/*`，
 * 那条链路有独立的 `requirePermission(actor, "…")` 校验 —— 前端守卫被绕过也不会泄漏数据
 * （需求 §41：后端权限校验不能依赖前端按钮是否显示）。
 */
export const requireAdminPage = cache(async () => {
  const principal = await requirePagePrincipal();
  await enforcePageAccountAccess(principal);
  if (!principal.roles.includes("ADMIN")) redirect("/member");
  return principal;
});
