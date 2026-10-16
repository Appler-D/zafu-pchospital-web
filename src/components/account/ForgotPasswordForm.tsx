"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { passwordRecoveryCopy as copy } from "@/config/password-recovery";
import { emailFetch, EmailRequestError } from "@/features/email/email-client";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  passwordLengthMessage,
} from "@/lib/security/password-policy";
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
  const [problem, setProblem] = useState("");
  const sequence = useRef(0),
    inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [stage]);
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
    setProblem("");
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
      } else if (action === "verify") {
        await emailFetch<PasswordRecoveryVerifyResult>("/api/v1/auth/password-reset/verify", {
          challengeId,
          code,
        });
        if (id !== sequence.current) return;
        setChallengeId("");
        setCode("");
        setStage("password");
      } else {
        const result = await emailFetch<PasswordRecoveryConfirmResult>(
          "/api/v1/auth/password-reset/confirm",
          { newPassword: password, newPasswordConfirmation: confirmation },
        );
        if (id !== sequence.current) return;
        clearProofs();
        router.replace(result.destination);
        router.refresh();
      }
    } catch (error) {
      if (id !== sequence.current) return;
      const unknownSend = action === "request" && !(error instanceof EmailRequestError);
      if (unknownSend) setCooldown(60);
      if (error instanceof EmailRequestError && error.code === "EMAIL_RESET_AUTHORIZATION_INVALID")
        clearProofs();
      setProblem(
        unknownSend ? copy.networkUnknown : error instanceof Error ? error.message : copy.help,
      );
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
    <div className="auth-flow">
      <p className="auth-flow__hint" role="status">
        {copy.steps[stage]}
      </p>
      <form
        ref={formRef}
        className="auth-login__form"
        method="post"
        onSubmit={submit}
        aria-busy={busy}
      >
        {stage === "request" ? (
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
                setProblem("");
              }}
            />
          </label>
        ) : (
          <div className="auth-flow__identity">
            <span>
              {copy.account} <strong>{qq}</strong>
            </span>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                clearProofs();
                setProblem("");
              }}
            >
              {copy.changeQq}
            </Button>
          </div>
        )}
        {stage === "code" ? (
          <>
            <p className="auth-flow__hint">{copy.accepted}</p>
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
          </>
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
                placeholder={passwordLengthMessage()}
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
        {stage === "password" ? <p className="auth-flow__hint">{copy.sessionNotice}</p> : null}
        {problem ? (
          <p className="auth-login__problem" role="alert">
            {problem}
          </p>
        ) : null}
        <Button
          className="auth-login__submit"
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
        <div className="auth-flow__secondary">
          {stage === "code" ? (
            <Button
              variant="ghost"
              aria-label={copy.resend}
              disabled={busy || cooldown > 0}
              onClick={() => void run("request")}
            >
              {cooldown ? `${cooldown}${copy.seconds}` : copy.resend}
            </Button>
          ) : null}
          {stage === "request" && cooldown > 0 ? (
            <p className="auth-flow__hint" role="status">
              {cooldown}
              {copy.seconds}
            </p>
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
      </form>
      {stage !== "password" ? (
        <details className="auth-flow__help">
          <summary>{copy.emailHelp}</summary>
          <p>{copy.help}</p>
        </details>
      ) : null}
    </div>
  );
}
