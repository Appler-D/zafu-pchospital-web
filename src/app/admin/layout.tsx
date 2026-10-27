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

/** 后台导航由持久 layout 承载，切页时保留挂载。 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const principal = await requireAdminPage();
  return (
    <div className="admin-shell">
      <AdminNav displayName={principal.displayName} />
      <div className="admin-shell__main">{children}</div>
    </div>
  );
}
