"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { authRequestCopy, loginCopy } from "@/config/auth";

type LoginPayload = {
  success: boolean;
  data?: { destination?: string };
  error?: { message?: string };
};

/**
 * 落点一律由服务端给出（`resolveAccountAccess`：改密 → 邮箱 → 原目标 / 角色默认页）。
 * 前端不再按角色或 `mustChangePassword` 自行判断，也不参与门禁：请求里只可能带上
 * 一个候选 `returnTo`，服务端会按白名单与当前角色重新校验。
 */
export function LoginForm({ returnTo }: { returnTo?: string | null }) {
  const router = useRouter();
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      const data = new FormData(event.currentTarget);
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qq: data.get("qq"),
          password: data.get("password"),
          rememberMe: data.get("rememberMe") === "on",
          ...(returnTo ? { returnTo } : {}),
        }),
      });
      let payload: LoginPayload | null = null;
      try {
        payload = (await response.json()) as LoginPayload;
      } catch {
        payload = null;
      }
      if (payload === null) {
        setProblem(authRequestCopy.invalidResponse(response.status));
        return;
      }
      if (!response.ok || !payload.success || !payload.data?.destination) {
        setProblem(payload.error?.message ?? loginCopy.failed);
        return;
      }
      router.replace(payload.data.destination);
      router.refresh();
    } catch {
      setProblem(authRequestCopy.networkError);
    } finally {
      setBusy(false);
    }
  }
  return (
    // method="post"：JS 未 hydrate 时浏览器会退化成原生提交。没有它默认是 GET，
    // 会把 QQ 与**密码明文拼进 URL**（历史记录、访问日志、Referer 全都拿得到）。
    // M1 任务书明确要求凭据不得进入 URL，因此这里必须显式声明 POST。
    <form className="auth-login__form" method="post" onSubmit={submit}>
      <Field
        name="qq"
        label={loginCopy.qqLabel}
        placeholder={loginCopy.qqPlaceholder}
        type="text"
        autoComplete="username"
        minLength={5}
        maxLength={11}
      />
      <Field
        name="password"
        label={loginCopy.passwordLabel}
        placeholder={loginCopy.passwordPlaceholder}
        type="password"
        autoComplete="current-password"
        // 登录不设密码长度下限，以兼容已有密码。
        maxLength={128}
      />
      <div className="admin-checkrow">
        <label className="min-h-[46px] cursor-pointer">
          <input className="admin-check" type="checkbox" name="rememberMe" disabled={busy} />
          {loginCopy.rememberMe}
        </label>
      </div>
      <Button className="auth-login__submit" type="submit" variant="solid" disabled={busy}>
        {busy ? loginCopy.submitting : loginCopy.submit}
      </Button>
      {problem ? (
        <p className="auth-login__problem" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

function Field(props: {
  name: string;
  label: string;
  placeholder: string;
  type: string;
  autoComplete: string;
  minLength?: number;
  maxLength: number;
}) {
  const [revealed, setRevealed] = useState(false);
  const isPassword = props.type === "password";
  return (
    <div className="field">
      <label className="field__label" htmlFor={`auth-${props.name}`}>
        {props.label}
      </label>
      <div className={isPassword ? "auth-login__password" : undefined}>
        <input
          className="field__input"
          id={`auth-${props.name}`}
          name={props.name}
          type={isPassword && revealed ? "text" : props.type}
          inputMode={props.name === "qq" ? "numeric" : undefined}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete}
          minLength={props.minLength}
          maxLength={props.maxLength}
          required
        />
        {isPassword ? (
          <button
            className="auth-login__password-toggle"
            type="button"
            aria-label={revealed ? loginCopy.hidePassword : loginCopy.showPassword}
            aria-pressed={revealed}
            onClick={() => setRevealed((visible) => !visible)}
          >
            <Icon name={revealed ? "eyeOff" : "eye"} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
