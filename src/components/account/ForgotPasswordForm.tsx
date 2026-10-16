"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AdminToast, type AdminToastMessage } from "@/components/admin/AdminToast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { passwordRecoveryCopy as copy } from "@/config/password-recovery";
import { emailFetch, EmailRequestError } from "@/features/email/email-client";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "@/lib/security/password-policy";
import type {
  PasswordRecoveryRequestResult,
  PasswordRecoveryVerifyResult,
  PasswordRecoveryConfirmResult,
} from "@/types/contracts";

export function ForgotPasswordForm() {
  const router = useRouter();
  const [stage, setStage] = useState<"request" | "code" | "password">("request");
  const [qq, setQq] = useState(""),
    [code, setCode] = useState("");
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [cooldown, setCooldown] = useState(0);
  const [toast, setToast] = useState<AdminToastMessage | null>(null);
  const sequence = useRef(0),
    inFlight = useRef(false);
  useEffect(() => {
    setReady(true);
    const counter = sequence;
    const timer = window.setInterval(() => setCooldown((v) => Math.max(0, v - 1)), 1000);
    return () => {
      ++counter.current;
      clearInterval(timer);
    };
  }, []);
  function clearProofs() {
    setChallengeId("");
    setCode("");
    setPassword("");
    setConfirmation("");
    setStage("request");
  }
  async function run(action: "request" | "verify" | "confirm") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setToast(null);
    const id = ++sequence.current;
    if (action === "request") clearProofs();
    try {
      if (action === "request") {
        const result = await emailFetch<PasswordRecoveryRequestResult>(
          "/api/v1/auth/password-reset/request",
          { qq },
        );
        if (id !== sequence.current) return;
        setChallengeId(result.challengeId);
        setStage("code");
        setCooldown(60);
        setToast({ text: result.message, tone: "neutral" });
      } else if (action === "verify") {
        await emailFetch<PasswordRecoveryVerifyResult>("/api/v1/auth/password-reset/verify", {
          challengeId,
          code,
        });
        if (id !== sequence.current) return;
        setChallengeId("");
        setCode("");
        setStage("password");
        setToast({ text: copy.authorized, tone: "success" });
      } else {
        const result = await emailFetch<PasswordRecoveryConfirmResult>(
          "/api/v1/auth/password-reset/confirm",
          { newPassword: password, newPasswordConfirmation: confirmation },
        );
        if (id !== sequence.current) return;
        clearProofs();
        setToast({ text: copy.success, tone: "success" });
        router.replace(result.destination);
        router.refresh();
      }
    } catch (error) {
      if (id !== sequence.current) return;
      const unknownSend = action === "request" && !(error instanceof EmailRequestError);
      if (unknownSend) setCooldown(60);
      if (error instanceof EmailRequestError && error.code === "EMAIL_RESET_AUTHORIZATION_INVALID")
        clearProofs();
      setToast({
        text: unknownSend
          ? copy.networkUnknown
          : error instanceof Error
            ? error.message
            : copy.help,
        tone: "neutral",
      });
    } finally {
      if (id === sequence.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(stage === "code" ? "verify" : stage === "password" ? "confirm" : "request");
  }
  return (
    <Card className="admin-panel max-w-measure">
      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
      <p className="admin-note">{copy.help}</p>
      <p className="admin-note">{copy.privacy}</p>
      <form className="admin-form" method="post" onSubmit={submit} aria-busy={busy}>
        <label className="field">
          <span className="field__label">{copy.qq}</span>
          <input
            className="field__input"
            name="qq"
            inputMode="numeric"
            autoComplete="username"
            required
            pattern="[0-9]{5,11}"
            maxLength={11}
            value={qq}
            disabled={busy}
            onChange={(e) => {
              ++sequence.current;
              setQq(e.target.value);
              clearProofs();
              setToast(null);
            }}
          />
        </label>
        {stage === "code" ? (
          <label className="field">
            <span className="field__label">{copy.code}</span>
            <input
              className="field__input"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        ) : null}
        {stage === "password" ? (
          <>
            <label className="field">
              <span className="field__label">{copy.newPassword}</span>
              <input
                className="field__input"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">{copy.confirmation}</span>
              <input
                className="field__input"
                name="newPasswordConfirmation"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                value={confirmation}
                disabled={busy}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
          </>
        ) : null}
        <p className="admin-note activity-board__feedback" role="status">
          {cooldown
            ? `${cooldown}${copy.seconds}`
            : stage === "password"
              ? copy.authorized
              : copy.accepted}
        </p>
        <div className="signup__actions">
          <Button
            variant="solid"
            type="submit"
            disabled={
              !ready ||
              busy ||
              (stage === "request" && (!qq || cooldown > 0)) ||
              (stage === "code" && (!challengeId || code.length !== 6))
            }
          >
            {busy
              ? copy.busy
              : stage === "code"
                ? copy.verify
                : stage === "password"
                  ? copy.confirm
                  : copy.request}
          </Button>
          {stage === "code" ? (
            <Button disabled={busy || cooldown > 0} onClick={() => void run("request")}>
              {copy.resend}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              clearProofs();
              router.replace("/login");
            }}
          >
            {copy.back}
          </Button>
        </div>
        <p className="admin-note">{copy.sessionNotice}</p>
      </form>
    </Card>
  );
}
