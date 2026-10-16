"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminAccountEmailDialog } from "@/components/admin/AdminAccountEmailPanel";
import { AdminAccountResetDialog } from "@/components/admin/AdminAccountResetDialog";
import { AdminToast, type AdminToastMessage } from "@/components/admin/AdminToast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { adminCopy } from "@/config/admin";
import { accountEmailCopy as copy } from "@/config/account-email";
import type { AccountEmailState, EmailChallengeRequestResult } from "@/types/contracts";

import { emailFetch, EmailRequestError } from "@/features/email/email-client";

/**
 * 邮箱步骤页表单（`/account/email`）。
 *
 * 三个值都由服务端授予（任务 6）：`continueTo` 是「继续原目标」的**唯一**来源
 * （邮箱已验证或豁免仍有效时才有值，否则按钮置灰，前端不自行拼路径）；`returnTo`
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
  const [refresh, setRefresh] = useState(0);
  /** 恢复工具窗口同一时刻只挂一个（两个都常驻在页面上，只是弹层互斥）。 */
  const [dialog, setDialog] = useState<"recover" | "email" | null>(null);
  const [busy, setBusy] = useState(false),
    [cooldown, setCooldown] = useState(0);
  const [toast, setToast] = useState<AdminToastMessage | null>(null);
  const requestId = useRef(0),
    inFlight = useRef(false);
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
        if (id === requestId.current) setToast({ text: e.message, tone: "neutral" });
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
        setToast({ text: copy.success, tone: "success" });
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
          setNewCode("");
        }
        setToast({ text: copy.sent, tone: "success" });
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
        setToast({
          text: sendUnknown ? copy.sendUnknown : e instanceof Error ? e.message : copy.failed,
          tone: "neutral",
        });
      }
    } finally {
      if (id === requestId.current) {
        setBusy(false);
        inFlight.current = false;
      }
    }
  }
  return (
    <Card className="admin-panel max-w-measure">
      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
      <p className="admin-note">{copy.privacy}</p>
      <p className="admin-note">{copy.warning}</p>
      <div className="admin-form" aria-busy={busy}>
        <p className="break-all">
          {copy.current}：{state?.email ?? (state ? copy.unbound : copy.loading)}
        </p>
        <p className="admin-note">
          {copy.exemption}：{state?.exemption?.expiresAt ?? copy.empty}
        </p>
        <p className="admin-note">
          {copy.assistance}：{state?.assistance?.expiresAt ?? copy.empty}
        </p>
        {state?.email || state?.assistance ? (
          <label className="field">
            <span className="field__label">{copy.password}</span>
            <input
              type="password"
              autoComplete="current-password"
              className="field__input"
              value={password}
              maxLength={256}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        ) : null}
        {state?.email && !state.assistance ? (
          <>
            <label className="field">
              <span className="field__label">{copy.oldCode}</span>
              <input
                className="field__input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={oldCode}
                disabled={busy}
                onChange={(e) => {
                  setOldCode(e.target.value);
                  setNewProof(null);
                  setNewCode("");
                }}
              />
            </label>
            <Button
              disabled={busy || cooldown > 0 || !password || !state.mailEnabled}
              onClick={() => void run("OLD")}
            >
              {copy.sendOld}
            </Button>
          </>
        ) : null}
        <label className="field">
          <span className="field__label">{copy.target}</span>
          <input
            className="field__input"
            type="email"
            maxLength={191}
            autoComplete="email"
            value={target}
            disabled={!state || busy || !!state.assistance}
            onChange={(e) => {
              ++requestId.current;
              setTarget(e.target.value);
              setNewProof(null);
              setNewCode("");
              setToast(null);
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">{copy.newCode}</span>
          <input
            className="field__input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            disabled={busy}
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
          />
        </label>
        <p className="admin-note activity-board__feedback" role="status">
          {cooldown
            ? `${cooldown}${copy.seconds}`
            : newProof
              ? `${copy.expiry}：${newProof.expiresAt}`
              : state && !state.mailEnabled
                ? copy.disabled
                : copy.help}
        </p>
        <div className="signup__actions">
          <Button
            disabled={
              !state?.mailEnabled ||
              busy ||
              cooldown > 0 ||
              !target ||
              (!!state.email && !state.assistance && (!oldProof || oldCode.length !== 6)) ||
              ((!!state.email || !!state.assistance) && !password)
            }
            onClick={() => void run("NEW")}
          >
            {copy.sendNew}
          </Button>
          <Button
            variant="solid"
            disabled={busy || !newProof || newCode.length !== 6}
            onClick={() => void run("CONFIRM")}
          >
            {busy ? copy.sending : copy.confirm}
          </Button>
        </div>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setNewProof(null);
            setOldProof(null);
            setNewCode("");
            setOldCode("");
            setPassword("");
            setRefresh((v) => v + 1);
            // 「刷新状态」也要刷新**服务端授予的继续落点**（任务 6 返修 F3）：
            // `continueTo` 来自页面服务端渲染，只重取本人邮箱状态不会更新它，管理员
            // 刚授的豁免就只能靠整页重载才生效。`router.refresh()` 重放当前 RSC 请求，
            // 查询串里的 `returnTo` 原样保留；这一轮失败就维持原状，不会凭空放行。
            router.refresh();
          }}
        >
          {copy.reload}
        </Button>
        <p className="admin-note">{copy.cooldown}</p>
        <p className="admin-note">{copy.sessionNotice}</p>
      </div>

      {/* 统一门禁（任务 6）：落点只由服务端给出 —— 邮箱已验证或管理员豁免仍有效时
          才是链接，否则按钮常驻但置灰，避免「点了没反应」和自行拼路径两种坏味道。 */}
      <div className="signup__actions">
        {continueTo ? (
          <Button variant="solid" href={continueTo}>
            {copy.continueAction}
          </Button>
        ) : (
          <Button variant="solid" disabled>
            {copy.continueAction}
          </Button>
        )}
      </div>
      <p className="admin-note">{continueTo ? copy.continueReady : copy.continueBlocked}</p>

      {/* 窄例外恢复入口（issue #113 / 任务 4）：门禁拦住普通管理接口，但恢复工具必须
          可达 —— 否则「全员都要验邮箱」会把唯一没有邮箱的管理员锁在门外。常驻在本页，
          按当次角色 + 权限由服务端决定是否给出。 */}
      {canRecover ? (
        <>
          <p className="admin-note">{copy.adminEntries}</p>
          <div className="signup__actions">
            <Button icon="key" onClick={() => setDialog("recover")}>
              {adminCopy.members.account.action}
            </Button>
            <Button onClick={() => setDialog("email")}>{copy.adminTitle}</Button>
          </div>
          {dialog === "recover" ? (
            <AdminAccountResetDialog onClose={() => setDialog(null)} />
          ) : null}
          {dialog === "email" ? <AdminAccountEmailDialog onClose={() => setDialog(null)} /> : null}
        </>
      ) : null}
    </Card>
  );
}
