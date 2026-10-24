"use client";

import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { AdminModal } from "@/components/admin/AdminModal";
import { AdminToast, type AdminToastMessage } from "@/components/admin/AdminToast";
import {
  formatShanghaiDateTime,
  formatShanghaiTime,
} from "@/components/repair-activities/activity-format";
import { RegistrationPhone } from "@/components/repair-activities/RegistrationPhone";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { repairStatusLabels } from "@/config/repairs";
import { memberRepairActivitiesCopy, repairActivitiesPage } from "@/config/repair-activities";
import {
  activityEndExclusive,
  canOperateActivityStaff,
  sortQueueByCheckedInAt,
  type RepairActivityIssueType,
} from "@/features/repair-activities/repair-activity-validation";
import type {
  StaffBoardView,
  StaffRegistrationView,
  StaffServedRow,
  StaffPendingServe,
  ServeResultView,
  RevertServeResultView,
} from "@/features/repair-activities/repair-activity-staff-service";

type Props = { activityId: string };

/** 手机端一次只展示一个分区（<1100px；宽屏由 CSS 显示全部并排栏）。 */
type MobilePane = "eligible" | "queue" | "served";

/**
 * 页面级错误提示（改版第二轮·方案 A，用户看过低保真预览后选定）：
 * 固定视口顶部的浮条（Portal 到 body，与成功提示同款外观与位置；z-index 高于移动端顶栏与
 * 详情窗口）。不自动消失，被下一次操作清掉 / 覆盖 —— 与原先内联错误带的持久性一致。
 * 关键差异：不参与布局。原来工具行与卡片之间需要一条常驻预留带（3lh→2lh 后仍有 45.5px
 * 空白，用户反馈「还是过大」），浮条让那段间距只剩网格间距，卡片真正紧贴。
 * 管理员与成员共用本组件，两个视角一起生效。
 */
function BoardAlert({ message }: { message: string }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="activity-board__alert">
      <div className="card activity-board__alert-body" role="alert">
        <Icon name="close" />
        <p className="activity-board__alert-text">{message}</p>
      </div>
    </div>,
    document.body,
  );
}

export function MemberRepairActivityBoard({ activityId }: Props) {
  const router = useRouter();
  const copy = memberRepairActivitiesCopy.board;
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [board, setBoard] = useState<StaffBoardView | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [serverEnded, setServerEnded] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState<AdminToastMessage | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<StaffRegistrationView | null>(null);
  /** 撤销接待（issue #166）：确认弹层目标与在途标记。 */
  const [revertTarget, setRevertTarget] = useState<StaffServedRow | null>(null);
  const [revertBusy, setRevertBusy] = useState(false);
  const [checkInConfirmOpen, setCheckInConfirmOpen] = useState(false);
  const [checkInRows, setCheckInRows] = useState<StaffRegistrationView[]>([]);
  const [issueTypeDrafts, setIssueTypeDrafts] = useState<Record<string, RepairActivityIssueType>>(
    {},
  );
  const [checkInError, setCheckInError] = useState("");
  const checkInPending = useRef(false);
  const hasBoard = useRef(false);
  const boardElement = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef<{ x: number; y: number } | null>(null);
  const request = useRef<{ background: boolean } | null>(null);
  /** 全局接单拦截弹层（issue #79 第 6 项）：点击「接待」命中未完成草稿时出现，不发请求。 */
  const [pendingNotice, setPendingNotice] = useState<StaffPendingServe | null>(null);
  /** 出勤成员弹层（issue #107）：仅活动管理员，只读名单。 */
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  /**
   * 手机端分区切换（issue #108 审查稿）：<1100px 一次只展示一个分区。
   * 首次加载后落定默认分区（管理员优先「待签到」，成员固定「排队中」），
   * 之后保留用户点选，不因 5 秒刷新里数据变化自动跳转。
   */
  const [mobilePane, setMobilePane] = useState<MobilePane | null>(null);
  const paused =
    busy !== null ||
    checkInConfirmOpen ||
    withdrawTarget !== null ||
    revertTarget !== null ||
    pendingNotice !== null ||
    attendanceOpen;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = useCallback(
    async (background = false): Promise<StaffBoardView | null> => {
      if (background && (pausedRef.current || request.current)) return null;
      // 用请求身份丢弃过期响应；清理 effect 时不主动 abort，避免开发模式报取消异常。
      const active = { background };
      request.current = active;
      if (!background) setMessage("");
      try {
        const response = await fetch(`/api/v1/member/repair-activities/${activityId}/board`, {
          cache: "no-store",
        });
        const json = (await response.json()) as {
          success: boolean;
          data?: StaffBoardView;
          error?: { message?: string };
        };
        if (request.current !== active) return null;
        if (background && (pausedRef.current || document.visibilityState !== "visible"))
          return null;
        if (!response.ok || !json.success || !json.data) {
          throw new Error(json.error?.message ?? copy.loadFailed);
        }
        if (hasBoard.current && boardElement.current) {
          scrollPosition.current = { x: window.scrollX, y: window.scrollY };
          // 列表缩短时保留原高度，避免浏览器先把滚动位置夹回页首。
          if (window.scrollY > 0) {
            boardElement.current.style.minHeight = `${boardElement.current.getBoundingClientRect().height}px`;
          }
        }
        const next = json.data;
        setBoard(next);
        setClock(Date.now());
        // 粘滞：写请求或前一次 GET 已判定结束的活动不会「复活」，避免一次旧快照
        // 把结束态与 60 秒节拍重置回可用状态（换活动时由 effect 显式清零）。
        setServerEnded((ended) => ended || next.activity.status === "ENDED");
        hasBoard.current = true;
        // 首次加载落定手机端默认分区；已有选择（用户点过）保持不变。
        setMobilePane(
          (current) =>
            current ?? (next.canAdmin && next.eligible.length > 0 ? "eligible" : "queue"),
        );
        const eligibleIds = new Set(next.eligible.map((row) => row.id));
        setSelected((current) => new Set([...current].filter((id) => eligibleIds.has(id))));
        setState("ready");
        return next;
      } catch (error) {
        if (request.current !== active) return null;
        // 自动同步失败保留数据与操作反馈，下一轮继续重试。
        if (background && hasBoard.current) return null;
        if (hasBoard.current) {
          setMessage(copy.refreshFailed);
        } else {
          setState("error");
          setMessage(error instanceof Error ? error.message : copy.loadFailed);
        }
        return null;
      } finally {
        if (request.current === active) request.current = null;
      }
    },
    [activityId, copy.loadFailed, copy.refreshFailed],
  );

  useEffect(() => {
    void load();
    const onResize = () => {
      if (boardElement.current) boardElement.current.style.minHeight = "";
    };
    window.addEventListener("resize", onResize);
    return () => {
      request.current = null;
      window.removeEventListener("resize", onResize);
    };
  }, [load]);

  // 换一场活动 = 重新落定默认分区（同一组件实例被复用时旧选择不跨活动保留）。
  useEffect(() => {
    setMobilePane(null);
    setServerEnded(false);
  }, [activityId]);

  useEffect(() => {
    if (paused && request.current?.background) request.current = null;
    const refresh = () => {
      // 弹层内暂停取数，但仍用原有节拍更新操作窗口，不能让旧确认窗越过结束时间。
      setClock(Date.now());
      if (document.visibilityState === "visible") void load(true);
    };
    refresh();
    // 结束后接待台通常只剩查看/纠错：节拍降到 60 秒，减少无谓的看板 GET；
    // `serverEnded` 变化会重建本 effect，并立即 refresh 一次完成收尾。
    const timer = window.setInterval(refresh, serverEnded ? 60_000 : 5_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, paused, serverEnded]);

  useLayoutEffect(() => {
    const position = scrollPosition.current;
    scrollPosition.current = null;
    if (position && (window.scrollX !== position.x || window.scrollY !== position.y)) {
      window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
    }
  }, [board]);

  async function postJson<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: true; data: T } | { ok: false; message: string; code?: string }> {
    // 写请求开始时使旧的读取失效，不能让提交前的快照覆盖操作结果。
    request.current = null;
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await response.json()) as {
        success: boolean;
        data?: T;
        error?: { message?: string; code?: string };
      };
      if (!json.success || json.data === undefined) {
        if (json.error?.code === "ACTIVITY_ENDED") {
          setServerEnded(true);
          setClock(Date.now());
        }
        return {
          ok: false,
          message:
            json.error?.code === "ACTIVITY_ENDED"
              ? copy.activityEnded
              : (json.error?.message ?? copy.loadFailed),
          code: json.error?.code,
        };
      }
      return { ok: true, data: json.data };
    } catch {
      return { ok: false, message: copy.loadFailed };
    }
  }

  /**
   * 操作窗口的即时判定：渲染态用 5 秒节拍的 `clock`，这里必须用实时时间 ——
   * 确认窗可能在两次节拍之间跨过结束点，写操作必须按当前时刻复核（不要改成 `clock`）。
   */
  function blockedStaffMessage(): string | null {
    if (!board) return copy.loadFailed;
    const now = new Date();
    if (
      serverEnded ||
      board.activity.status === "ENDED" ||
      now.getTime() >= activityEndExclusive(new Date(board.activity.activityAt)).getTime()
    ) {
      return copy.activityEnded;
    }
    return canOperateActivityStaff(board.activity, now) ? null : copy.signupNotClosed;
  }

  function allowStaffAction(): boolean {
    const blocked = blockedStaffMessage();
    if (!blocked) return true;
    setClock(Date.now());
    setMessage(blocked);
    return false;
  }

  async function attend() {
    if (busy !== null || !allowStaffAction()) return;
    setBusy("attend");
    setToast(null);
    const result = await postJson<{ attended: boolean }>(
      `/api/v1/member/repair-activities/${activityId}/attendance`,
      {},
    );
    setBusy(null);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setToast({ text: copy.attendSuccess, tone: "success" });
    await load();
  }

  function openCheckInConfirm() {
    if (busy !== null || checkInPending.current || !allowStaffAction()) return;
    const rows = board?.eligible.filter((row) => selected.has(row.id)) ?? [];
    if (rows.length === 0) {
      setMessage(copy.selectNone);
      return;
    }
    // 勾选达标、继续走确认弹窗：把「请先勾选…」浮条清掉，避免错误提示滞留。
    setMessage("");
    setCheckInRows(rows);
    setIssueTypeDrafts(Object.fromEntries(rows.map((row) => [row.id, row.issueType])));
    setCheckInError("");
    setCheckInConfirmOpen(true);
  }

  function closeCheckInConfirm() {
    if (checkInPending.current) return;
    setCheckInConfirmOpen(false);
    setCheckInRows([]);
    setIssueTypeDrafts({});
    setCheckInError("");
  }

  async function confirmCheckIn() {
    if (checkInPending.current || busy !== null || checkInRows.length === 0) return;
    const blocked = blockedStaffMessage();
    if (blocked) {
      setClock(Date.now());
      setCheckInError(blocked);
      return;
    }
    checkInPending.current = true;
    setBusy("check-in");
    setToast(null);
    setMessage("");
    setCheckInError("");
    const issueTypeUpdates = checkInRows
      .filter((row) => issueTypeDrafts[row.id] !== row.issueType)
      .map((row) => ({ registrationId: row.id, issueType: issueTypeDrafts[row.id] }));
    const result = await postJson<{ checkedIn: StaffRegistrationView[] }>(
      `/api/v1/member/repair-activities/${activityId}/check-in`,
      {
        registrationIds: checkInRows.map((row) => row.id),
        ...(issueTypeUpdates.length ? { issueTypeUpdates } : {}),
      },
    );
    if (!result.ok) {
      setCheckInError(result.message);
      checkInPending.current = false;
      setBusy(null);
      return;
    }
    setCheckInConfirmOpen(false);
    setCheckInRows([]);
    setIssueTypeDrafts({});
    setSelected(new Set());
    // 即使后续刷新失败，也展示已经提交成功的队列及其保存后的类型。
    setBoard((current) => {
      if (!current) return current;
      const savedIds = new Set(result.data.checkedIn.map((row) => row.id));
      return {
        ...current,
        eligible: current.eligible.filter((row) => !savedIds.has(row.id)),
        queue: sortQueueByCheckedInAt([
          ...current.queue.filter((row) => !savedIds.has(row.id)),
          ...result.data.checkedIn,
        ]),
      };
    });
    setToast({
      text: issueTypeUpdates.length ? copy.checkInUpdatedSuccess : copy.checkInSuccess,
      tone: "success",
    });
    const fresh = await load();
    if (!fresh) setMessage(copy.checkInRefreshFailed);
    checkInPending.current = false;
    setBusy(null);
  }

  async function confirmWithdraw() {
    if (!withdrawTarget) return;
    const registrationId = withdrawTarget.id;
    setBusy(`withdraw:${registrationId}`);
    setToast(null);
    setMessage("");
    const result = await postJson<StaffRegistrationView>(
      `/api/v1/member/repair-activities/${activityId}/withdraw`,
      { registrationId },
    );
    setBusy(null);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setWithdrawTarget(null);
    setToast({ text: copy.withdrawSuccess, tone: "neutral" });
    await load();
  }

  async function serve(registrationId: string) {
    if (busy !== null || !allowStaffAction()) return;
    setBusy(`serve:${registrationId}`);
    setToast(null);
    setMessage("");
    const result = await postJson<ServeResultView>(
      `/api/v1/member/repair-activities/${activityId}/serve`,
      { registrationId },
    );
    setBusy(null);
    if (!result.ok) {
      if (result.code === "ACTIVITY_SERVE_PENDING") {
        // 服务端兜底（多标签 / 并发）：先刷新看板，再按最新的未建单接待弹层；
        // 刷新后若已无待补建（例如另一标签刚提交），退回内联提示。
        const fresh = await load();
        if (fresh?.pendingServeRegistration) setPendingNotice(fresh.pendingServeRegistration);
        else setMessage(result.message);
        return;
      }
      setMessage(result.message);
      return;
    }
    setToast({ text: copy.serveSuccess, tone: "success" });
    await load();
  }

  /** 撤销接待（issue #166）：仅接待者本人 / 活动管理员可见按钮，服务端再校一遍。 */
  async function confirmRevertServe() {
    if (!revertTarget || revertBusy) return;
    setRevertBusy(true);
    setToast(null);
    const result = await postJson<RevertServeResultView>(
      `/api/v1/member/repair-activities/${activityId}/revert-serve`,
      { registrationId: revertTarget.id },
    );
    setRevertBusy(false);
    setRevertTarget(null);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setToast({ text: copy.revertServeSuccess, tone: "neutral" });
    await load();
  }

  /** 点击「接待」：先看客户端已加载的待补建接待，非空则弹层且**不发请求**（issue #221）。 */
  function requestServe(registrationId: string) {
    if (!allowStaffAction()) return;
    if (board?.pendingServeRegistration) {
      setPendingNotice(board.pendingServeRegistration);
      return;
    }
    void serve(registrationId);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * 页头（issue #107 后续改版）：小标签 + 活动名主标题 + 日期行。
   * 活动名来自看板数据，加载中就绪前先用「活动工作台」占位。
   */
  function renderHead(title: string, meta?: string) {
    return (
      <header className="member-page-head activity-board__head">
        <p className="member-section__tag">{copy.label}</p>
        <h1 className="sec-title" id="member-activity-board-title">
          {title}
        </h1>
        {meta ? <p className="activity-board__meta">{meta}</p> : null}
      </header>
    );
  }

  if (state === "loading") {
    return (
      <div className="activity-board activity-board--loading">
        {renderHead(copy.title)}
        <p className="muted" role="status">
          {copy.loading}
        </p>
      </div>
    );
  }
  if (state === "error" || !board) {
    return (
      <div className="activity-board">
        {renderHead(copy.title)}
        <p className="admin-status admin-status--error" role="alert">
          {message || copy.loadFailed}
        </p>
        <Button href="/member/repair-activities" variant="ghost">
          {copy.back}
        </Button>
      </div>
    );
  }

  const ended =
    serverEnded ||
    board.activity.status === "ENDED" ||
    clock >= activityEndExclusive(new Date(board.activity.activityAt)).getTime();
  const staffOpen = !ended && canOperateActivityStaff(board.activity, new Date(clock));
  // 结束时只更新原提示；已出勤且无提示卡的看板用浮层，不能把整板向下挤。
  const showAttendBanner =
    clock < new Date(board.activity.signupClosesAt).getTime() || !board.attended;
  const floatingMessage = message || (ended && !showAttendBanner ? copy.activityEnded : "");
  const opsDisabled = !staffOpen || !board.attended || busy !== null;
  const withdrawBusy = withdrawTarget ? busy === `withdraw:${withdrawTarget.id}` : false;
  const checkInBusy = busy === "check-in";
  // 手机端切换项（与 panes 的可见性一致：成员没有「待签到」）。
  const mobilePanes: Array<[MobilePane, string, number]> = board.canAdmin
    ? [
        ["eligible", copy.eligibleTitle, board.eligible.length],
        ["queue", copy.queueTitle, board.queue.length],
        ["served", copy.servedTitle, board.served.length],
      ]
    : [
        ["queue", copy.queueTitle, board.queue.length],
        ["served", copy.servedTitle, board.served.length],
      ];
  // 滑块位置：与 mobilePanes 顺序一致；理论上必有匹配，找不到时回落到第一段。
  const activeIndex = Math.max(
    0,
    mobilePanes.findIndex(([key]) => key === mobilePane),
  );

  return (
    <div ref={boardElement} className="activity-board content-start">
      {renderHead(board.activity.title, formatShanghaiDateTime(board.activity.activityAt))}
      <div className="activity-board__toolbar">
        <Button href="/member/repair-activities" variant="ghost">
          {copy.back}
        </Button>
        {board.attended ? (
          <span className="admin-tag admin-tag--accent">{copy.attendedBadge}</span>
        ) : (
          <Button
            className="activity-board__attend-cta"
            variant="solid"
            onClick={() => void attend()}
            disabled={!staffOpen || busy !== null}
          >
            {busy === "attend" ? copy.attending : copy.attendCta}
          </Button>
        )}
        {/* 出勤成员入口（issue #107）：仅活动管理员可见，人数实时取自看板数据。
            放在工具栏尾部靠右（CSS 的 auto 外边距），不与返回 / 出勤按钮抢行。 */}
        {board.canAdmin ? (
          <Button
            className="activity-board__attendance-entry"
            variant="ghost"
            trailingIcon="chevronRight"
            onClick={() => setAttendanceOpen(true)}
          >
            {copy.attendanceEntry.replace("{count}", String(board.attendanceMembers.length))}
          </Button>
        ) : null}
      </div>

      {showAttendBanner ? (
        <Card className="activity-board__attend-banner" variant="notice">
          <p role="status">
            {ended
              ? copy.activityEnded
              : staffOpen
                ? board.canAdmin
                  ? copy.attendPrompt
                  : copy.attendPromptMember
                : copy.signupNotClosed}
          </p>
        </Card>
      ) : null}
      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
      {/* 页面级错误 = 浮动提示（方案 A）：不占布局，工具行与卡片之间只剩网格间距。 */}
      {floatingMessage ? <BoardAlert message={floatingMessage} /> : null}

      {/* 手机端分区切换（issue #108 审查稿·分段滑块）：窄屏一次只显示一个分区、切换行吸顶；
          宽屏由 CSS 隐藏，恢复并排栏。计数实时来自看板数据、放在段内（等宽段不因数字变化位移）。 */}
      <div className="activity-board__switcher" role="group" aria-label={copy.paneSwitcherLabel}>
        <div
          className="activity-board__seg"
          style={{ "--seg-count": mobilePanes.length, "--seg-index": activeIndex } as CSSProperties}
        >
          <span className="activity-board__seg-thumb" aria-hidden="true" />
          {mobilePanes.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              className="activity-board__seg-btn"
              aria-pressed={mobilePane === key}
              onClick={() => setMobilePane(key)}
            >
              {label}
              <span className="activity-board__seg-count">{count}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        className={`activity-board__panes ${board.canAdmin ? "activity-board__panes--admin" : ""}`}
      >
        {/* 待签到（issue #108）：仅活动管理员可见；成员的看板在服务端就不下发这批数据。 */}
        {board.canAdmin ? (
          <Card
            className={`activity-board__pane repair-panel ${
              mobilePane === "eligible" ? "is-active" : ""
            }`}
          >
            <header className="activity-board__pane-head">
              <h2>
                {copy.eligibleTitle}
                <span className="activity-board__pane-count">{board.eligible.length}</span>
              </h2>
              <span className="member-section__tag">{copy.eligibleTag}</span>
            </header>
            {board.eligible.length === 0 ? (
              <p className="muted activity-board__empty">{copy.eligibleEmpty}</p>
            ) : (
              <ul className="activity-board__list">
                {board.eligible.map((row) => (
                  <li key={row.id} className="activity-board__row">
                    <div className="activity-board__check">
                      <input
                        type="checkbox"
                        id={`registration-${row.id}`}
                        checked={selected.has(row.id)}
                        disabled={opsDisabled}
                        aria-label={`${copy.name} ${row.name}`}
                        onChange={() => toggle(row.id)}
                      />
                      <span>
                        <label htmlFor={`registration-${row.id}`}>
                          <strong>{row.name}</strong>
                        </label>
                        <span className="activity-board__check-meta">
                          {" "}
                          ·{" "}
                          <RegistrationPhone
                            key={`${activityId}:${row.id}:${row.phoneMasked}`}
                            activityId={activityId}
                            registrationId={row.id}
                            phoneMasked={row.phoneMasked}
                            onError={setMessage}
                          />{" "}
                          · {row.issueTypeLabel}
                          {/* 机型选填：没填就不占位（issue #68）。 */}
                          {row.deviceModel ? ` · ${copy.deviceModel} ${row.deviceModel}` : null}
                        </span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="activity-board__actions">
              <p className="muted m-0">{copy.selectHint}</p>
              <Button
                variant="solid"
                onClick={openCheckInConfirm}
                disabled={opsDisabled || selected.size === 0}
              >
                {busy === "check-in" ? copy.checkingIn : copy.checkIn}
              </Button>
            </div>
          </Card>
        ) : null}

        <Card
          className={`activity-board__pane repair-panel ${
            mobilePane === "queue" ? "is-active" : ""
          }`}
        >
          <header className="activity-board__pane-head">
            <h2>
              {copy.queueTitle}
              <span className="activity-board__pane-count activity-board__pane-count--queue">
                {board.queue.length}
              </span>
            </h2>
            <span className="member-section__tag">{copy.queueTag}</span>
          </header>
          {board.queue.length === 0 ? (
            <p className="muted activity-board__empty">
              {board.canAdmin ? copy.queueEmpty : copy.queueEmptyMember}
            </p>
          ) : (
            <ul className="activity-board__list">
              {board.queue.map((row, index) => (
                <li key={row.id} className="activity-board__row activity-board__row--queue">
                  {/* 三区（改版）：姓名信息区（位次 + 姓名 + 联系方式）→ 故障详情区
                      （故障类型 / 入队时间 / 机型 分行）→ 操作区沉底（不再与正文抢宽）。 */}
                  <div className="activity-board__queue-main">
                    {/* 队列位次：按当前渲染顺序从 1 开始（服务端已按签到时间升序）。 */}
                    <span className="activity-board__queue-rank">
                      {copy.queueRank.replace("{index}", String(index + 1))}
                    </span>
                    <div>
                      <strong>{row.name}</strong>
                      <div className="activity-board__queue-line">
                        <span className="activity-board__queue-label">{copy.phone}</span>
                        <span className="activity-board__queue-value">{row.phoneMasked}</span>
                      </div>
                      <div className="activity-board__queue-line">
                        <span className="activity-board__queue-label">{copy.issueType}</span>
                        <span className="activity-board__queue-value">{row.issueTypeLabel}</span>
                      </div>
                      {row.checkedInAt ? (
                        <div className="activity-board__queue-line">
                          <span className="activity-board__queue-label">{copy.checkedInAt}</span>
                          <span className="activity-board__queue-value">
                            {formatShanghaiDateTime(row.checkedInAt)}
                          </span>
                        </div>
                      ) : null}
                      {row.deviceModel ? (
                        <div className="activity-board__queue-line">
                          <span className="activity-board__queue-label">{copy.deviceModel}</span>
                          <span className="activity-board__queue-value">{row.deviceModel}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="activity-board__row-actions activity-board__row-actions--foot">
                    {/* 接待=描边主行动（issue #108 审查稿，改版后保留）：细蓝描边 + 右向箭头，
                        悬停填充实心；比原实心大块轻，队列一屏多行不吵。 */}
                    <Button
                      className="activity-board__serve-btn"
                      trailingIcon="arrowRight"
                      onClick={() => requestServe(row.id)}
                      disabled={opsDisabled}
                    >
                      {busy === `serve:${row.id}` ? copy.serving : copy.serve}
                    </Button>
                    {/* 「撤回」仅活动管理员（issue #108 评论 3）：成员视角不出现；
                        服务端 withdraw 同样要求 activity:admin 兜底。
                        幽灵 + Undo 图标，悬停转危险色（issue #108 审查稿）。 */}
                    {board.canAdmin ? (
                      <Button
                        variant="ghost"
                        className="activity-board__withdraw-btn"
                        icon="undo"
                        onClick={() => setWithdrawTarget(row)}
                        disabled={!board.attended || busy !== null}
                      >
                        {busy === `withdraw:${row.id}` ? copy.withdrawing : copy.withdraw}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 「已接待」= 常驻区块（issue #79 第 6 项；issue #108 起作为成员两栏 / 管理员三栏的
            最后一栏，按 servedAt 降序）：数据为空只换内容，区块本身不出现 / 消失。 */}
        <Card
          className={`activity-board__pane repair-panel ${
            mobilePane === "served" ? "is-active" : ""
          }`}
        >
          <header className="activity-board__pane-head">
            <h2>
              {copy.servedTitle}
              <span className="activity-board__pane-count">{board.served.length}</span>
            </h2>
            <span className="member-section__tag">{copy.servedTag}</span>
          </header>
          {board.served.length === 0 ? (
            <p className="muted activity-board__empty">
              {board.canAdmin ? copy.servedEmpty : copy.servedEmptySelf}
            </p>
          ) : (
            <ul className="activity-board__list">
              {board.served.map((row) => {
                const recordId = row.repairRecordId;
                // 待补建（issue #221）：接待已占位、维修单还没创建。
                const pendingRecord = recordId === null;
                return (
                  <li key={row.id} className="activity-board__row">
                    <div className="activity-board__queue-main">
                      <div>
                        <strong>{row.name}</strong>{" "}
                        {pendingRecord ? (
                          <span className="admin-tag">{copy.servedPendingTag}</span>
                        ) : row.recordStatus ? (
                          <span className="admin-tag">{repairStatusLabels[row.recordStatus]}</span>
                        ) : null}
                        {pendingRecord ? (
                          <p className="muted m-0">{copy.servedPendingHint}</p>
                        ) : null}
                        <div className="activity-board__queue-line">
                          <span className="activity-board__queue-label">{copy.phone}</span>
                          <RegistrationPhone
                            key={`${activityId}:${row.id}:${row.phoneMasked}`}
                            activityId={activityId}
                            registrationId={row.id}
                            phoneMasked={row.phoneMasked}
                            onError={setMessage}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="activity-board__row-actions">
                      {row.canRevert ? (
                        <Button variant="ghost" onClick={() => setRevertTarget(row)}>
                          {copy.revertServe}
                        </Button>
                      ) : null}
                      {pendingRecord ? (
                        row.canFill ? (
                          <Button
                            href={`/member/repairs/new?activityId=${encodeURIComponent(activityId)}&registrationId=${encodeURIComponent(row.id)}`}
                          >
                            {copy.continueFill}
                          </Button>
                        ) : (
                          <span className="muted">{copy.servedPendingByOwner}</span>
                        )
                      ) : !recordId || !row.recordStatus ? (
                        // 记录缺失或已软删除：占位文案，不出链接。
                        <span className="muted">{copy.recordMissing}</span>
                      ) : row.recordStatus === "DRAFT" || row.recordStatus === "REJECTED" ? (
                        <Button
                          href={`/member/repairs/${recordId}/edit?returnActivityId=${encodeURIComponent(activityId)}`}
                        >
                          {copy.fillRepair}
                        </Button>
                      ) : (
                        <Button
                          className="activity-board__view-btn"
                          href={`/member/repairs/${recordId}`}
                        >
                          {copy.viewRepair}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {checkInConfirmOpen ? (
        <ConfirmDialog
          title={copy.checkInConfirmTitle}
          cancelLabel={copy.checkInCancel}
          confirmLabel={checkInBusy ? copy.checkingIn : copy.checkInConfirm}
          busy={checkInBusy}
          confirmDisabled={!staffOpen}
          onClose={closeCheckInConfirm}
          onConfirm={() => void confirmCheckIn()}
        >
          <p>{copy.checkInConfirmHint}</p>
          <ol className="activity-board__list">
            {checkInRows.map((row, index) => (
              <li key={row.id} className="activity-board__row">
                <div>
                  <span className="text-ink-3 text-xs">{index + 1}. </span>
                  <strong>{row.name}</strong> · {row.phoneMasked}
                </div>
                {row.deviceModel ? (
                  <p className="muted m-0">
                    {copy.deviceModel} {row.deviceModel}
                  </p>
                ) : null}
                <div className="field">
                  <label className="field__label" htmlFor={`check-in-issue-${row.id}`}>
                    {row.name} · {copy.issueType}
                  </label>
                  <select
                    id={`check-in-issue-${row.id}`}
                    className="field__input"
                    value={issueTypeDrafts[row.id]}
                    disabled={checkInBusy || !staffOpen}
                    onChange={(event) => {
                      if (checkInPending.current) return;
                      const issueType = event.target.value as RepairActivityIssueType;
                      setIssueTypeDrafts((drafts) => ({ ...drafts, [row.id]: issueType }));
                    }}
                  >
                    {repairActivitiesPage.issueTypes.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            ))}
          </ol>
          <p className="admin-status activity-board__feedback" role="alert">
            {checkInError}
          </p>
        </ConfirmDialog>
      ) : null}

      {withdrawTarget ? (
        <ConfirmDialog
          title={copy.withdrawConfirmTitle}
          cancelLabel={copy.withdrawCancel}
          confirmLabel={withdrawBusy ? copy.withdrawing : copy.withdrawConfirm}
          busy={withdrawBusy}
          onClose={() => {
            if (!withdrawBusy) setWithdrawTarget(null);
          }}
          onConfirm={() => void confirmWithdraw()}
        >
          <p>{copy.withdrawConfirmHint}</p>
          <p>
            <strong>
              {withdrawTarget.name} · {withdrawTarget.phoneMasked}
            </strong>
          </p>
        </ConfirmDialog>
      ) : null}

      {revertTarget ? (
        <ConfirmDialog
          title={copy.revertServeConfirmTitle}
          cancelLabel={copy.revertServeCancel}
          confirmLabel={revertBusy ? copy.revertingServe : copy.revertServeConfirm}
          busy={revertBusy}
          onClose={() => {
            if (!revertBusy) setRevertTarget(null);
          }}
          onConfirm={() => void confirmRevertServe()}
        >
          <p>
            {revertTarget.repairRecordId
              ? copy.revertServeConfirmHintLegacy
              : copy.revertServeConfirmHint}
          </p>
          <p>
            <strong>
              {revertTarget.name} · {revertTarget.phoneMasked}
            </strong>
          </p>
        </ConfirmDialog>
      ) : null}

      {pendingNotice ? (
        <ConfirmDialog
          title={copy.pendingServeTitle}
          cancelLabel={copy.pendingServeDismiss}
          confirmLabel={copy.pendingServeFill}
          onClose={() => setPendingNotice(null)}
          onConfirm={() => {
            router.push(
              `/member/repairs/new?activityId=${encodeURIComponent(pendingNotice.activityId)}&registrationId=${encodeURIComponent(pendingNotice.registrationId)}`,
            );
          }}
        >
          <p>
            {copy.pendingServeBody
              .replace("{owner}", pendingNotice.name)
              .replace("{activity}", pendingNotice.activityTitle)}
          </p>
          <p className="admin-note">{copy.pendingServeUndoHint}</p>
        </ConfirmDialog>
      ) : null}

      {/* 出勤成员名单（issue #107）：只读弹层，沿用后台详情窗口；桌面两列、
          人多时由弹窗正文内部滚动，页面高度不随之变化。 */}
      {attendanceOpen ? (
        <AdminModal
          title={copy.attendanceTitle}
          subtitle={`${board.activity.title} · ${formatShanghaiDateTime(board.activity.activityAt)}`}
          onClose={() => setAttendanceOpen(false)}
        >
          {board.attendanceMembers.length === 0 ? (
            <p className="muted m-0">{copy.attendanceEmpty}</p>
          ) : (
            <ul className="activity-board__attendance-list">
              {board.attendanceMembers.map((row) => (
                <li key={row.memberProfileId} className="activity-board__attendance-row">
                  <span className="activity-board__attendance-name">{row.name}</span>
                  <span className="activity-board__attendance-time">
                    {copy.attendanceCheckedInAt.replace(
                      "{time}",
                      formatShanghaiTime(row.checkedInAt),
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="admin-note">{copy.attendanceNote}</p>
        </AdminModal>
      ) : null}
    </div>
  );
}
