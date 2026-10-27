"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { authRequestCopy } from "@/config/auth";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/security/password-policy";

type ChangePasswordPayload = {
  success?: boolean;
  data?: { destination?: string };
  error?: { message?: string };
};

export function ChangePasswordForm({ returnTo }: { returnTo?: string | null }) {
  const router = useRouter();
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    const data = new FormData(event.currentTarget);

    // 无论成功、业务失败还是网络异常，finally 都会解除按钮禁用，
    // 不会永远停在「保存中」。
    try {
      const response = await fetch("/api/v1/auth/password/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: data.get("currentPassword"),
          newPassword: data.get("newPassword"),
          newPasswordConfirmation: data.get("newPasswordConfirmation"),
          ...(returnTo ? { returnTo } : {}),
        }),
      });

      // 非 JSON 响应（例如网关错误页）单独兜底，与 adminFetch 的
      // INVALID_RESPONSE 分支保持一致；带上状态码，便于区分 502 与 200 空体。
      let payload: ChangePasswordPayload | null = null;
      try {
        payload = (await response.json()) as ChangePasswordPayload;
      } catch {
        payload = null;
      }

      if (payload === null) {
        setProblem(authRequestCopy.invalidResponse(response.status));
        return;
      }

      if (!response.ok || !payload.success || !payload.data?.destination) {
        setProblem(payload.error?.message ?? "修改失败，请稍后重试");
        return;
      }

      // 落点由服务端统一编排（任务 6）：还要验邮箱就先去邮箱步骤页并带上原目标，
      // 否则回原目标 / 角色默认页。这里不再按角色自行判断。
      router.replace(payload.data.destination);
      router.refresh();
    } catch {
      // 断网、请求被中止或跨域失败。文案与 adminFetch 的 NETWORK_ERROR 对齐。
      setProblem(authRequestCopy.networkError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form method="post" className="signup__form" onSubmit={submit}>
      {[
        ["currentPassword", "当前密码", "current-password"],
        ["newPassword", "新密码", "new-password"],
        ["newPasswordConfirmation", "确认新密码", "new-password"],
      ].map(([name, label, autoComplete]) => (
        <div className="field" key={name}>
          <label className="field__label" htmlFor={`password-${name}`}>
            {label}
            <span className="field__req">必填</span>
          </label>
          <input
            className="field__input"
            id={`password-${name}`}
            name={name}
            type="password"
            autoComplete={autoComplete}
            // 「当前密码」不设下限：它是**校验**的对象，不是正在设置的密码（同登录表单）。
            // 5 位老 QQ的初始密码只有 5 位，带 minLength 会让他在这一步被拦死。
            minLength={name === "currentPassword" ? undefined : PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            required
          />
        </div>
      ))}
      <p className="field__hint">
        {`密码长度为 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符；修改后其他登录会话将立即失效。`}
      </p>
      <div className="signup__actions">
        <Button type="submit" variant="solid" disabled={busy}>
          {busy ? "保存中" : "修改密码"}
        </Button>
      </div>
      {problem ? (
        <p className="signup__status signup__status--alert" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
