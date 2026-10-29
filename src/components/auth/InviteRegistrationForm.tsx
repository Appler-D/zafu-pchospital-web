"use client";
import { sessionMutationFetch } from "@/lib/auth/client-session";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { authRequestCopy, registerCopy } from "@/config/auth";
import {
  CLASS_NAME_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  PERSON_NAME_MIN_LENGTH,
  STUDENT_ID_MAX_LENGTH,
} from "@/lib/security/normalization";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/security/password-policy";

type InviteRegistrationPayload = {
  success: boolean;
  data?: { destination?: string };
  error?: { message?: string };
};

type FieldSpec = {
  name: string;
  label: string;
  placeholder: string;
  type: "text" | "tel" | "password";
  autoComplete: string;
  required: boolean;
  /** HTML minLength（非密码字段）；密码用全局密码策略，不走这里。 */
  minLength?: number;
  /** 非密码字段的长度上限；缺省沿用 80（历史行为）。 */
  maxLength?: number;
};

const inviteFields: readonly FieldSpec[] = [
  {
    name: "code",
    label: registerCopy.codeLabel,
    placeholder: registerCopy.codePlaceholder,
    type: "text",
    autoComplete: "off",
    required: true,
  },
];

const identityFields: readonly FieldSpec[] = [
  {
    name: "realName",
    label: registerCopy.realNameLabel,
    placeholder: registerCopy.realNamePlaceholder,
    type: "text",
    autoComplete: "name",
    required: true,
    // 姓名：只去首尾空白，trim 后 2–64 字符；此前落到默认 80 上限。
    minLength: PERSON_NAME_MIN_LENGTH,
    maxLength: PERSON_NAME_MAX_LENGTH,
  },
  {
    name: "qq",
    label: registerCopy.qqLabel,
    placeholder: registerCopy.qqPlaceholder,
    type: "text",
    autoComplete: "username",
    required: true,
  },
  {
    name: "phone",
    label: registerCopy.phoneLabel,
    placeholder: registerCopy.phonePlaceholder,
    type: "tel",
    autoComplete: "tel",
    required: true,
  },
  {
    name: "studentId",
    label: registerCopy.studentIdLabel,
    placeholder: registerCopy.studentIdPlaceholder,
    type: "text",
    autoComplete: "off",
    required: true,
    maxLength: STUDENT_ID_MAX_LENGTH,
  },
  {
    name: "className",
    label: registerCopy.classNameLabel,
    placeholder: registerCopy.classNamePlaceholder,
    type: "text",
    autoComplete: "off",
    required: true,
    maxLength: CLASS_NAME_MAX_LENGTH,
  },
];

const passwordFields: readonly FieldSpec[] = [
  {
    name: "password",
    label: registerCopy.passwordLabel,
    placeholder: registerCopy.passwordPlaceholder,
    type: "password",
    autoComplete: "new-password",
    required: true,
  },
  {
    name: "passwordConfirmation",
    label: registerCopy.passwordConfirmLabel,
    placeholder: registerCopy.passwordConfirmPlaceholder,
    type: "password",
    autoComplete: "new-password",
    required: true,
  },
];

const groups = [
  { title: registerCopy.groupInvite, fields: inviteFields },
  { title: registerCopy.groupIdentity, fields: identityFields },
  { title: registerCopy.groupPassword, fields: passwordFields },
] as const;

/**
 * 邀请码注册表单。`returnTo` 是从 `/login` 带过来的**候选**原目标：
 * 注册成功后服务端仍按白名单与当次角色重判落点，前端不自行跳转。
 */
export function InviteRegistrationForm({ returnTo }: { returnTo?: string | null }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      const data = Object.fromEntries(new FormData(event.currentTarget));
      if (data.password !== data.passwordConfirmation) {
        setProblem(registerCopy.passwordMismatch);
        return;
      }
      const response = await sessionMutationFetch("/api/v1/member-registrations/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          idempotencyKey: key.current,
          ...(returnTo ? { returnTo } : {}),
        }),
      });
      let payload: InviteRegistrationPayload | null = null;
      try {
        payload = (await response.json()) as InviteRegistrationPayload;
      } catch {
        payload = null;
      }
      if (payload === null) {
        setProblem(authRequestCopy.invalidResponse(response.status));
        return;
      }
      if (!response.ok || !payload.success || !payload.data?.destination) {
        setProblem(payload.error?.message ?? registerCopy.failed);
        return;
      }
      // 邀请码注册者自设密码（服务端 mustChangePassword = false），落点仍由服务端的
      // 统一门禁编排决定：模式开启时先被引导到邮箱步骤页，前端不写死 /member。
      router.replace(payload.data.destination);
      router.refresh();
    } catch {
      setProblem(authRequestCopy.networkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form method="post" className="auth-login__form auth-login__form--register" onSubmit={submit}>
      {groups.map((group) => (
        <fieldset key={group.title} className="auth-login__group">
          <legend className="auth-login__group-title">{group.title}</legend>
          {group.fields.map((field) => (
            <RegisterField key={field.name} field={field} />
          ))}
        </fieldset>
      ))}
      <Button className="auth-login__submit" type="submit" variant="solid" disabled={busy}>
        {busy ? registerCopy.submitting : registerCopy.submit}
      </Button>
      {/* 错误提示常驻一行（空时也占位，min-height 见 globals.css）：就地替换文案，
          不插入元素 —— 面板上下不再因错误出现而位移。 */}
      <p className="auth-login__problem" role="alert">
        {problem}
      </p>
    </form>
  );
}

function RegisterField({ field }: { field: FieldSpec }) {
  const [revealed, setRevealed] = useState(false);
  const isPassword = field.type === "password";
  const inputId = `register-${field.name}`;

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {field.label}
        {field.required ? <span className="field__req">{registerCopy.requiredMark}</span> : null}
      </label>
      <div className={isPassword ? "auth-login__password" : undefined}>
        <input
          className="field__input"
          id={inputId}
          name={field.name}
          type={isPassword && revealed ? "text" : field.type}
          inputMode={field.name === "qq" ? "numeric" : undefined}
          placeholder={field.placeholder}
          autoComplete={field.autoComplete}
          minLength={isPassword ? PASSWORD_MIN_LENGTH : field.minLength}
          maxLength={isPassword ? PASSWORD_MAX_LENGTH : (field.maxLength ?? 80)}
          required={field.required}
        />
        {isPassword ? (
          <button
            className="auth-login__password-toggle"
            type="button"
            aria-label={revealed ? registerCopy.hidePassword : registerCopy.showPassword}
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
