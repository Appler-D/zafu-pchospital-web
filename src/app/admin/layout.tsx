import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AdminNav } from "@/components/admin/AdminNav";
import { adminCopy } from "@/config/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = {
  title: adminCopy.title,
  // 管理后台不进搜索引擎索引；页面本身也需要登录才可渲染。
  robots: { index: false, follow: false },
};

/**
 * `/admin/**` 的统一守卫层 + 后台外壳。
 *
 * 守卫在 layout 与**每个 page** 各调用一次同一个入口（`requireAdminPage`）：
 * layout 在客户端导航之间保持挂载、不会为切页重新求值，只靠它就不能保证
 * 「导航到新页面」这一次服务端请求重新过门禁（任务 6 返修 F2）。两处共用一个入口，
 * 且它被 `cache()` 包住 —— 同一请求只求值一次，新增页面漏掉守卫时 layout 仍然兜得住。
 * 数据接口另有独立的 `requirePermission` 校验，前端守卫只是「页面能不能渲染」这一道。
 *
 * **外壳（左侧栏 + 内容区）也放在这里**：layout 在客户端导航之间保持挂载，
 * 于是切页时侧栏不重建、滚动位置与高亮状态都不抖。原先导航在 11 个页面里各渲染一次，
 * 每次切页都要重新挂载整条导航 —— 这是「停顿感」的一部分来源。
 * 页面的 `<Section>` 仍在各自 page 里（它承载每页自己的 `aria-labelledby`）。
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const principal = await requireAdminPage();
  return (
    <div className="admin-shell">
      <AdminNav displayName={principal.displayName} />
      <div className="admin-shell__main">{children}</div>
    </div>
  );
}
