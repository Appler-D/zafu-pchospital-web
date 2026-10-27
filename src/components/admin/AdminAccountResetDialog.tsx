"use client";

import { useRef, useState, type FormEvent } from "react";

import { AdminModal } from "@/components/admin/AdminModal";
import { formatDateTime } from "@/components/admin/invite-code-table-spec";
import { MemberIdentityFields } from "@/components/member/MemberIdentityFields";
import { Button } from "@/components/ui/Button";
import { adminCopy, adminShared, memberRoleLabels } from "@/config/admin";
import { adminFetch } from "@/features/admin/admin-client";
import type { AdminAccountLookupResult, AdminAccountResetResult } from "@/types/contracts";

/**
 * 账号恢复窗口：QQ 精确查询 → 核验本人 → 签发临时密码 → 明文结果。
 *
 * 为什么独立于成员详情：恢复目标可能是**没有成员档案的管理员**，成员列表里根本没有
 * 这一行；查询只在服务端按 QQ 精确匹配，不做模糊检索（这是恢复入口，不是账号平台）。
 *
 * 三条界面约束：
 * 1. 明文只出现在这个固定弹层里（关闭即清空，不落 localStorage / sessionStorage），
 *    不用会自动消失的 Toast —— 临时密码只出现这一次；
 * 2. 提交中禁用动作、失败不自动重放；失败把服务端文案留在原地供管理员决定是否重试；
 * 3. 资格判定跟随服务端（`blockedReason`），界面提前说清，但不替代服务端拒绝。
 */
export function AdminAccountResetDialog({ onClose }: { onClose: () => void }) {
  const copy = adminCopy.members.account;
  const [target, setTarget] = useState<AdminAccountLookupResult | null>(null);
  const [result, setResult] = useState<AdminAccountResetResult | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [qq, setQq] = useState("");
  /**
   * 查询代次：输入一变或发起新查询就递增，晚到的旧响应直接丢弃 ——
   * 「展示、核验、签发」必须始终是查询时那个 QQ 对应的目标，不能被过时结果改写。
   */
  const lookupSeq = useRef(0);

  const busy = lookupBusy || resetBusy;

  function changeQq(value: string) {
    lookupSeq.current += 1;
    // 在途查询的响应已被作废，顺带解除它的忙碌态；旧目标一并立即失效。
    setLookupBusy(false);
    setQq(value);
    setTarget(null);
    setProblem("");
  }

  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const seq = ++lookupSeq.current;
    setLookupBusy(true);
    setProblem("");
    setTarget(null);
    setResult(null);
    const response = await adminFetch<AdminAccountLookupResult>("/api/v1/admin/accounts/lookup", {
      method: "POST",
      body: { qq },
    });
    if (seq !== lookupSeq.current) return; // 过时响应：不写任何状态
    setLookupBusy(false);
    if (!response.ok) {
      setProblem(response.message);
      return;
    }
    setTarget(response.data);
  }

  async function issue() {
    if (!target) return;
    setResetBusy(true);
    setProblem("");
    const response = await adminFetch<AdminAccountResetResult>(
      `/api/v1/admin/accounts/${target.userId}/password-reset`,
      { method: "POST" },
    );
    setResetBusy(false);
    if (!response.ok) {
      setProblem(response.message);
      return;
    }
    setResult(response.data);
  }

  return (
    <AdminModal title={copy.title} subtitle={copy.lead} onClose={onClose}>
      {result ? (
        <div role="status" aria-live="polite">
          <p className="admin-status">{copy.resultTitle}</p>
          <p className="admin-status">
            <code>{result.initializationSecret}</code>
          </p>
          <p className="admin-note">
            {copy.resultExpires.replace("{time}", formatDateTime(result.temporaryExpiresAt))}
          </p>
          <p className="admin-note">{copy.resultNote}</p>
        </div>
      ) : (
        <>
          <form method="post" className="admin-form" onSubmit={lookup} aria-label={copy.submit}>
            <label className="field">
              <span className="field__label">{copy.qq}</span>
              <input
                className="field__input"
                name="qq"
                inputMode="numeric"
                autoComplete="off"
                maxLength={11}
                required
                value={qq}
                disabled={busy}
                onChange={(event) => changeQq(event.target.value)}
              />
            </label>
            <p className="admin-note">{copy.verifyNote}</p>
            <div className="signup__actions">
              <Button type="submit" disabled={busy}>
                {lookupBusy ? adminShared.submitting : copy.submit}
              </Button>
            </div>
          </form>

          {problem ? (
            <p className="admin-status admin-status--error" role="alert">
              {problem}
            </p>
          ) : null}

          {target ? (
            <div className="admin-modal__facts">
              <MemberIdentityFields
                fields={[
                  { label: copy.displayName, value: target.displayName },
                  {
                    label: copy.roles,
                    value: target.roles.map((role) => memberRoleLabels[role]).join(" / ") || null,
                  },
                ]}
              />
              {target.canReset ? (
                <>
                  <p className="admin-note">{copy.signNote}</p>
                  <div className="signup__actions">
                    <Button icon="key" disabled={busy} onClick={() => void issue()}>
                      {resetBusy ? adminShared.submitting : copy.sign}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="admin-status admin-status--error" role="alert">
                  {target.blockedReason ? copy.blocked[target.blockedReason] : ""}
                </p>
              )}
            </div>
          ) : null}
        </>
      )}
    </AdminModal>
  );
}
