"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  formatShanghaiDateTime,
  signupCountdownParts,
} from "@/components/repair-activities/activity-format";
import { AdminToast, type AdminToastMessage } from "@/components/admin/AdminToast";
import { repairActivityStatusBadgeClass } from "@/components/repair-activities/activity-status-badge";
import { RepairActivityPrecautions } from "@/components/repair-activities/RepairActivityPrecautions";
import { RepairActivityPreparation } from "@/components/repair-activities/RepairActivityPreparation";
import { RepairActivityQueue } from "@/components/repair-activities/RepairActivityQueue";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { repairActivitiesPage } from "@/config/repair-activities";
import {
  canAcceptNewRegistration,
  REPAIR_ACTIVITY_DEVICE_MODEL_MAX_LENGTH,
  repairActivityIssueTypeLabels,
  repairActivityStatusLabels,
  type RepairActivityIssueType,
  type RepairActivityStatus,
} from "@/features/repair-activities/repair-activity-validation";
import type {
  RegistrationLookupView,
  RepairActivityPublicView,
} from "@/features/repair-activities/repair-activity-service";

import styles from "./RepairActivityDetail.module.css";

type Props = { activityId: string };

export function RepairActivityDetail({ activityId }: Props) {
  const copy = repairActivitiesPage.detail;
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [activity, setActivity] = useState<RepairActivityPublicView | null>(null);
  /** 服务器时间与本机时间之差：倒计时以服务器为准，避免本机时钟偏差。 */
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState<AdminToastMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [signupSucceeded, setSignupSucceeded] = useState(false);
  const [lookup, setLookup] = useState<RegistrationLookupView | null>(null);
  const [lookupPhone, setLookupPhone] = useState("");
  /** 待确认的表单内容；成功后保留弹层，关闭注意事项提醒时一并清除。 */
  const [pendingSignup, setPendingSignup] = useState<{
    name: string;
    phone: string;
    issueType: string;
    deviceModel: string;
  } | null>(null);
  const signupFormRef = useRef<HTMLFormElement>(null);
  const request = useRef<{ background: boolean; controller: AbortController } | null>(null);

  /**
   * `background` = 倒计时驱动的自动重取：传输 / 服务端瞬时失败时保留已渲染内容，
   * 不把整块切成错误态；活动确实结束（ENDED / 404）仍照常切换。
   */
  const load = useCallback(
    async (background = false) => {
      if (background && (document.visibilityState !== "visible" || request.current)) return;
      // 写入后的刷新可替换旧轮询，旧结果不能覆盖报名成功后的状态。
      request.current?.controller.abort();
      const active = { background, controller: new AbortController() };
      request.current = active;
      if (!background) setProblem("");
      try {
        const response = await fetch(`/api/v1/repair-activities/${activityId}`, {
          signal: active.controller.signal,
        });
        // HTTP Date 头就是服务器此刻的时间（秒级）：用它校正倒计时基准。
        const serverDate = Date.parse(response.headers.get("Date") ?? "");
        const json = (await response.json()) as {
          success: boolean;
          data?: RepairActivityPublicView;
          error?: { code?: string; message?: string };
        };
        if (request.current !== active) return;
        if (background && document.visibilityState !== "visible") return;
        if (Number.isFinite(serverDate)) setServerOffsetMs(serverDate - Date.now());
        if (!json.success || !json.data) {
          const ended = json.error?.code === "ACTIVITY_ENDED" || response.status === 404;
          if (background && !ended) return;
          if (ended) {
            setState("missing");
            setProblem(json.error?.message ?? "活动已结束");
            return;
          }
          setState("error");
          setProblem(json.error?.message ?? "加载失败");
          return;
        }
        setActivity(json.data);
        setState("ready");
      } catch {
        if (request.current !== active) return;
        if (background) return;
        setState("error");
        setProblem("加载失败，请稍后重试");
      } finally {
        if (request.current === active) request.current = null;
      }
    },
    [activityId],
  );

  useEffect(() => {
    setState("loading");
    setActivity(null);
    void load();
    return () => {
      const active = request.current;
      request.current = null;
      active?.controller.abort();
    };
  }, [load]);

  /** 报名未开始时每秒走一格倒计时；状态一旦离开 UPCOMING 就停表。 */
  useEffect(() => {
    if (activity?.status !== "UPCOMING") return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity?.status]);

  const signupOpensAtMs = activity ? Date.parse(activity.signupOpensAt) : Number.NaN;
  const countdownMs = Number.isFinite(signupOpensAtMs)
    ? signupOpensAtMs - (nowMs + serverOffsetMs)
    : Number.POSITIVE_INFINITY;
  const waitingForOpen = activity?.status === "UPCOMING" && countdownMs <= 0;

  /**
   * 倒计时归零：立刻重取活动状态（服务端按自己的时钟判定 OPEN / FULL / CLOSED）。
   * 仍显示未开始就每 30 秒重试，满足「无需手动刷新」—— 可能是本机与服务器时钟略有偏差。
   */
  useEffect(() => {
    if (!waitingForOpen) return;
    const refresh = () => void load(true);
    const visibility = () => {
      if (document.visibilityState === "visible") refresh();
      else if (request.current?.background) {
        const active = request.current;
        request.current = null;
        active.controller.abort();
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [waitingForOpen, load]);

  /** 倒计时归零转为可报名时，给读屏一次性播报（数字块本身不进入 live region）。 */
  const prevStatusRef = useRef<RepairActivityStatus | null>(null);
  const [openedNotice, setOpenedNotice] = useState(false);
  useEffect(() => {
    const current = activity?.status ?? null;
    if (
      prevStatusRef.current === "UPCOMING" &&
      current !== null &&
      current !== "UPCOMING" &&
      canAcceptNewRegistration(current)
    ) {
      setOpenedNotice(true);
    }
    prevStatusRef.current = current;
  }, [activity?.status]);

  /** 填好表单 → 先弹免责声明，不直接提交。 */
  function requestSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem("");
    setNotice(null);
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPendingSignup({
      name: data.name ?? "",
      phone: data.phone ?? "",
      issueType: data.issueType ?? "",
      deviceModel: data.deviceModel ?? "",
    });
  }

  /** 弹层里点过「我已阅读并同意」之后才真正提交。 */
  async function confirmSignup() {
    if (!pendingSignup) return;
    setBusy(true);
    setProblem("");
    setNotice(null);
    try {
      const response = await fetch(`/api/v1/repair-activities/${activityId}/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...pendingSignup, consentAccepted: true }),
      });
      const json = (await response.json()) as {
        success: boolean;
        error?: { message?: string };
      };
      if (!json.success) {
        // 失败要让报名者看得见原因，而错误提示在弹层后面 —— 先关弹层再报错。
        setPendingSignup(null);
        setProblem(json.error?.message ?? "报名失败");
      } else {
        setSignupSucceeded(true);
        signupFormRef.current?.reset();
        // 刷新独立收尾，不延长 POST 的忙碌周期，也不解除下一次操作的禁用。
        // 报名已成功：刷新失败时保留当前页面与成功提醒。
        void load(true);
      }
    } catch {
      setPendingSignup(null);
      setProblem("网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  function closeSignupDialog() {
    // 名额用完后提交按钮会禁用，以表单作为可用的焦点归还位置。
    signupFormRef.current?.focus({ preventScroll: true });
    setPendingSignup(null);
    setSignupSucceeded(false);
  }

  async function doLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    setNotice(null);
    setLookup(null);
    setLookupPhone("");
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    try {
      const response = await fetch(`/api/v1/repair-activities/${activityId}/registrations/lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: data.phone ?? "" }),
      });
      const json = (await response.json()) as {
        success: boolean;
        data?: RegistrationLookupView;
        error?: { message?: string };
      };
      if (!json.success || !json.data) {
        setProblem(json.error?.message ?? "查询失败");
      } else {
        setLookup(json.data);
        setLookupPhone(data.phone ?? "");
        setNotice({ text: copy.lookupSuccess, tone: "success" });
      }
    } catch {
      setProblem("网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function updateType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookup) return;
    setBusy(true);
    setProblem("");
    setNotice(null);
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    try {
      const response = await fetch(
        `/api/v1/repair-activities/${activityId}/registrations/${lookup.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            issueType: data.issueType ?? "",
            phone: lookupPhone,
            editToken: lookup.editToken,
          }),
        },
      );
      const json = (await response.json()) as {
        success: boolean;
        data?: RegistrationLookupView;
        error?: { message?: string; code?: string };
      };
      if (!json.success) {
        setProblem(json.error?.message ?? "修改失败");
      } else {
        setNotice({ text: copy.updateSuccess, tone: "success" });
        if (json.data) {
          setLookup({ ...lookup, issueType: json.data.issueType, status: json.data.status });
        }
      }
    } catch {
      setProblem("网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return <p className="muted">正在加载活动…</p>;
  if (state === "missing") {
    return (
      <Card className="repair-panel">
        <h1 className="admin-panel__title" id="repair-activity-detail-title">
          {copy.breadcrumb}
        </h1>
        <p className="muted" role="alert">
          {problem || "活动已结束"}
        </p>
        <div className="signup__actions">
          <Button variant="ghost" href="/repair-activities">
            返回活动列表
          </Button>
        </div>
      </Card>
    );
  }
  if (state === "error" || !activity) {
    return (
      <div className={styles.detail}>
        <h1 className="admin-panel__title" id="repair-activity-detail-title">
          {copy.breadcrumb}
        </h1>
        <p className="admin-status admin-status--error" role="alert">
          {problem}
        </p>
      </div>
    );
  }

  const open = canAcceptNewRegistration(activity.status);
  const countdown = signupCountdownParts(countdownMs);
  const countdownOpens = copy.countdownOpensHint.replace(
    "{open}",
    formatShanghaiDateTime(activity.signupOpensAt),
  );
  const signupDisabledReason =
    activity.status === "UPCOMING"
      ? copy.upcomingDisabled
      : activity.status === "CLOSED"
        ? copy.closedDisabled
        : activity.status === "FULL"
          ? copy.fullDisabled
          : copy.signupDisabled;

  return (
    <div className={`activity-detail ${styles.detail}`}>
      <nav className={styles.breadcrumb} aria-label={copy.breadcrumb}>
        <Link href="/repair-activities">{copy.backToList}</Link>
        <span aria-hidden="true"> / </span>
        <span>{copy.breadcrumb}</span>
      </nav>
      <header className={styles.overview}>
        <p className={styles.category}>{copy.category}</p>
        <div className="activity-card__head">
          <h1 className={styles.title} id="repair-activity-detail-title">
            {activity.title}
          </h1>
          <span className={repairActivityStatusBadgeClass(activity.status)}>
            {repairActivityStatusLabels[activity.status as RepairActivityStatus]}
          </span>
        </div>
        <dl className={styles.meta}>
          <div>
            <dt>{repairActivitiesPage.activityAt}</dt>
            <dd>{formatShanghaiDateTime(activity.activityAt)}</dd>
          </div>
          <div>
            <dt>{repairActivitiesPage.window}</dt>
            <dd>
              {formatShanghaiDateTime(activity.signupOpensAt)} —{" "}
              {formatShanghaiDateTime(activity.signupClosesAt)}
            </dd>
          </div>
          <div>
            <dt className="sr-only">名额</dt>
            <dd>
              {repairActivitiesPage.capacity
                .replace("{registered}", String(activity.registeredCount))
                .replace("{capacity}", String(activity.capacity))}
              {" · "}
              {repairActivitiesPage.remaining.replace("{count}", String(activity.remaining))}
            </dd>
          </div>
        </dl>
      </header>

      <RepairActivityQueue key={activity.id} activityId={activity.id} />

      <AdminToast toast={notice} onDismiss={() => setNotice(null)} />
      {problem ? (
        <p className="admin-status admin-status--error" role="alert">
          {problem}
        </p>
      ) : null}

      <div className={styles.layout}>
        <section aria-labelledby="repair-activity-precautions-title">
          <h2 className="admin-panel__title" id="repair-activity-precautions-title">
            {copy.precautionsTitle}
          </h2>
          <RepairActivityPreparation />
          <div className={styles.service}>
            <h3>{copy.serviceTitle}</h3>
            <p>{copy.serviceHint}</p>
          </div>
          <details className={styles.fullPrecautions}>
            <summary>
              {copy.fullPrecautions.replace("{count}", String(copy.consent.clauses.length))}
            </summary>
            <RepairActivityPrecautions />
          </details>
        </section>

        <div className={styles.actions}>
          <section
            className="activity-detail__signup"
            aria-labelledby="repair-activity-signup-title"
          >
            <h2 className="admin-panel__title" id="repair-activity-signup-title">
              {copy.signupTitle}
            </h2>
            {!open ? <p className="muted">{signupDisabledReason}</p> : null}
            {/* 开始时间解析不出（契约保证不会）时整块不渲染，避免数字块出现 Infinity。 */}
            {activity.status === "UPCOMING" && Number.isFinite(countdownMs) ? (
              <div className="activity-countdown" role="timer">
                <p className="activity-countdown__label">{copy.countdownPrefix}</p>
                {waitingForOpen ? (
                  <p className="activity-countdown__opening">{copy.countdownOpeningSoon}</p>
                ) : (
                  <>
                    <div className="activity-countdown__blocks">
                      {countdown.days > 0 ? (
                        <>
                          <span className="activity-countdown__block">
                            <span className="activity-countdown__num">
                              {String(countdown.days).padStart(2, "0")}
                            </span>
                            <span className="activity-countdown__unit">
                              {copy.countdownUnits.days}
                            </span>
                          </span>
                          <span className="activity-countdown__colon" aria-hidden="true">
                            :
                          </span>
                        </>
                      ) : null}
                      <span className="activity-countdown__block">
                        <span className="activity-countdown__num">{countdown.hours}</span>
                        <span className="activity-countdown__unit">
                          {copy.countdownUnits.hours}
                        </span>
                      </span>
                      <span className="activity-countdown__colon" aria-hidden="true">
                        :
                      </span>
                      <span className="activity-countdown__block">
                        <span className="activity-countdown__num">{countdown.minutes}</span>
                        <span className="activity-countdown__unit">
                          {copy.countdownUnits.minutes}
                        </span>
                      </span>
                      <span className="activity-countdown__colon" aria-hidden="true">
                        :
                      </span>
                      <span className="activity-countdown__block">
                        <span className="activity-countdown__num">{countdown.seconds}</span>
                        <span className="activity-countdown__unit">
                          {copy.countdownUnits.seconds}
                        </span>
                      </span>
                    </div>
                    <p className="activity-countdown__hint">{countdownOpens}</p>
                  </>
                )}
              </div>
            ) : null}
            {openedNotice ? (
              <p className="sr-only" role="status">
                {copy.countdownOpened}
              </p>
            ) : null}
            <form
              className="admin-form"
              ref={signupFormRef}
              tabIndex={-1}
              onSubmit={requestSignup}
              aria-label={copy.signupTitle}
            >
              <div className={styles.fields}>
                <label className="field">
                  <span className="field__label">
                    {copy.name} <span className={styles.required}>*</span>
                  </span>
                  <input
                    className="field__input"
                    name="name"
                    placeholder={copy.namePlaceholder}
                    required
                    minLength={2}
                    maxLength={40}
                    disabled={!open || busy}
                  />
                </label>
                <label className="field">
                  <span className="field__label">
                    {copy.phone} <span className={styles.required}>*</span>
                  </span>
                  <input
                    className="field__input"
                    name="phone"
                    placeholder={copy.phonePlaceholder}
                    required
                    inputMode="numeric"
                    maxLength={11}
                    disabled={!open || busy}
                  />
                </label>
                <label className="field">
                  <span className="field__label">
                    {copy.issueType} <span className={styles.required}>*</span>
                  </span>
                  <select
                    className="field__input"
                    name="issueType"
                    required
                    disabled={!open || busy}
                    defaultValue="CLEAN_PASTE"
                  >
                    {repairActivitiesPage.issueTypes.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{copy.deviceModel}</span>
                  <input
                    className="field__input"
                    name="deviceModel"
                    maxLength={REPAIR_ACTIVITY_DEVICE_MODEL_MAX_LENGTH}
                    placeholder={copy.deviceModelPlaceholder}
                    disabled={!open || busy}
                  />
                </label>
              </div>
              <p className="muted">{copy.signupConsentHint}</p>
              <div className="signup__actions">
                <Button
                  type="submit"
                  variant="solid"
                  trailingIcon="arrowRight"
                  disabled={!open || busy}
                >
                  {busy ? "提交中…" : copy.submitSignup}
                </Button>
              </div>
            </form>
          </section>

          <section className={styles.lookup} aria-labelledby="repair-activity-lookup-title">
            <h2 className="admin-panel__title" id="repair-activity-lookup-title">
              {copy.lookupTitle}
            </h2>
            <p className="muted">{copy.lookupHint}</p>
            <form className="admin-form" onSubmit={doLookup} aria-label={copy.lookupTitle}>
              <label className="field">
                <span className="field__label">{copy.phone}</span>
                <input
                  className="field__input"
                  name="phone"
                  placeholder={copy.lookupPhonePlaceholder}
                  required
                  inputMode="numeric"
                  maxLength={11}
                  disabled={busy}
                />
              </label>
              <div className="signup__actions">
                <Button type="submit" disabled={busy}>
                  {copy.submitLookup}
                </Button>
              </div>
            </form>

            {lookup ? (
              <form className="admin-form mt-s-4" onSubmit={updateType}>
                <p className="muted">
                  {lookup.name} · {lookup.phoneMasked} · 当前：
                  {repairActivityIssueTypeLabels[lookup.issueType as RepairActivityIssueType] ??
                    lookup.issueType}
                  {" · "}
                  {lookup.status}
                </p>
                {lookup.status !== "REGISTERED" ? (
                  <p className="muted">{copy.notEditable}</p>
                ) : (
                  <>
                    <label className="field">
                      <span className="field__label">{copy.issueType}</span>
                      <select
                        className="field__input"
                        name="issueType"
                        required
                        disabled={busy}
                        defaultValue={lookup.issueType}
                      >
                        {repairActivitiesPage.issueTypes.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="signup__actions">
                      <Button type="submit" variant="solid" disabled={busy}>
                        {copy.submitUpdate}
                      </Button>
                    </div>
                  </>
                )}
              </form>
            ) : null}
            <p className="muted">{copy.cancelHint}</p>
          </section>
        </div>
      </div>

      {/* 提交前确认完整声明，成功后在同一弹层展示到场准备。
          服务端同样强制同意，绕开确认直接打接口会拿到 400。 */}
      {pendingSignup ? (
        <ConfirmDialog
          title={signupSucceeded ? copy.signupSuccessTitle : copy.consent.title}
          confirmLabel={signupSucceeded ? copy.acknowledgePrecautions : copy.consent.agree}
          cancelLabel={signupSucceeded ? undefined : copy.consent.cancel}
          busy={!signupSucceeded && busy}
          onConfirm={signupSucceeded ? closeSignupDialog : () => void confirmSignup()}
          onClose={closeSignupDialog}
        >
          <div className="admin-section">
            <p className="muted">{signupSucceeded ? copy.signupSuccess : copy.consent.subtitle}</p>
            {signupSucceeded ? <RepairActivityPreparation /> : <RepairActivityPrecautions />}
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
