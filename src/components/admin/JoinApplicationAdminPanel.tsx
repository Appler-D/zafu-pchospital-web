"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";

import { AdminListToolbar } from "@/components/admin/AdminListToolbar";
import { AdminModal } from "@/components/admin/AdminModal";
import { AdminTable } from "@/components/admin/AdminTable";
import { AdminToast } from "@/components/admin/AdminToast";
import type { AdminToastMessage } from "@/components/admin/AdminToast";
import { AdminListEnd, useAdminList } from "@/components/admin/useAdminList";
import { AccountNotificationStatusPanel } from "@/components/admin/AccountNotificationStatusPanel";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { accountNotificationCopy as notificationCopy } from "@/config/account-notification";
import { memberDepartmentLabels, memberDepartmentOptions } from "@/config/member-department";
import {
  adminCopy,
  adminShared,
  joinApplicationStatusLabels,
  provisionStatusLabels,
} from "@/config/admin";
import {
  formatDateTime,
  joinApplicationEmptyText,
  joinApplicationTableSpec,
} from "@/components/admin/join-application-table-spec";
import { adminFetch } from "@/features/admin/admin-client";
import { listQueryParams } from "@/lib/api/list-query";
import {
  InterviewResult,
  JoinApplicationStatus,
  ProvisionStatus,
  type JoinApplicationDetail,
  type JoinApplicationSummary,
  type JoinApplicationView,
  type JoinNotificationEmailCorrection,
  type ProvisionView,
  type MemberDepartment,
} from "@/types/contracts";
import { EMAIL_MAX_LENGTH } from "@/lib/security/normalization";

const EMPTY_FILTERS = {
  recruitmentCycle: "",
  query: "",
  status: "",
  provisionStatus: "",
  submittedFrom: "",
  submittedTo: "",
};

/**
 * 招募审核（M6 批次 2，需求 §11 / §4.4）。
 *
 * 服务端能力（列表 / 详情 / 登记面试结果 / 账号发放与重试 / 导出）在 M1 就已实现，
 * 这一段补的是**界面**。三处刻意的取舍：
 *
 * 1. 详情单独打开一个窗口 —— 报名资料很长（自我介绍、备注、面试记录），内联展开会把
 *    表格顶得老远；且详情是唯一返回明文联系方式的入口（服务端每次读取写审计），
 *    把「看明文」这件事收敛到一个明确动作上比列表里铺开更合适。
 * 2. 登记面试结果与账号发放分成两块：发放是**另一个状态机**（PENDING / SUCCEEDED /
 *    FAILED），只有失败才允许重试，界面如实反映，不让按钮点下去都 409。
 * 3. 导出按**当前筛选**导出，并明确写清文件里带明文联系方式（`data:export` + 审计）。
 */
export function JoinApplicationAdminPanel() {
  const copy = adminCopy.recruitment;
  /** 页面自己产生的错误（导出失败等）；取数错误走 `list.problem`。 */
  const [actionProblem, setProblem] = useState("");
  const [toast, setToast] = useState<AdminToastMessage | null>(null);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [cycleDraft, setCycleDraft] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  /** 行内「通过」待确认的报名（issue #95）：非空即弹二次确认。 */
  const [approving, setApproving] = useState<JoinApplicationSummary | null>(null);
  const [admittedDepartment, setAdmittedDepartment] = useState<MemberDepartment>("REPAIR");
  const [approveProblem, setApproveProblem] = useState("");
  const [busy, setBusy] = useState(false);

  // 取数状态收在 `useAdminList` 里：往下滚动自动接下一页（邮箱式的连续列表，
  // 不再有「上一页 / 下一页」）。筛选变化时由下面的 effect 重置回第一页。
  const list = useAdminList<JoinApplicationSummary>(
    useCallback(
      (targetPage: number) => {
        const params = filterParams(applied, targetPage);
        return adminFetch<JoinApplicationSummary[]>(
          `/api/v1/admin/join-applications?${params.toString()}`,
        );
      },
      [applied],
    ),
  );
  const { items, pagination, state, problem, loadingMore } = list;
  const shownProblem = actionProblem || problem;

  const load = useCallback(async () => {
    await list.reload();
  }, [list]);

  useEffect(() => {
    void load();
    // `applied` 变化才重新取第一页；`list` 是稳定引用（内部用 ref 取最新筛选）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setApplied({
      recruitmentCycle: data.recruitmentCycle ?? "",
      query: data.query ?? "",
      status: data.status ?? "",
      provisionStatus: data.provisionStatus ?? "",
      submittedFrom: data.submittedFrom ?? "",
      submittedTo: data.submittedTo ?? "",
    });
  }

  async function exportData(format: "csv" | "xlsx") {
    setBusy(true);
    setProblem("");
    setToast(null);
    const params = filterParams(applied, 1);
    params.set("format", format);
    let response: Response;
    try {
      response = await fetch(`/api/v1/admin/join-applications/export?${params.toString()}`);
    } catch {
      setBusy(false);
      setProblem("网络异常，请检查连接后重试");
      return;
    }
    if (!response.ok) {
      const message = await errorMessage(response);
      setBusy(false);
      setProblem(message);
      return;
    }
    const rowCount = Number(response.headers.get("X-Export-Row-Count") ?? "0");
    if (rowCount === 0) {
      setBusy(false);
      setProblem(copy.export.empty);
      return;
    }
    // 与维修导出同一处理：`revokeObjectURL` 不能紧跟 `click()`，否则部分浏览器会把
    // 刚开始的下载掐断（表现为 0 字节文件）。
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileNameOf(response) ?? `join-applications.${format}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBusy(false);
    setToast({
      text: copy.export.done.replace("{count}", String(rowCount)),
      tone: "success",
    });
  }

  /** 行内快速通过（issue #95）：二次确认后提交审核，服务端随即自动创建账号并发放。 */
  async function confirmApprove() {
    if (!approving) return;
    setBusy(true);
    setApproveProblem("");
    setToast(null);
    const result = await adminFetch<JoinApplicationView>(
      `/api/v1/admin/join-applications/${approving.id}/reviews`,
      {
        method: "POST",
        body: {
          result: "PASSED",
          admittedDepartment,
          interviewedAt: new Date().toISOString(),
          idempotencyKey: crypto.randomUUID(),
        },
      },
    );
    if (!result.ok) {
      setApproveProblem(
        result.code === "JOIN_APPLICATION_NOT_REVIEWABLE"
          ? copy.review.notReviewable
          : result.message,
      );
      // 首次通过与发放原子提交，失败时保留列表、部门选择和确认窗口。
      setBusy(false);
      return;
    }
    setApproving(null);
    setToast({ text: copy.quickApprove.done, tone: "success" });
    await load();
    setBusy(false);
  }

  return (
    <div className="admin-workspace__content">
      <div className="admin-workspace__header">
        <div>
          <h1 className="admin-workspace__title" id="admin-recruitment-title" tabIndex={-1}>
            {copy.title}
          </h1>
          <p className="admin-workspace__lead">{copy.lead}</p>
          {/* 导出的风险说明留在页头：导出按钮已移到列表工具栏，这条说明不跟着按钮走。 */}
          <p className="admin-note">{copy.export.note}</p>
        </div>
      </div>

      <AdminToast toast={toast} onDismiss={() => setToast(null)} />

      {shownProblem ? (
        <p className="admin-status admin-status--error" role="alert">
          {shownProblem}
        </p>
      ) : null}

      <form
        method="post"
        className="admin-filters"
        onSubmit={submitFilters}
        aria-label={copy.filter.submit}
      >
        <div className="admin-filters__row">
          <label className="field">
            <span className="field__label">{copy.filter.recruitmentCycle}</span>
            <input
              className="field__input"
              name="recruitmentCycle"
              value={cycleDraft}
              onChange={(event) => setCycleDraft(event.target.value)}
              maxLength={32}
              placeholder={copy.filter.cyclePlaceholder}
            />
          </label>
          <label className="field">
            <span className="field__label">{copy.filter.query}</span>
            <input
              className="field__input"
              name="query"
              defaultValue={applied.query}
              maxLength={64}
            />
          </label>
          <label className="field">
            <span className="field__label">{copy.filter.status}</span>
            <select className="field__input" name="status" defaultValue={applied.status}>
              <option value="">全部</option>
              {JoinApplicationStatus.map((status) => (
                <option key={status} value={status}>
                  {joinApplicationStatusLabels[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{copy.filter.provisionStatus}</span>
            <select
              className="field__input"
              name="provisionStatus"
              defaultValue={applied.provisionStatus}
            >
              <option value="">全部</option>
              {ProvisionStatus.map((status) => (
                <option key={status} value={status}>
                  {provisionStatusLabels[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{copy.filter.submittedFrom}</span>
            <input
              className="field__input"
              type="date"
              name="submittedFrom"
              defaultValue={applied.submittedFrom}
            />
          </label>
          <label className="field">
            <span className="field__label">{copy.filter.submittedTo}</span>
            <input
              className="field__input"
              type="date"
              name="submittedTo"
              defaultValue={applied.submittedTo}
            />
          </label>
          <Button type="submit" icon="check">
            {copy.filter.submit}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setApplied(EMPTY_FILTERS);
              setCycleDraft("");
            }}
          >
            {copy.filter.reset}
          </Button>
        </div>
        {/* 查询说明：常驻一行（不是展开才有），既不会被忽略也不会让下方的表跳一下。 */}
        <p className="admin-filters__hint">{copy.filter.hint}</p>
      </form>

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
          {/* 顶栏常驻（邮箱式）：左侧是导出动作，右侧是总数。 */}
          <AdminListToolbar
            count={copy.count.replace("{count}", String(pagination?.total ?? items.length))}
          >
            <span className="admin-actions">
              <Button
                type="button"
                icon="download"
                disabled={busy}
                onClick={() => void exportData("csv")}
              >
                {copy.export.csv}
              </Button>
              <Button
                type="button"
                icon="download"
                disabled={busy}
                onClick={() => void exportData("xlsx")}
              >
                {copy.export.xlsx}
              </Button>
            </span>
          </AdminListToolbar>
          {/* 表格本体由内核渲染（`AdminTable`）：列宽、表头、单元格内容全部来自
              `joinApplicationTableSpec` 这一份定义。 */}
          <AdminTable
            spec={joinApplicationTableSpec}
            items={items}
            emptyText={joinApplicationEmptyText}
            renderContext={{
              onDetail: setDetailId,
              onApprove: (application) => {
                setAdmittedDepartment("REPAIR");
                setApproveProblem("");
                setApproving(application);
              },
              busy,
            }}
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
        <ApplicationDetailPanel
          applicationId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => void load()}
          onDeleted={async () => {
            // 先完成弹窗卸载及其焦点清理，再恢复焦点，避免刷新完成后打断后续操作。
            flushSync(() => setDetailId(null));
            document.getElementById("admin-recruitment-title")?.focus({ preventScroll: true });
            setToast({ text: copy.deletion.done, tone: "neutral" });
            await list.refreshLoaded();
          }}
        />
      ) : null}

      {approving ? (
        <ConfirmDialog
          title={copy.quickApprove.title}
          cancelLabel={adminShared.cancel}
          confirmLabel={busy ? adminShared.submitting : copy.action.approve}
          busy={busy}
          onClose={() => {
            if (!busy) setApproving(null);
          }}
          onConfirm={() => void confirmApprove()}
        >
          <p>{copy.quickApprove.hint}</p>
          <label className="field">
            <span className="field__label">{copy.review.admittedDepartment}</span>
            <select
              className="field__input"
              value={admittedDepartment}
              disabled={busy}
              onChange={(event) => setAdmittedDepartment(event.target.value as MemberDepartment)}
            >
              {memberDepartmentOptions.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {approveProblem ? (
            <p className="admin-status admin-status--error" role="alert">
              {approveProblem}
            </p>
          ) : null}
          <p>
            <strong>
              {approving.ticketNo} · {approving.realName}
            </strong>
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/**
 * 报名详情窗口：资料 + 面试登记 + 账号发放。
 *
 * 打开时取一次详情 —— 服务端在这一步写 `join.application.detail.viewed` 审计，
 * 因此明文联系方式只在用户明确点了「详情」之后才出现。
 */
function ApplicationDetailPanel({
  applicationId,
  onClose,
  onChanged,
  onDeleted,
}: {
  applicationId: string;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => Promise<void>;
}) {
  const copy = adminCopy.recruitment;
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [detail, setDetail] = useState<JoinApplicationDetail | null>(null);
  const [problem, setProblem] = useState("");
  const [toast, setToast] = useState<AdminToastMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState("");
  /** 更正通知邮箱（issue #161）：与详情同一窗口，切换内容而不是叠第二层弹层。 */
  const [correcting, setCorrecting] = useState(false);
  /** 更正表单保存中：阻止关闭整个窗口，避免请求完成后结果落到已卸载的界面。 */
  const [correctingBusy, setCorrectingBusy] = useState(false);
  /** 登记面试结果返回的初始密码：响应里的值只出现一次，留在窗口里展示（规则见下方说明）。 */
  const [secret, setSecret] = useState("");
  const [provision, setProvision] = useState<ProvisionView | null>(null);
  const [reviewResult, setReviewResult] = useState<InterviewResult>("PASSED");
  const [admittedDepartment, setAdmittedDepartment] = useState<MemberDepartment>("REPAIR");
  const [interviewedAt, setInterviewedAt] = useState(() => toLocalInput(new Date().toISOString()));
  const [internalNote, setInternalNote] = useState("");
  const idempotencyKey = useRef(crypto.randomUUID());

  const load = useCallback(async () => {
    const result = await adminFetch<JoinApplicationDetail>(
      `/api/v1/admin/join-applications/${applicationId}`,
    );
    if (!result.ok) {
      setState("error");
      setProblem(result.message);
      return;
    }
    setDetail(result.data);
    setState("ready");
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    setToast(null);
    setSecret("");
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const result = await adminFetch<JoinApplicationView & { initializationSecret?: string }>(
      `/api/v1/admin/join-applications/${applicationId}/reviews`,
      {
        method: "POST",
        body: {
          result: data.result === "PASSED" ? "PASSED" : "REJECTED",
          admittedDepartment:
            data.result === "PASSED" && detail?.status !== "INTERVIEW_PASSED"
              ? data.admittedDepartment
              : undefined,
          interviewedAt: toIso(data.interviewedAt) ?? new Date().toISOString(),
          internalNote: data.internalNote || undefined,
          idempotencyKey: idempotencyKey.current,
        },
      },
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(
        result.code === "JOIN_APPLICATION_NOT_REVIEWABLE"
          ? copy.review.notReviewable
          : result.message,
      );
      return;
    }
    // 幂等键用掉一次就换新的：否则「先登记通过、再补一条记录」会被判成同一次提交。
    idempotencyKey.current = crypto.randomUUID();
    setSecret(result.data.initializationSecret ?? "");
    // 已通过的报名再次提交「通过」时服务端不重复发放：带备注只是补记一条面试记录（issue
    // #97），不带备注是空操作 —— 两种都不能再提示「账号发放任务已创建」。
    let toastText: string = copy.review.saved;
    if (data.result === "PASSED" && detail?.status !== "INTERVIEW_PASSED") {
      toastText = copy.review.passedSaved;
    } else if (data.result === "PASSED" && data.internalNote?.trim()) {
      toastText = copy.review.noteAppended;
    }
    setToast({
      text: toastText,
      tone: data.result === "PASSED" ? "success" : "neutral",
    });
    await load();
    onChanged();
  }

  async function runProvision(retry: boolean) {
    setBusy(true);
    setProblem("");
    setToast(null);
    setSecret("");
    const path = retry ? "provision/retry" : "provision";
    const result = await adminFetch<ProvisionView>(
      `/api/v1/admin/join-applications/${applicationId}/${path}`,
      { method: "POST" },
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(
        result.code === "STATE_TRANSITION_INVALID"
          ? copy.provision.retryUnavailable
          : result.message,
      );
      return;
    }
    setProvision(result.data);
    setToast({ text: copy.provision.retried, tone: "success" });
    await load();
    onChanged();
  }

  const currentProvision = provision?.status ?? detail?.provisionStatus ?? "NOT_REQUIRED";

  async function deleteApplication() {
    setBusy(true);
    setDeleteProblem("");
    const result = await adminFetch<null>(`/api/v1/admin/join-applications/${applicationId}`, {
      method: "DELETE",
    });
    if (!result.ok) {
      setDeleteProblem(result.message);
      setBusy(false);
      return;
    }
    await onDeleted();
  }

  if (deleting) {
    return (
      <ConfirmDialog
        title={copy.deletion.title}
        cancelLabel={adminShared.cancel}
        confirmLabel={busy ? adminShared.submitting : copy.deletion.action}
        busy={busy}
        onClose={() => {
          if (!busy) setDeleting(false);
        }}
        onConfirm={() => void deleteApplication()}
      >
        <p>{copy.deletion.hint}</p>
        <p className="admin-note">{copy.deletion.retained}</p>
        <p>
          <strong>
            {detail?.ticketNo} · {detail?.realName}
          </strong>
        </p>
        {deleteProblem ? (
          <p className="admin-status admin-status--error" role="alert">
            {deleteProblem}
          </p>
        ) : null}
      </ConfirmDialog>
    );
  }

  // 更正与删除一样是「同一时刻只挂一个弹层」：直接切换到独立窗口，避免叠第二层遮罩，
  // 也避免把整块详情 JSX 包进三元里重排缩进。
  if (correcting && detail) {
    return (
      <AdminModal
        title={copy.emailCorrection.title}
        subtitle={`${detail.ticketNo} · ${detail.realName}`}
        onClose={() => {
          if (!busy && !correctingBusy) onClose();
        }}
      >
        <AdminToast toast={toast} onDismiss={() => setToast(null)} />
        <EmailCorrectionForm
          applicationId={applicationId}
          detail={detail}
          onBack={() => setCorrecting(false)}
          onBusyChange={setCorrectingBusy}
          onProblem={(text) => setToast({ text, tone: "neutral" })}
          onSaved={(result) => {
            setDetail((current) =>
              current
                ? { ...current, email: result.email, notification: result.notification }
                : current,
            );
            setCorrecting(false);
            setToast({ text: copy.emailCorrection.saved, tone: "success" });
            onChanged();
          }}
        />
      </AdminModal>
    );
  }

  return (
    <AdminModal
      title={copy.detail.title}
      subtitle={detail ? `${detail.ticketNo} · ${detail.realName}` : undefined}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <AdminToast toast={toast} onDismiss={() => setToast(null)} />

      {state === "loading" ? (
        <p className="admin-status" role="status">
          {adminShared.loading}
        </p>
      ) : null}

      {state === "error" ? (
        <>
          <p className="admin-status admin-status--error" role="alert">
            {problem || adminShared.loadFailed}
          </p>
          <div className="signup__actions">
            <Button onClick={() => void load()}>{adminShared.reload}</Button>
          </div>
        </>
      ) : null}

      {problem && state === "ready" ? (
        <p className="admin-status admin-status--error" role="alert">
          {problem}
        </p>
      ) : null}

      {detail && state === "ready" ? (
        <>
          <div className="admin-modal__facts">
            <span>{joinApplicationStatusLabels[detail.status]}</span>
            <span>{detail.recruitmentCycle}</span>
            <span>{formatDateTime(detail.submittedAt)}</span>
            {detail.admittedDepartment ? (
              <span>
                {copy.review.admittedDepartment} ·{" "}
                {memberDepartmentLabels[detail.admittedDepartment]}
              </span>
            ) : null}
          </div>

          <div className="admin-section">
            <h3 className="admin-panel__title">{copy.detail.contacts}</h3>
            <p className="admin-status">
              QQ {detail.qq} · {detail.phone}
            </p>
            <div className="admin-email-row">
              <p className="admin-status">
                {copy.detail.notificationEmail} {detail.email ?? adminShared.none}
              </p>
              {detail.notification?.status === "SENDING" ? (
                <span className="admin-note">{copy.detail.emailSendingNote}</span>
              ) : (
                <>
                  {detail.notification?.status === "ACCEPTED" ||
                  detail.notification?.status === "UNCERTAIN" ? (
                    <span className="admin-note">{copy.detail.emailSentNote}</span>
                  ) : null}
                  <button
                    type="button"
                    className="admin-email-edit"
                    disabled={busy}
                    onClick={() => {
                      setProblem("");
                      setCorrecting(true);
                    }}
                  >
                    {copy.detail.editNotificationEmail}
                  </button>
                </>
              )}
            </div>
            <p className="admin-note">{copy.detail.contactsNote}</p>
          </div>

          <AccountNotificationStatusPanel
            applicationId={applicationId}
            notification={detail.notification}
            hasEmail={!!detail.email}
            provisionStatus={detail.provisionStatus}
            busy={busy}
            onChanged={(notification) =>
              setDetail((current) => (current ? { ...current, notification } : current))
            }
            onProblem={(text) => setToast({ text, tone: "neutral" })}
            onScheduled={() => setToast({ text: notificationCopy.scheduled, tone: "success" })}
          />

          {/* 学号与班级（issue #147）：历史报名未填写，逐项显示 `—`，不隐藏整段。 */}
          <div className="admin-section">
            <h3 className="admin-panel__title">{copy.detail.student}</h3>
            <p className="admin-status">
              {copy.detail.studentId} {detail.studentId || adminShared.none} ·{" "}
              {copy.detail.className} {detail.className || adminShared.none}
            </p>
          </div>

          <div className="admin-section">
            <h3 className="admin-panel__title">{copy.detail.selfIntroduction}</h3>
            <p className="admin-status">{detail.selfIntroduction || adminShared.none}</p>
          </div>

          <div className="admin-section">
            <h3 className="admin-panel__title">{copy.detail.preferredDirection}</h3>
            <p className="admin-status">{detail.preferredDirection || adminShared.none}</p>
          </div>

          {detail.applicantRemark ? (
            <div className="admin-section">
              <h3 className="admin-panel__title">{copy.detail.applicantRemark}</h3>
              <p className="admin-status">{detail.applicantRemark}</p>
            </div>
          ) : null}

          <div className="admin-section">
            <h3 className="admin-panel__title">{copy.detail.reviews}</h3>
            {detail.reviews.length === 0 ? (
              <p className="admin-note">{copy.detail.reviewsEmpty}</p>
            ) : (
              <ul className="admin-plain-list">
                {detail.reviews.map((review) => (
                  <li key={review.id}>
                    {review.result === "PASSED" ? copy.review.passed : copy.review.rejected} ·{" "}
                    {formatDateTime(review.interviewedAt)}
                    {review.internalNote ? ` · ${review.internalNote}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <form
            method="post"
            className="admin-form"
            onSubmit={submitReview}
            aria-label={copy.review.title}
          >
            <h3 className="admin-panel__title">{copy.review.title}</h3>
            <div className="admin-form__grid">
              <label className="field">
                <span className="field__label">{copy.review.result}</span>
                <select
                  className="field__input"
                  name="result"
                  value={reviewResult}
                  disabled={busy}
                  onChange={(event) => setReviewResult(event.target.value as InterviewResult)}
                >
                  <option value="PASSED">{copy.review.passed}</option>
                  <option value="REJECTED">{copy.review.rejected}</option>
                </select>
              </label>
              {reviewResult === "PASSED" && detail.status !== "INTERVIEW_PASSED" ? (
                <label className="field">
                  <span className="field__label">{copy.review.admittedDepartment}</span>
                  <select
                    className="field__input"
                    name="admittedDepartment"
                    value={admittedDepartment}
                    disabled={busy}
                    required
                    onChange={(event) =>
                      setAdmittedDepartment(event.target.value as MemberDepartment)
                    }
                  >
                    {memberDepartmentOptions.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="field">
                <span className="field__label">{copy.review.interviewedAt}</span>
                <input
                  className="field__input"
                  type="datetime-local"
                  name="interviewedAt"
                  disabled={busy}
                  value={interviewedAt}
                  onChange={(event) => setInterviewedAt(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span className="field__label">
                  {copy.review.internalNote}（{copy.review.optional}）
                </span>
                <input
                  className="field__input"
                  name="internalNote"
                  value={internalNote}
                  onChange={(event) => setInternalNote(event.target.value)}
                  maxLength={2000}
                  disabled={busy}
                />
              </label>
            </div>
            <div className="signup__actions">
              <Button type="submit" disabled={busy}>
                {busy ? adminShared.submitting : copy.review.submit}
              </Button>
            </div>
            {secret ? (
              <div role="status" aria-live="polite">
                <p className="admin-status">
                  <code>{secret}</code>
                </p>
                <p className="admin-note">{copy.review.secretNote}</p>
              </div>
            ) : null}
          </form>

          <div className="admin-section">
            <h3 className="admin-panel__title">{copy.provision.title}</h3>
            <p className="admin-status">
              {copy.provision.status}：{provisionStatusLabels[currentProvision]}
            </p>
            <p className="admin-note">{provisionHint(currentProvision)}</p>
            {currentProvision === "FAILED" ? (
              <div className="signup__actions">
                <Button disabled={busy} onClick={() => void runProvision(true)}>
                  {copy.provision.retry}
                </Button>
              </div>
            ) : null}
          </div>
          <div className="admin-section">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDeleteProblem("");
                setDeleting(true);
              }}
            >
              {copy.deletion.action}
            </Button>
          </div>
        </>
      ) : null}

      <div className="signup__actions">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {adminShared.close}
        </Button>
      </div>
    </AdminModal>
  );
}

function provisionHint(status: ProvisionStatus | string): string {
  const copy = adminCopy.recruitment.provision;
  if (status === "FAILED") return copy.failed;
  if (status === "SUCCEEDED") return copy.succeeded;
  if (status === "PENDING") return copy.pending;
  return copy.succeeded;
}

/**
 * 更正通知邮箱（issue #161）。
 *
 * 与详情共用同一个 `AdminModal`（切换内容，不叠第二层）—— 和成员详情
 * 「详情 → 重置弹层 → 返回」的处理一致。保存后由父组件把新邮箱与任务状态写回详情，
 * 不再整窗重载。
 */
function EmailCorrectionForm({
  applicationId,
  detail,
  onBack,
  onBusyChange,
  onSaved,
  onProblem,
}: {
  applicationId: string;
  detail: JoinApplicationDetail;
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
  onSaved: (result: JoinNotificationEmailCorrection) => void;
  onProblem: (text: string) => void;
}) {
  const copy = adminCopy.recruitment.emailCorrection;
  const status = detail.notification?.status ?? null;
  const hint = copy.hints[status ?? "NONE"];
  const blocked = status === "SENDING";
  const [email, setEmail] = useState(detail.email ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    onBusyChange(true);
    setProblem("");
    try {
      const result = await adminFetch<JoinNotificationEmailCorrection>(
        `/api/v1/admin/join-applications/${applicationId}/notification/email`,
        { method: "PATCH", body: { email } },
      );
      if (!result.ok) {
        const text =
          result.code === "STATE_TRANSITION_INVALID" ? copy.sendingBlocked : result.message;
        setProblem(text);
        onProblem(text);
        return;
      }
      onSaved(result.data);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <form method="post" className="admin-form" onSubmit={submit} aria-label={copy.title}>
      <p className="admin-status">
        {copy.current} {detail.email ?? adminShared.none}
      </p>
      <div className="admin-form__grid">
        <label className="field">
          <span className="field__label">{copy.newEmail}</span>
          <input
            className="field__input"
            type="email"
            name="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={EMAIL_MAX_LENGTH}
            autoComplete="off"
            autoFocus
            required
            disabled={busy || blocked}
          />
        </label>
      </div>
      {/* 已交发信服务 / 结果未知是风险提示，用错误态让管理员先停下来核查。 */}
      <p
        className={
          status === "ACCEPTED" || status === "UNCERTAIN"
            ? "admin-status admin-status--error"
            : "admin-note"
        }
      >
        {hint}
      </p>
      <p className="admin-note">{copy.auditNote}</p>
      {problem ? (
        <p className="admin-status admin-status--error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="signup__actions">
        <Button type="submit" variant="solid" disabled={busy || blocked}>
          {busy ? adminShared.submitting : copy.submit}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
          {copy.back}
        </Button>
      </div>
    </form>
  );
}

/**
 * 列表与导出**共用**的固定筛选参数。
 *
 * 导出的查询串必须与列表逐字一致（否则「导出的是另一批数据」），因此这两个入口共用
 * 这一个函数。拼装本身交给内核的 `listQueryParams`：空值不写、关键字去空白，
 * 参数顺序与迁移前一致。
 */
function filterParams(filters: typeof EMPTY_FILTERS, page: number): URLSearchParams {
  return listQueryParams(
    { page, pageSize: 20, query: filters.query, sort: [] },
    {
      fixed: {
        recruitmentCycle: filters.recruitmentCycle,
        status: filters.status,
        provisionStatus: filters.provisionStatus,
        submittedFrom: filters.submittedFrom,
        submittedTo: filters.submittedTo,
      },
    },
  );
}

function fileNameOf(response: Response): string | null {
  const header = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(header);
  return match ? match[1] : null;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { error?: { message?: string } };
    return json.error?.message ?? "导出失败，请稍后重试";
  } catch {
    return "导出失败，请稍后重试";
  }
}

/** 列表里的时间：`Asia/Shanghai` 的 `YYYY-MM-DD HH:mm`。报名资料需要完整日期。 */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `datetime-local` 的值 → ISO 时刻（与邀请码面板同一处理，避免偏移 8 小时）。 */
function toIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
