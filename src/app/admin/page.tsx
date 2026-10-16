import type { Metadata } from "next";

import { AdminHome } from "@/components/admin/AdminHome";
import { Section } from "@/components/ui/Section";
import { adminCopy } from "@/config/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: adminCopy.title };

/**
 * 后台首页：待办数字带 + 全模块目录（见 `AdminHome`）。
 * 守卫与 `layout.tsx` 同一个入口（`requireAdminPage`）：layout 在客户端导航之间不重挂载，
 * 所以每个 page 自己也要过一次 —— 同一请求里 `cache()` 保证只求值一次，不会翻倍查库。
 */
export default async function AdminHomePage() {
  await requireAdminPage();
  return (
    <Section variant="page-head" className="admin-workspace" labelledBy="admin-home-title">
      <div className="admin-workspace__content">
        <AdminHome />
      </div>
    </Section>
  );
}
