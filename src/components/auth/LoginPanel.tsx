import Link from "next/link";

import { AuthPanel } from "@/components/auth/AuthPanel";
import { InviteRegistrationForm } from "@/components/auth/InviteRegistrationForm";
import { LoginForm } from "@/components/auth/LoginForm";
import { loginCopy, registerCopy } from "@/config/auth";

export type AuthPanelMode = "login" | "register";

type LoginPanelProps = {
  mode?: AuthPanelMode;
  /** 已校验的候选回跳目标（由 `/login` 服务端传入，登录接口还会再判一次）。 */
  returnTo?: string | null;
};

/**
 * 同一 Auth 壳：登录 ↔ 邀请码注册仅换标题与表单，不跳公开营销布局。
 * `mode` 由 `/login?mode=register` 驱动；切换用 Link.replace，保证返回键合理。
 *
 * 切换链接与两个表单都带着同一个 `returnTo`：候选目标不能在
 * 「登录 ↔ 注册」之间掉链子。它仍然只是候选，提交时由服务端按白名单与当前角色重判。
 */
export function LoginPanel({ mode = "login", returnTo }: LoginPanelProps) {
  const isRegister = mode === "register";
  const shell = isRegister ? registerCopy : loginCopy;
  const loginHref = authHref({ returnTo });
  const registerHref = authHref({ mode: "register", returnTo });

  return (
    <AuthPanel
      title={shell.title}
      titleId="login-title"
      eyebrow={shell.eyebrow}
      className={isRegister ? "auth-login__panel--register" : undefined}
    >
      {isRegister ? (
        <InviteRegistrationForm returnTo={returnTo} />
      ) : (
        <LoginForm returnTo={returnTo} />
      )}

      <div className="auth-login__links">
        {!isRegister ? (
          <p>
            <Link href="/account/forgot-password">{loginCopy.forgotPassword}</Link>
          </p>
        ) : null}
        {isRegister ? (
          <>
            <p>
              <Link href={loginHref} replace scroll={false}>
                {registerCopy.loginAction}
              </Link>
            </p>
            <p>
              {registerCopy.joinPrompt} <Link href="/join">{registerCopy.joinAction}</Link>
            </p>
          </>
        ) : (
          <>
            <p>
              {loginCopy.registerPrompt}{" "}
              <Link href={registerHref} replace scroll={false}>
                {loginCopy.registerAction}
              </Link>
            </p>
            <p>
              {loginCopy.joinPrompt} <Link href="/join">{loginCopy.joinAction}</Link>
            </p>
          </>
        )}
        <Link className="auth-login__home" href="/">
          {shell.backHome}
        </Link>
      </div>
    </AuthPanel>
  );
}

/** `/login` 的查询串：只拼服务端已过滤的候选目标，不接受任意 URL。 */
function authHref(params: { mode?: string; returnTo?: string | null }): string {
  const search = new URLSearchParams();
  if (params.mode) search.set("mode", params.mode);
  if (params.returnTo) search.set("returnTo", params.returnTo);
  const query = search.toString();
  return query ? `/login?${query}` : "/login";
}
