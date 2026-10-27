"use client";

import { useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/Button";
import { adminCopy, adminShared } from "@/config/admin";
import { memberDepartmentOptions } from "@/config/member-department";
import { adminFetch, firstFieldError } from "@/features/admin/admin-client";
import type { MemberMutationResult } from "@/types/contracts";

/** 成员创建表单，由 AdminModal 承载。 */
export function MemberCreateForm({
  onCreated,
  onClose,
}: {
  /** 创建成功：调用方刷新列表即可，**不要关窗**（初始密码还没被看到）。 */
  onCreated: () => void;
  onClose: () => void;
}) {
  const copy = adminCopy.members.create;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  /** 创建成功后的初始密码；非空即切到结果视图。 */
  const [secret, setSecret] = useState("");
  /** 幂等键：同一次填写重复提交不会创建出两个成员。 */
  const idempotencyKey = useRef(crypto.randomUUID());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    setSecret("");
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const result = await adminFetch<MemberMutationResult>("/api/v1/admin/members", {
      method: "POST",
      body: {
        realName: data.realName ?? "",
        qq: data.qq ?? "",
        phone: data.phone ?? "",
        studentId: data.studentId || undefined,
        className: data.className || undefined,
        nickname: data.nickname || undefined,
        department: data.department,
        idempotencyKey: idempotencyKey.current,
      },
    });
    setBusy(false);
    if (!result.ok) {
      setProblem(firstFieldError(result.fieldErrors) ?? result.message);
      return;
    }
    form.reset();
    idempotencyKey.current = crypto.randomUUID();
    setSecret(result.data.initializationSecret ?? copy.secretMissing);
    // 只刷新列表，**不关窗**：初始密码就在下面这段；不看清就关掉窗口等于没发出去。
    onCreated();
  }

  /* 结果视图：一行「已创建」+ 初始密码与规则 + 领取提示，动作只剩「完成」。 */
  if (secret) {
    return (
      <div className="admin-form">
        <p className="admin-status">{copy.created}</p>
        <p className="admin-status admin-secret">
          <code>{secret}</code>
        </p>
        <p className="admin-note">{copy.secretRule}</p>
        <div className="signup__actions">
          <Button variant="solid" icon="check" onClick={onClose}>
            {adminShared.done}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form method="post" className="admin-form" onSubmit={submit} aria-label={copy.title}>
      <div className="admin-form__grid">
        <label className="field">
          <span className="field__label">{adminCopy.members.department}</span>
          <select
            className="field__input"
            name="department"
            defaultValue="REPAIR"
            disabled={busy}
            required
          >
            {memberDepartmentOptions.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">{copy.realName}</span>
          <input className="field__input" name="realName" required minLength={2} maxLength={64} />
        </label>
        <label className="field">
          <span className="field__label">{copy.qq}</span>
          <input
            className="field__input"
            name="qq"
            required
            inputMode="numeric"
            pattern="\d{5,11}"
            maxLength={11}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span className="field__label">{copy.phone}</span>
          <input
            className="field__input"
            name="phone"
            required
            inputMode="tel"
            pattern="1[3-9]\d{9}"
            maxLength={11}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span className="field__label">{copy.studentId}</span>
          <input className="field__input" name="studentId" maxLength={32} />
        </label>
        <label className="field">
          <span className="field__label">{copy.className}</span>
          <input className="field__input" name="className" maxLength={80} />
        </label>
        <label className="field">
          <span className="field__label">{copy.nickname}</span>
          <input className="field__input" name="nickname" maxLength={64} />
        </label>
      </div>
      <p className="field__hint">{copy.hint}</p>
      <div className="signup__actions">
        <Button type="submit" variant="solid" disabled={busy} icon="plus">
          {busy ? adminShared.submitting : copy.submit}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {adminShared.cancel}
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
