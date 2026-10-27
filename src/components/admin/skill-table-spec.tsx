import { useRowDragSort } from "@/components/admin/useRowDragSort";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { adminCopy, adminShared } from "@/config/admin";
import type { SkillAdminView } from "@/types/contracts";
import type { TableViewSpec } from "@/types/table";

/** 技能标签表列定义；跨列编辑由面板的 renderRow 接管。 */

/** 页面上会被 `render` 用到的运行时值（`<AdminTable renderContext>` 传入）。 */
export type SkillTableContext = {
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
  onReorder: (skillId: string, direction: "UP" | "DOWN") => void;
  /** 停用 / 启用。 */
  onToggle: (skill: SkillAdminView) => void;
  /** 进入行内编辑（整行接管的那一行）。 */
  onEdit: (skillId: string) => void;
};

const copy = adminCopy.skills;

export const skillTableSpec: TableViewSpec<SkillAdminView, SkillTableContext> = {
  id: "skills",
  title: copy.title,
  rowKey: (skill) => skill.id,
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
      render: (skill, _index, { drag }) => (
        // 手柄是整张表里唯一 `draggable` 的元素：整行可拖会让「选中一行文字」变成拖行，
        // 而表格里的文字正是要能选中的。`aria-hidden` 是因为键盘用户走每行的 ↑ ↓ 按钮，
        // 这个手柄对他们是一个按不动的控件（`title` 只服务于鼠标悬停提示）。
        <span
          className="admin-drag"
          aria-hidden="true"
          title={copy.action.drag}
          {...drag.handleProps(skill.id)}
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
      render: (skill) => skill.name,
    },
    {
      key: "description",
      label: copy.table.description,
      kind: "longText",
      // 说明可以为空（新增时选填），空值统一是 `—`，与其余列一致。
      render: (skill) => skill.description || adminShared.none,
    },
    {
      key: "usage",
      label: copy.table.usage,
      kind: "number",

      numeric: false,
      render: (skill) => skill.usedByMemberCount,
    },
    {
      key: "state",
      label: copy.table.state,
      kind: "select",
      // 启用沿用「通过」语气色，停用走中性色：停用是**成功地把开关关掉**，
      // 但它同时是一条不再是生效中的标签（与分类管理同一语气规则）。
      render: (skill) => (
        <span
          className={
            skill.isActive ? "repair-tag repair-tag--approved" : "admin-tag admin-tag--muted"
          }
        >
          {skill.isActive ? copy.state.active : copy.state.inactive}
        </span>
      ),
    },
    {
      key: "actions",
      label: copy.table.actions,
      kind: "readonly",
      sortable: false,
      render: (skill, index, { busy, total, onReorder, onToggle, onEdit }) => (
        <span className="admin-actions">
          <span className="admin-actions__group">
            <Button
              variant="ghost"
              disabled={busy || index === 0}
              aria-label={copy.action.moveUp}
              onClick={() => onReorder(skill.id, "UP")}
            >
              <span aria-hidden="true">↑</span>
            </Button>
            <Button
              variant="ghost"
              disabled={busy || index === total - 1}
              aria-label={copy.action.moveDown}
              onClick={() => onReorder(skill.id, "DOWN")}
            >
              <span aria-hidden="true">↓</span>
            </Button>
          </span>
          <Button variant="ghost" icon="edit" onClick={() => onEdit(skill.id)}>
            {copy.action.edit}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => onToggle(skill)}>
            {skill.isActive ? copy.action.deactivate : copy.action.activate}
          </Button>
        </span>
      ),
    },
  ],
};

/** 空列表文案由内核统一渲染，这里把配置暴露给面板，避免面板再引一次 `adminShared`。 */
export const skillEmptyText = adminShared.empty;
