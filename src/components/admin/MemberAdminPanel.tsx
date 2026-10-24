"use client";

import { useTableQuery } from "@/components/admin/useTableQuery";
import { tableQueryOptions } from "@/config/table-queries";
import { tableCopy } from "@/config/admin-tables";

import { useCallback, useEffect, useState } from "react";
import { AdminTableQuery } from "@/components/admin/AdminTableQuery";
import { AdminTableExport } from "@/components/admin/AdminTableExport";

import { AdminBatchTools } from "@/components/admin/AdminBatchTools";
import { AdminListEnd, useAdminList } from "@/components/admin/useAdminList";
import { AdminListToolbar } from "@/components/admin/AdminListToolbar";
import { AdminModal } from "@/components/admin/AdminModal";
import { AdminTable } from "@/components/admin/AdminTable";
import {
  memberTableSpec,
  type MemberEditableFields,
  type MemberTableContext,
} from "@/components/admin/member-table-spec";
import { useColumnResize, type ColumnSpec } from "@/components/admin/useColumnResize";
import { useRowDragSort } from "@/components/admin/useRowDragSort";
import { useRowSelect } from "@/components/admin/useRowSelect";
import { movingRowIds } from "@/lib/list-order";
import { AdminToast } from "@/components/admin/AdminToast";
import type { AdminToastMessage } from "@/components/admin/AdminToast";
import { AdminAccountResetDialog } from "@/components/admin/AdminAccountResetDialog";
import { MemberCreateForm } from "@/components/admin/MemberCreateForm";
import { AdminAccountEmailDialog } from "@/components/admin/AdminAccountEmailPanel";
import { accountEmailCopy } from "@/config/account-email";
import { MemberDetailPanel } from "@/components/admin/MemberDetailPanel";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { adminCopy, adminShared, memberRoleLabels, memberStatusLabels } from "@/config/admin";
import { adminFetch } from "@/features/admin/admin-client";
import type { MemberBatchToggleResult, MemberListEntry, MemberUpdateView } from "@/types/contracts";

type Filters = { query: string; status: string; role: string };

/**
 * 列宽（px）。**顺序必须与表头 `<th>` 一致**（`<colgroup>` 是按顺序对列的）。
 *
 * 第九轮验收改了两件事：
 * 1. 行首不再独占一列 —— 六点手柄与序号并进「成员」单元格（用户反馈「复选框到成员之间
 *    还是雷霆大宽度，和首列属性共享一个区域好了」）。省下的 56px 全给姓名。
 * 2. 没有「吸附列」了：宽度由 `useColumnResize` 保证**总和恒等于容器宽**，
 *    所以每一列都能拖、拖动时相邻两列对冲，表格永远不会被撑出横向滚动条。
 *
 * 总和 = 1079px，正好是 1440px 窗口下表格内容区的宽度；窗口更宽时差额由最后一列吸收。
 */
const COLUMNS: ColumnSpec[] = memberTableSpec.fields.map((field) => ({
  id: field.key,
  // 成员表每一列都在 spec 里声明了默认宽度；`?? 0` 只是把类型收窄 ——
  // 真出现缺省会被 `tests/unit/admin-table-render.test.ts` 的列宽断言拦下（它会先红）。
  width: field.width ?? 0,
  label: field.label,
}));

/**
 * 列宽偏好的存储键（与主题偏好同一个前缀）。
 * `v2`：第九轮把行首并进首列、列宽改成「相邻两列对冲」，旧的 `index` 列与吸附列语义
 * 都不再适用 —— 旧键里的数字留着只会让人困惑，索性换键重新开始。
 */
const COLUMN_STORAGE_KEY = "zafu-pchospital:admin-columns:members:v2";

const QUERY_OPTIONS = tableQueryOptions("members");

const EMPTY_FILTERS: Filters = { query: "", status: "", role: "" };

/**
 * 成员管理（M6 §63）。
 *
 * 页面职责只有「取数 + 排列」：所有状态变更都调 `/api/v1/admin/*`，
 * 由服务端的 Service 层决定规则与审计，前端不做任何权限或状态判断
 * （需求 §41：后端权限校验不能依赖前端按钮是否显示）。
 *
 * 动态渲染出来的表格行**不包 `Reveal`** —— `SiteEffects` 只在挂载时收集一次 `.reveal`，
 * 后插入的元素会永远停在 `opacity: 0`（`docs/design-system.md` §4.6）。
 */
export function MemberAdminPanel() {
  const copy = adminCopy.members;
  /** 必须留在页面上的信息：批量逐条失败明细、重置密码的初始密码（关掉就再也看不到）。 */
  const [message, setMessage] = useState("");
  /** 一次性成功反馈：走顶部浮层，不占布局。 */
  const [toast, setToast] = useState<AdminToastMessage | null>(null);
  const query = useTableQuery(QUERY_OPTIONS, EMPTY_FILTERS);
  const requestParams = query.params;
  const sortRules = query.value.sort;
  const setSortRules = query.setSort;
  const [selected, setSelected] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [busy, setBusy] = useState(false);
  // 取数状态收在 `useAdminList` 里：往下滚动自动接下一页（邮箱式的连续列表，
  // 不再有「上一页 / 下一页」）。查询状态变化统一重载第一页。
  const list = useAdminList<MemberListEntry>(
    useCallback(
      (targetPage: number, signal?: AbortSignal) =>
        adminFetch<MemberListEntry[]>(`/api/v1/admin/members?${requestParams(targetPage)}`, {
          signal,
        }),
      [requestParams],
    ),
    { queryKey: query.ready ? query.signature : null },
  );
  const { items, pagination, state, problem, loadingMore } = list;
  /** 行号从 1 开始，无限下翻时接着往下编（不是「第几页的第几行」）。 */
  const firstRowNumber = 1;
  // 列宽可拖拽（Excel 式全局竖线）：宽度是使用者才清楚的事，写死永远照顾不到所有人。
  const resize = useColumnResize({ storageKey: COLUMN_STORAGE_KEY, columns: COLUMNS });
  // 行首的序号 / 复选框与范围选择（Shift 点击）。
  const rows = useRowSelect({
    ids: items.map((item) => item.id),
    selected,
    onChange: (ids) => {
      if (!list.refreshing) setSelected(ids);
    },
  });
  /* 拖动排序：六点手柄是整张表里唯一可拖的元素（`useRowDragSort`，与技能 / 分类同一套）。
     把 `selected` 传进去 —— 勾选多行时拖动其中任意一行，整块一起移动
     （落点解析会跳过被移动的那几行，见 `movingRowIds`）。 */
  const sort = useRowDragSort(
    items.map((item) => item.id),
    (id, beforeId) => void moveRows(id, beforeId),
    selected,
  );
  /**
   * 单元格渲染要用的运行时值。**每次渲染新建**，所以走 `renderContext` 而不是把 spec
   * 做成工厂函数：spec 一旦随选中状态变化，以它派生的列清单为依赖的 `useColumnResize`
   * 就会跟着重跑列宽对齐 —— 拖动列宽时尤其危险（见 `FieldSpec.render` 的注释）。
   */
  const renderContext: MemberTableContext = {
    rows,
    sort,
    firstRowNumber,
    onView: setDetailId,
    sortingActive: sortRules.length > 0 || list.refreshing,
    updateMember,
  };
  /**
   * 页面自己的错误（批量逐条失败的明细、重置密码这类动作的失败）。
   * 与 `list.problem`（取数失败）分开：取数失败要整体换成「重新加载」，动作失败只提示一次。
   */
  const [actionProblem, setProblem] = useState("");
  const selectionFilter = JSON.stringify([query.value.fixed, query.value.filters]);
  useEffect(() => {
    setSelected([]);
  }, [selectionFilter]);
  const shownProblem = actionProblem || problem;

  const load = useCallback(async () => {
    // 换筛选后清空选择：否则「已选 N 名」会与当前列表无关，批量操作容易误伤。
    setSelected([]);
    await list.reload();
  }, [list]);

  async function updateMember(memberId: string, fields: MemberEditableFields) {
    const current = items.find((item) => item.id === memberId);
    // 找不到说明列表刚被换过（筛选 / 重取）：不猜版本号，让用户重来。
    if (!current) throw new Error("这条成员不在当前列表里，请刷新后重试");
    const result = await adminFetch<MemberUpdateView>(`/api/v1/admin/members/${memberId}`, {
      method: "PATCH",
      body: { ...fields, version: current.version },
    });
    if (!result.ok) {
      setToast({ text: result.message, tone: "neutral" });
      throw new Error(result.message);
    }
    list.patch(memberId, result.data);
  }

  /**
   * 拖动排序落点。
   *
   * 三条约定：
   * 1. **乐观更新**：先按 `lib/list-order.ts` 的同一套规则改本地顺序 —— 松手即到位，
   *    不等接口往返（用户反馈「不是立即响应修改的」就是这个等待）。
   * 2. **勾选多行时整块移动**：判断收在 `movingRowIds`，与钩子算落点时用的是同一条规则。
   * 3. **失败回滚**：请求失败就把顺序恢复成改动前的快照并报错，不留一个假顺序。
   *    成功后**不再重取列表** —— 服务端写的就是同一套规则算出来的顺序，重取只会让
   *    已经看到的顺序再闪一次（还会把下翻出来的几页缩回第一页）。
   */
  async function moveRows(draggingId: string, beforeId: string | null) {
    const movingIds = movingRowIds(draggingId, selected);
    setProblem("");
    setToast(null);
    const previous = list.reorder(movingIds, beforeId);
    const result = await adminFetch<{ moved: boolean }>("/api/v1/admin/members/move", {
      method: "POST",
      body: { memberIds: movingIds, beforeId },
    });
    if (!result.ok) {
      list.setOrder(previous);
      setProblem(result.message);
      return;
    }
    if (!result.data.moved) return; // 落点没变：顺序本来就没动，不必提示
    setToast({
      text:
        movingIds.length > 1
          ? copy.table.movedMany.replace("{count}", String(movingIds.length))
          : copy.table.moved,
      tone: "success",
    });
  }

  async function runBatch(enabled: boolean) {
    setBusy(true);
    setMessage("");
    setToast(null);
    setProblem("");
    const result = await adminFetch<MemberBatchToggleResult>("/api/v1/admin/members/batch", {
      method: "POST",
      body: { memberIds: selected, enabled },
    });
    setBusy(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    if (result.data.failed.length === 0) {
      setToast({
        text: `已处理 ${result.data.succeeded.length} 名成员。`,
        // 批量禁用同样用叉：操作成功了，但结果是「关掉」。
        tone: enabled ? "success" : "neutral",
      });
    } else {
      setMessage(
        `${adminShared.batchPartial}成功 ${result.data.succeeded.length} 名，失败 ${result.data.failed.length} 名：${result.data.failed
          .map((item) => `${item.memberId.slice(0, 8)}… ${item.message}`)
          .join("；")}`,
      );
    }
    await load();
  }

  /* 「重置密码」仍然只在成员详情窗口里做（先看到人、再重置；列表里再放一个等于
     同一件事两处实现）。工具栏的「账号恢复」是另一件事（issue #113）：忘记密码时
     按 QQ 精确查到账号再签发临时密码 —— 目标可以是**没有成员档案的管理员**，
     成员列表里根本没有这一行，所以它必须常驻在列表外面。 */

  const allSelected = items.length > 0 && items.every((item) => selected.includes(item.id));

  return (
    <div className="admin-workspace__content">
      <div className="admin-workspace__header">
        <div>
          <h1 className="admin-workspace__title" id="admin-members-title">
            {copy.title}
          </h1>
          <p className="admin-workspace__lead">{copy.lead}</p>
        </div>
        {/* 「新增成员」只在顶栏放一个入口（与批量动作同一排），页头不再重复。 */}
      </div>

      <AdminToast toast={toast} onDismiss={() => setToast(null)} />

      {message ? (
        <p className="admin-status" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {shownProblem ? (
        <p className="admin-status admin-status--error" role="alert">
          {shownProblem}
        </p>
      ) : null}

      <AdminTableQuery
        ready={query.ready}
        value={query.value}
        options={QUERY_OPTIONS}
        quick={[
          { key: "query", label: copy.filter.query },
          {
            key: "status",
            label: copy.filter.status,
            options: Object.entries(memberStatusLabels).map(([value, label]) => ({ value, label })),
          },
          {
            key: "role",
            label: copy.filter.role,
            options: Object.entries(memberRoleLabels).map(([value, label]) => ({ value, label })),
          },
        ]}
        onChange={query.setValue}
        onClear={query.reset}
        summary={list.summary}
        refreshing={list.refreshing}
        problem={list.problem}
        onResetColumns={resize.reset}
      />

      <p className="admin-note">{copy.export.note}</p>

      {state === "loading" ? (
        <p className="admin-status" role="status">
          {adminShared.loading}
        </p>
      ) : null}

      {state === "error" ? (
        <Card variant="notice">
          <p>{problem || adminShared.loadFailed}</p>
          <Button onClick={() => void load()}>{adminShared.reload}</Button>
        </Card>
      ) : null}

      {state === "ready" ? (
        <div className="admin-list">
          {/* 顶栏常驻（邮箱式）：未选中时动作按钮禁用，因此没有出现/消失，也就没有位移。 */}
          <AdminListToolbar
            count={(list.refreshing
              ? tableCopy.updating
              : list.problem
                ? tableCopy.previousCount
                : tableCopy.count
            ).replace("{count}", String(pagination?.total ?? items.length))}
          >
            <AdminBatchTools
              allSelected={allSelected}
              selectAllLabel={copy.table.selectAll}
              onSelectAll={(checked) => {
                if (!list.refreshing) setSelected(checked ? items.map((item) => item.id) : []);
              }}
              count={selected.length}
              selectedLabel={copy.batch.selected}
              noneLabel={copy.batch.none}
              clearLabel={copy.batch.clear}
              onClear={() => setSelected([])}
              actions={
                <>
                  <Button
                    disabled={busy || list.refreshing || selected.length === 0}
                    onClick={() => void runBatch(true)}
                  >
                    {copy.batch.enable}
                  </Button>
                  <Button
                    disabled={busy || list.refreshing || selected.length === 0}
                    onClick={() => void runBatch(false)}
                  >
                    {copy.batch.disable}
                  </Button>
                </>
              }
            />
            <span className="admin-toolbar__sep" aria-hidden="true" />
            <AdminTableExport
              path="/api/v1/admin/members/export"
              params={() => query.params(1)}
              disabled={busy || !query.ready || list.refreshing || Boolean(list.problem)}
              onError={setProblem}
              onDone={(text) => setToast({ text, tone: "success" })}
            />
            {/* 列级筛选常驻在工具栏里（与批量动作同一排）：它不因「有没有条件」出现或消失，
                计数槽位宽度固定，因此数字变化时右边的按钮不会横移。 */}
            <Button onClick={() => setEmailOpen(true)}>{accountEmailCopy.adminTitle}</Button>
            <Button icon="key" onClick={() => setRecovering(true)}>
              {copy.account.action}
            </Button>
            <Button variant="solid" icon="plus" onClick={() => setCreating(true)}>
              {copy.create.title}
            </Button>
          </AdminListToolbar>
          {/* 表格本体由内核渲染（`AdminTable`）：列宽、表头、单元格内容全部来自
              `memberTableSpec` 这一份定义，不再分别写在 `COLUMNS` / `<th>` / `<td>` 三处。

              Excel 式全局竖线是**覆盖层**，走 `overlay` 渲染在表格外面 —— 只有这样才能
              贯穿表头与所有行，拖动时不必再去表头找那个小柄；位置由 `useColumnResize`
              量出来，表宽 / 列宽变化时重算。 */}
          <AdminTable
            spec={memberTableSpec}
            items={items}
            renderContext={renderContext}
            sort={sortRules}
            onSortChange={setSortRules}
            emptyText={adminShared.empty}
            widths={resize.widths}
            colRefs={resize.colRefs}
            tableRef={resize.tableRef}
            wrapClassName="admin-table-wrap admin-table-wrap--resizable"
            className="admin-table admin-table--resizable"
            rowProps={(member) => ({
              "data-row-id": member.id,
              // 正在拖的行半透明、落点行画一条指示线（`useRowDragSort`）。
              className: sort.rowClass(member.id),
              ...sort.rowProps(member.id),
            })}
            overlay={
              <div className="admin-colgrid">
                {resize.boundaries.map((boundary) => (
                  <span
                    key={boundary.id}
                    style={{ insetInlineStart: `${boundary.x}px` }}
                    {...resize.lineProps(boundary.id, boundary.label)}
                  />
                ))}
              </div>
            }
          />
          <AdminListEnd
            pagination={pagination}
            loaded={items.length}
            busy={loadingMore}
            onLoadMore={list.loadMore}
            labels={adminShared.listEnd}
          />
        </div>
      ) : null}

      {detailId ? (
        <MemberDetailPanel
          memberId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => void load()}
          onUpdated={(member) => list.patch(member.id, member)}
        />
      ) : null}

      {/* 新增成员走窗口，不在表格下面追加面板：表格本身有一两千像素高，
          在它下面插入内容用户根本看不见（第六轮验收：「一直以为这个功能是坏的」）。
          创建成功后窗口**不自动关闭** —— 初始密码只出现一次，随窗口消失就等于没发出去。 */}
      {creating ? (
        <AdminModal title={copy.create.title} onClose={() => setCreating(false)}>
          <MemberCreateForm onCreated={() => void load()} onClose={() => setCreating(false)} />
        </AdminModal>
      ) : null}

      {/* 账号恢复（issue #113）：按 QQ 精确查询成员或管理员并签发临时密码。 */}
      {emailOpen ? <AdminAccountEmailDialog onClose={() => setEmailOpen(false)} /> : null}
      {recovering ? <AdminAccountResetDialog onClose={() => setRecovering(false)} /> : null}
    </div>
  );
}
