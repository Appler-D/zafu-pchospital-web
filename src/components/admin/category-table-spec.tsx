import { useRowDragSort } from "@/components/admin/useRowDragSort";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { adminCopy, adminShared } from "@/config/admin";
import type { RepairCategoryAdminView } from "@/types/contracts";
import type { TableViewSpec } from "@/types/table";

/** 故障分类表列定义；跨列编辑由面板的 renderRow 接管。 */

/** 页面上会被 `render` 用到的运行时值（`<AdminTable renderContext>` 传入）。 */
export type CategoryTableContext = {
  /** 有请求在飞（停用 / 启用 / 上移下移）：按钮禁用，避免连点。 */
  busy: boolean;
  /**
   * 已加载的行数（`items.length`）。
   *
   * 需要它是因为「下移」按钮只在**最后一行**禁用，而 `render` 拿到的 `index` 只说明
   * 「这一行排第几」，推不出总数；spec 又是模块级常量，不能闭包捕获 `items`。
   */
  total: number;
  /**
   * 拖动排序（`useRowDragSort` 的返回值原样传入）。
   *
   * 行上的 `rowClass` / `rowProps` 由面板挂在 `<AdminTable rowProps>` 上（那是 `<tr>` 的
   * 属性，不是某一格的内容），这里只用到手柄的 `handleProps`。
   */
  drag: ReturnType<typeof useRowDragSort>;
  /** 上移 / 下移一格（服务端幂等处理首末位，界面只是把按钮禁用掉）。 */
  onReorder: (categoryId: string, direction: "UP" | "DOWN") => void;
  /** 停用 / 启用。 */
  onToggle: (category: RepairCategoryAdminView) => void;
  /** 进入行内编辑（整行接管的那一行）。 */
  onEdit: (categoryId: string) => void;
};

const copy = adminCopy.categories;

export const categoryTableSpec: TableViewSpec<RepairCategoryAdminView, CategoryTableContext> = {
  id: "categories",
  title: copy.title,
  rowKey: (category) => category.id,
  fields: [
    {
      key: "grip",
      // 手柄列没有可见表头（写了字就把这一列撑宽了），但读屏需要知道这一列是什么：
      // 走 `headLabel`，渲染成与原标记逐字相同的 `<span class="sr-only">`。
      label: "",
      headLabel: copy.action.drag,
      kind: "readonly",
      sortable: false,
      headClassName: "admin-table__grip",
      cellClassName: "admin-table__grip",
      render: (category, _index, { drag }) => (
        // 手柄是整张表里唯一 `draggable` 的元素：整行可拖会让「选中一行文字」变成拖行，
        // 而表格里的文字正是要能选中的。`aria-hidden` 是因为键盘与触屏用户走每行的 ↑ ↓
        // 按钮（HTML5 拖放在触屏上不触发），这个手柄对他们是一个按不动的控件。
        <span
          className="admin-drag"
          aria-hidden="true"
          title={copy.action.drag}
          {...drag.handleProps(category.id)}
        >
          <Icon name="grip" />
        </span>
      ),
    },
    {
      key: "name",
      label: copy.table.name,
      kind: "text",
      headClassName: "admin-table__grow",
      cellClassName: "admin-table__grow",
      render: (category) => category.name,
    },
    {
      key: "description",
      label: copy.table.description,
      kind: "longText",
      // 说明可以为空（新增时选填），空值统一是 `—`，与其余列一致。
      render: (category) => category.description || adminShared.none,
    },
    {
      key: "usage",
      label: copy.table.usage,
      kind: "number",

      numeric: false,
      render: (category) => category.usedByRepairCount,
    },
    {
      key: "state",
      label: copy.table.state,
      kind: "select",
      // 启用沿用「通过」语气色，停用走中性色（与技能标签表同一语气规则）。
      render: (category) => (
        <span
          className={
            category.isActive ? "repair-tag repair-tag--approved" : "admin-tag admin-tag--muted"
          }
        >
          {category.isActive ? copy.state.active : copy.state.inactive}
        </span>
      ),
    },
    {
      key: "actions",
      label: copy.table.actions,
      kind: "readonly",
      sortable: false,
      render: (category, index, { busy, total, onReorder, onToggle, onEdit }) => (
        <span className="admin-actions">
          <span className="admin-actions__group">
            <Button
              variant="ghost"
              // 首行没有上移、末行没有下移：禁用而不是隐藏（按钮消失会让整排横移）。
              disabled={busy || index === 0}
              aria-label={copy.action.moveUp}
              onClick={() => onReorder(category.id, "UP")}
            >
              <span aria-hidden="true">↑</span>
            </Button>
            <Button
              variant="ghost"
              disabled={busy || index === total - 1}
              aria-label={copy.action.moveDown}
              onClick={() => onReorder(category.id, "DOWN")}
            >
              <span aria-hidden="true">↓</span>
            </Button>
          </span>
          <Button variant="ghost" icon="edit" onClick={() => onEdit(category.id)}>
            {copy.action.edit}
          </Button>
          {/*
            这一列**没有删除入口**，对任何引用计数都是如此：需求里「已被维修记录使用过的
            分类不做物理删除」，落到界面上就是「只有停用与启用」+ 引用计数 + 一句说明
            （`copy.usageNote`，由面板渲染在表格上方）。停用对计数为 0 的分类同样可用 ——
            允不允许删是服务端的事（`/admin/repair-categories` 没有 DELETE 路由），
            界面不靠禁用按钮去表达它。
          */}
          <Button variant="ghost" disabled={busy} onClick={() => onToggle(category)}>
            {category.isActive ? copy.action.deactivate : copy.action.activate}
          </Button>
        </span>
      ),
    },
  ],
};
