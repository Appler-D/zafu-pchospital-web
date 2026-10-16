"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AdminAccountEmailDialog } from "@/components/admin/AdminAccountEmailPanel";
import { AdminAccountResetDialog } from "@/components/admin/AdminAccountResetDialog";
import { Button } from "@/components/ui/Button";
import { adminCopy } from "@/config/admin";
import { accountEmailCopy as copy } from "@/config/account-email";
import type { AccountEmailState, EmailChallengeRequestResult } from "@/types/contracts";

import { emailFetch, EmailRequestError } from "@/features/email/email-client";

/**
 * 邮箱步骤页表单（`/account/email`）。
 *
 * 三个值都由服务端授予（任务 6）：`continueTo` 是「继续原目标」的**唯一**来源
 * （邮箱已验证或豁免仍有效时才有值，否则不显示继续入口，前端不自行拼路径）；`returnTo`
 * 是已按白名单与当前角色校验过的候选目标；`canRecover` 决定窄例外恢复入口是否出现
 * （ADMIN + `member:manage`，豁免不授予该权限）。
 */
export function AccountEmailForm({
  continueTo,
  returnTo,
  canRecover,
}: {
  continueTo: string | null;
  returnTo: string | null;
  canRecover: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<AccountEmailState | null>(null);
  const [target, setTarget] = useState(""),
    [password, setPassword] = useState("");
  const [oldCode, setOldCode] = useState(""),
    [newCode, setNewCode] = useState("");
  const [oldProof, setOldProof] = useState<EmailChallengeRequestResult | null>(null),
    [newProof, setNewProof] = useState<EmailChallengeRequestResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [stage, setStage] = useState<"prepare" | "code">("prepare");
  const [refresh, setRefresh] = useState(0);
  /** 恢复工具窗口同一时刻只挂一个（两个都常驻在页面上，只是弹层互斥）。 */
  const [dialog, setDialog] = useState<"recover" | "email" | null>(null);
  const [busy, setBusy] = useState(false),
    [cooldown, setCooldown] = useState(0);
  const [problem, setProblem] = useState("");
  const requestId = useRef(0),
    inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current
      ?.querySelector<HTMLInputElement>("input:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [stage, editing, state?.email, state?.assistance?.id]);
  useEffect(() => {
    const timer = window.setInterval(() => setCooldown((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const id = ++requestId.current;
    void emailFetch<AccountEmailState>("/api/v1/account/email")
      .then((s) => {
        if (id === requestId.current) {
          setState(s);
          setTarget(s.assistance?.targetEmail ?? "");
        }
      })
      .catch((e: Error) => {
        if (id === requestId.current) setProblem(e.message);
      });
    const sequence = requestId;
    return () => {
      ++sequence.current;
    };
  }, [refresh]);
  async function run(action: "OLD" | "NEW" | "CONFIRM") {
    if (!state || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem("");
    const id = ++requestId.current;
    const assisted = state.assistance;
    try {
      const mode = assisted ? "ASSISTED" : state.email ? "NEW" : "BIND";
      const common = assisted
        ? { assistanceId: assisted.id, currentPassword: password }
        : state.email
          ? {
              targetEmail: target,
              currentPassword: password,
              old: { challengeId: oldProof?.challengeId, code: oldCode },
            }
          : { targetEmail: target };
      if (action === "CONFIRM") {
        const result = await emailFetch<{ destination: string }>("/api/v1/account/email/confirm", {
          ...common,
          mode: mode === "NEW" ? "CHANGE" : mode,
          proof: { challengeId: newProof?.challengeId, code: newCode },
          returnTo: returnTo ?? undefined,
        });
        if (id !== requestId.current) return;
        setPassword("");
        setOldCode("");
        setNewCode("");

        router.replace(result.destination);
        router.refresh();
      } else {
        // 重发可能已作废同用途挑战；先撤下旧证明，失败时也不能继续提交。
        if (action === "OLD") {
          setOldProof(null);
          setOldCode("");
        }
        setNewProof(null);
        setNewCode("");
        const result = await emailFetch<EmailChallengeRequestResult>(
          "/api/v1/account/email/challenges",
          action === "OLD" ? { mode: "OLD", currentPassword: password } : { mode, ...common },
        );
        if (id !== requestId.current) return;
        setCooldown(60);
        if (action === "OLD") {
          setOldProof(result);
          setOldCode("");
          setNewProof(null);
          setNewCode("");
        } else {
          setNewProof(result);
          setStage("code");
          setNewCode("");
        }
      }
    } catch (e) {
      if (id === requestId.current) {
        const sendUnknown = action !== "CONFIRM" && !(e instanceof EmailRequestError);
        // 不推算业务拒绝（包括 429）的剩余冷却；网络中断则保守视为可能已发送。
        if (
          action !== "CONFIRM" &&
          (sendUnknown ||
            (e instanceof EmailRequestError &&
              (e.code === "EMAIL_SEND_FAILED" || e.code === "EMAIL_SEND_UNCERTAIN")))
        )
          setCooldown(60);
        setProblem(sendUnknown ? copy.sendUnknown : e instanceof Error ? e.message : copy.failed);
      }
    } finally {
      if (id === requestId.current) {
        setBusy(false);
        inFlight.current = false;
      }
    }
  }
  function clearProofs() {
    setNewProof(null);
    setOldProof(null);
    setNewCode("");
    setOldCode("");
    setPassword("");
    setProblem("");
    setStage("prepare");
  }
  const changing = !!state?.email && !state.assistance;
  const showForm = !!state && (!state.email || !!state.assistance || editing);
  const canSend =
    !!state?.mailEnabled &&
    !busy &&
    cooldown === 0 &&
    !!target &&
    (!changing || (!!oldProof && /^\d{6}$/.test(oldCode))) &&
    (!(state?.email || state?.assistance) || !!password);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage === "code") {
      if (newProof && /^\d{6}$/.test(newCode)) void run("CONFIRM");
    } else if (canSend) void run("NEW");
  }
  return (
    <div className="auth-flow">
      {!state ? (
        <p className="auth-flow__hint" role="status">
          {problem || copy.loading}
        </p>
      ) : null}
      {state?.email ? (
        <div className="auth-flow__identity">
          <div>
            <span className="auth-flow__hint">{copy.current}</span>
            <p className="auth-flow__email">{state.email}</p>
          </div>
          {state.verified ? <span className="auth-flow__badge">{copy.verified}</span> : null}
        </div>
      ) : null}
      {state?.exemption ? (
        <p className="auth-flow__hint">
          {copy.exemptionHint} {new Date(state.exemption.expiresAt).toLocaleString("zh-CN")}
        </p>
      ) : null}
      {showForm ? (
        <form
          ref={formRef}
          className="auth-login__form"
          method="post"
          onSubmit={submit}
          aria-busy={busy}
        >
          {stage === "prepare" ? (
            <>
              {state.email || state.assistance ? (
                <>
                  <p className="auth-flow__hint">
                    {state.assistance ? copy.assistedHint : copy.passwordHint}
                  </p>
                  <label className="field" htmlFor="email-password">
                    <span className="field__label">{copy.password}</span>
                    <input
                      id="email-password"
                      name="currentPassword"
                      type="password"
                      autoComplete="current-password"
                      className="field__input"
                      value={password}
                      maxLength={256}
                      disabled={busy}
                      required
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setOldProof(null);
                        setOldCode("");
                      }}
                    />
                  </label>
                </>
              ) : null}
              {changing ? (
                <label className="field" htmlFor="email-old-code">
                  <span className="field__label">{copy.oldCode}</span>
                  <div className="auth-flow__code-row">
                    <input
                      id="email-old-code"
                      name="oldCode"
                      className="field__input"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      pattern="[0-9]{6}"
                      value={oldCode}
                      disabled={busy}
                      required
                      onChange={(event) => setOldCode(event.target.value)}
                    />
                    <Button
                      disabled={busy || cooldown > 0 || !password || !state.mailEnabled}
                      aria-label={copy.sendOld}
                      onClick={() => void run("OLD")}
                    >
                      {cooldown ? `${cooldown}${copy.seconds}` : copy.sendOld}
                    </Button>
                  </div>
                </label>
              ) : null}
              <label className="field" htmlFor="email-target">
                <span className="field__label">
                  {state.email ? copy.newEmailLabel : copy.emailLabel}
                </span>
                <input
                  id="email-target"
                  name="targetEmail"
                  className="field__input"
                  type="email"
                  maxLength={191}
                  autoComplete="email"
                  value={target}
                  disabled={busy || !!state.assistance}
                  required
                  onChange={(event) => {
                    ++requestId.current;
                    setTarget(event.target.value);
                    setNewProof(null);
                    setNewCode("");
                    setProblem("");
                  }}
                />
              </label>
            </>
          ) : (
            <>
              <p className="auth-flow__hint">
                {newProof ? (
                  <>
                    {copy.codeSentTo} <strong>{newProof.maskedEmail}</strong>
                  </>
                ) : (
                  copy.resendNeeded
                )}
              </p>
              <label className="field" htmlFor="email-new-code">
                <span className="field__label">{copy.newCode}</span>
                <input
                  id="email-new-code"
                  name="newCode"
                  className="field__input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  value={newCode}
                  disabled={busy}
                  required
                  onChange={(event) => setNewCode(event.target.value)}
                />
              </label>
            </>
          )}
          {!state.mailEnabled ? <p className="auth-flow__hint">{copy.disabled}</p> : null}
          {problem ? (
            <p className="auth-login__problem" role="alert">
              {problem}
            </p>
          ) : null}
          <Button
            className="auth-login__submit"
            variant="solid"
            type="submit"
            disabled={stage === "code" ? busy || !newProof || !/^\d{6}$/.test(newCode) : !canSend}
          >
            {busy ? copy.sending : stage === "code" ? copy.confirm : copy.sendNew}
          </Button>
          <div className="auth-flow__secondary">
            {stage === "code" ? (
              <>
                <Button
                  variant="ghost"
                  aria-label={copy.resend}
                  disabled={!canSend}
                  onClick={() => void run("NEW")}
                >
                  {cooldown ? `${cooldown}${copy.seconds}` : copy.resend}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setStage("prepare");
                    setNewProof(null);
                    setNewCode("");
                    setProblem("");
                  }}
                >
                  {copy.previous}
                </Button>
              </>
            ) : (
              <>
                {cooldown > 0 && !changing ? (
                  <span className="auth-flow__hint" role="status">
                    {cooldown}
                    {copy.seconds}
                  </span>
                ) : null}
                {state.email && !state.assistance ? (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      clearProofs();
                      setEditing(false);
                      setTarget("");
                    }}
                  >
                    {copy.cancel}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </form>
      ) : state ? (
        <>
          {continueTo ? (
            <Button className="auth-login__submit" variant="solid" href={continueTo}>
              {copy.continueAction}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              clearProofs();
              setEditing(true);
            }}
          >
            {copy.change}
          </Button>
        </>
      ) : null}
      <div className="auth-flow__footer">
        {showForm && continueTo ? (
          <Button variant="ghost" href={continueTo}>
            {copy.continueAction}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            clearProofs();
            setEditing(false);
            setRefresh((value) => value + 1);
            // 继续落点必须由服务端重算，保留当前 URL 中的 returnTo。
            router.refresh();
          }}
        >
          {copy.reload}
        </Button>
      </div>
      {showForm ? (
        <details className="auth-flow__help">
          <summary>{copy.emailHelp}</summary>
          <p>{copy.recoveryHelp}</p>
        </details>
      ) : null}
      {canRecover ? (
        <details className="auth-flow__help">
          <summary>{copy.adminEntries}</summary>
          <div className="auth-flow__secondary">
            <Button onClick={() => setDialog("recover")}>{adminCopy.members.account.action}</Button>
            <Button onClick={() => setDialog("email")}>{copy.adminTitle}</Button>
          </div>
        </details>
      ) : null}
      {dialog === "recover" ? <AdminAccountResetDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "email" ? <AdminAccountEmailDialog onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
