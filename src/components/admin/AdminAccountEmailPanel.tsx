"use client";
import { useEffect, useRef, useState } from "react";
import { AdminModal } from "@/components/admin/AdminModal";
import { AdminToast, type AdminToastMessage } from "@/components/admin/AdminToast";
import { Button } from "@/components/ui/Button";
import { emailFetch } from "@/features/email/email-client";
import { accountEmailCopy as copy } from "@/config/account-email";
import type { AdminAccountEmailState, AdminAccountLookupResult } from "@/types/contracts";

export function AdminAccountEmailDialog({ onClose }: { onClose: () => void }) {
  return (
    <AdminModal title={copy.adminTitle} onClose={onClose}>
      <AdminAccountEmailPanel />
    </AdminModal>
  );
}
/** 只渲染内容：成员详情的 email 阶段复用外层单个 AdminModal，避免叠层 Esc/滚动锁。 */
export function AdminAccountEmailPanel({ initialUserId }: { initialUserId?: string }) {
  const [qq, setQq] = useState(""),
    [userId, setUserId] = useState(initialUserId ?? "");
  const [state, setState] = useState<AdminAccountEmailState | null>(null),
    [name, setName] = useState("");
  const [target, setTarget] = useState(""),
    [reason, setReason] = useState(""),
    [hours, setHours] = useState("24");
  const [full, setFull] = useState<{ email: string | null; targetEmail: string | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false),
    [toast, setToast] = useState<AdminToastMessage | null>(null);
  const epoch = useRef(0),
    active = useRef(false);
  useEffect(() => {
    if (!initialUserId) return;
    const id = ++epoch.current;
    setBusy(true);
    active.current = true;
    void emailFetch<AdminAccountEmailState>(`/api/v1/admin/accounts/${initialUserId}/email`)
      .then((s) => {
        if (id === epoch.current) setState(s);
      })
      .catch((e: Error) => {
        if (id === epoch.current) setToast({ text: e.message, tone: "neutral" });
      })
      .finally(() => {
        if (id === epoch.current) {
          active.current = false;
          setBusy(false);
        }
      });
    const sequence = epoch;
    return () => {
      ++sequence.current;
    };
  }, [initialUserId]);
  useEffect(() => {
    const sequence = epoch;
    return () => {
      ++sequence.current;
    };
  }, []);
  async function lookup() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    const id = ++epoch.current;
    setState(null);
    setFull(null);
    setUserId("");
    setName("");
    setTarget("");
    setReason("");
    setToast(null);
    try {
      const account = await emailFetch<AdminAccountLookupResult>("/api/v1/admin/accounts/lookup", {
        qq,
      });
      if (id !== epoch.current) return;
      const s = await emailFetch<AdminAccountEmailState>(
        `/api/v1/admin/accounts/${account.userId}/email`,
      );
      if (id !== epoch.current) return;
      setUserId(account.userId);
      setName(account.displayName ?? "");
      setState(s);
    } catch (e) {
      if (id === epoch.current)
        setToast({ text: e instanceof Error ? e.message : copy.failed, tone: "neutral" });
    } finally {
      if (id === epoch.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  async function action(path: string, body: unknown = {}) {
    if (!userId || active.current) return;
    active.current = true;
    setBusy(true);
    const id = ++epoch.current;
    setFull(null);
    setToast(null);
    try {
      const result = await emailFetch<{ email: string | null; targetEmail: string | null }>(
        `/api/v1/admin/accounts/${userId}/email/${path}`,
        body,
      );
      if (id !== epoch.current) return;
      if (path === "reveal") setFull(result);
      else {
        const s = await emailFetch<AdminAccountEmailState>(
          `/api/v1/admin/accounts/${userId}/email`,
        );
        if (id !== epoch.current) return;
        setState(s);
        setToast({ text: copy.changed, tone: "success" });
      }
    } catch (e) {
      if (id === epoch.current)
        setToast({ text: e instanceof Error ? e.message : copy.failed, tone: "neutral" });
    } finally {
      if (id === epoch.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div className="admin-form" aria-busy={busy}>
      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
      {!initialUserId ? (
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void lookup();
          }}
        >
          <label className="field">
            <span className="field__label">{copy.qq}</span>
            <input
              className="field__input"
              inputMode="numeric"
              maxLength={32}
              required
              value={qq}
              disabled={busy}
              onChange={(e) => {
                ++epoch.current;
                setQq(e.target.value);
                setUserId("");
                setState(null);
                setFull(null);
                setName("");
                setTarget("");
                setReason("");
                setToast(null);
              }}
            />
          </label>
          <Button type="submit" disabled={busy || !qq}>
            {copy.lookup}
          </Button>
        </form>
      ) : null}
      <p className="admin-note">{copy.adminNote}</p>
      <div className="min-h-s-9">
        <p className="activity-board__feedback">
          {name} · {copy.current}：
          {full ? (full.email ?? copy.unbound) : (state?.maskedEmail ?? copy.empty)}
        </p>
        <p className="break-all">
          {copy.target}：
          {full ? (full.targetEmail ?? copy.empty) : (state?.assistance?.targetEmail ?? copy.empty)}
        </p>
        <p className="admin-note">
          {copy.assistance}：{state?.assistance?.expiresAt ?? copy.empty}
        </p>
        <p className="admin-note">
          {copy.exemption}：{state?.exemption?.expiresAt ?? copy.empty}
        </p>
      </div>
      <Button
        disabled={!state || busy}
        onClick={() => (full ? setFull(null) : void action("reveal"))}
      >
        {full ? copy.hide : copy.reveal}
      </Button>
      <p className="admin-note">{state?.mustChangePassword ? copy.forcedHint : copy.selfHint}</p>
      <label className="field">
        <span className="field__label">{copy.target}</span>
        <input
          className="field__input"
          type="email"
          value={target}
          disabled={busy || !state?.canAssist}
          maxLength={191}
          onChange={(e) => {
            ++epoch.current;
            setTarget(e.target.value);
            setFull(null);
            setToast(null);
          }}
        />
      </label>
      <label className="field">
        <span className="field__label">{copy.reason}</span>
        <textarea
          className="field__input"
          minLength={2}
          maxLength={500}
          value={reason}
          disabled={busy || !state}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <p className="admin-note">{copy.reasonHint}</p>
      <div className="signup__actions">
        <Button
          disabled={busy || !state?.canAssist || !target || reason.trim().length < 2}
          onClick={() => void action("assistance", { targetEmail: target, reason })}
        >
          {copy.assist}
        </Button>
        <Button
          disabled={busy || !state?.assistance}
          onClick={() => void action(`assistance/${state!.assistance!.id}/revoke`)}
        >
          {copy.revokeAssist}
        </Button>
      </div>
      <label className="field">
        <span className="field__label">{copy.hours}</span>
        <input
          className="field__input"
          type="number"
          min={1}
          max={168}
          step={1}
          value={hours}
          disabled={busy || !state?.canExempt}
          onChange={(e) => setHours(e.target.value)}
        />
      </label>
      <div className="signup__actions">
        <Button
          disabled={
            busy ||
            !state?.canExempt ||
            reason.trim().length < 2 ||
            !hours ||
            !Number.isInteger(Number(hours)) ||
            Number(hours) < 1 ||
            Number(hours) > 168
          }
          onClick={() => void action("exemptions", { reason, durationHours: Number(hours) })}
        >
          {copy.exempt}
        </Button>
        <Button
          disabled={busy || !state?.exemption}
          onClick={() => void action(`exemptions/${state!.exemption!.id}/revoke`)}
        >
          {copy.revokeExempt}
        </Button>
      </div>
    </div>
  );
}
