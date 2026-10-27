"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/Button";

/** 维修审核与成员管理共用的批量操作工具栏。 */
export function AdminBatchTools({
  allSelected,
  selectAllLabel,
  onSelectAll,
  count,
  selectedLabel,
  noneLabel,
  clearLabel,
  onClear,
  clearDisabled,
  actions,
}: {
  /** 表头全选框当前是否已全选（列表为空时传 `false`）。 */
  allSelected: boolean;
  selectAllLabel: string;
  onSelectAll: (checked: boolean) => void;
  /** 当前选中的条数。 */
  count: number;
  /** 选中时的文案，含 `{count}` 占位。 */
  selectedLabel: string;
  /** 未选中时的文案。 */
  noneLabel: string;
  clearLabel: string;
  onClear: () => void;
  clearDisabled?: boolean;
  /** 批量动作按钮，按业务顺序传入。 */
  actions: ReactNode;
}) {
  return (
    <>
      <input
        className="admin-check"
        type="checkbox"
        aria-label={selectAllLabel}
        checked={allSelected}
        onChange={(event) => onSelectAll(event.currentTarget.checked)}
      />
      <span className="admin-status">
        {count > 0 ? selectedLabel.replace("{count}", String(count)) : noneLabel}
      </span>
      <span className="admin-toolbar__sep" aria-hidden="true" />
      {actions}
      <Button variant="ghost" disabled={clearDisabled ?? count === 0} onClick={onClear}>
        {clearLabel}
      </Button>
    </>
  );
}
