"use client";

import type { ReactNode } from "react";

/** 列表工具栏：左侧放选择与批量操作，右侧显示数量。 */
export function AdminListToolbar({
  children,
  count,
}: {
  /** 左侧：选择状态与批量动作按钮。 */
  children?: ReactNode;
  /** 右侧：总数文案。 */
  count: string;
}) {
  return (
    <div className="admin-toolbar">
      <div className="admin-toolbar__actions">{children}</div>
      <p className="admin-toolbar__count">{count}</p>
    </div>
  );
}
