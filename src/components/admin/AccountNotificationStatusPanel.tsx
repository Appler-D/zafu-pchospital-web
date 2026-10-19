"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { accountNotificationCopy as copy } from "@/config/account-notification";
import { adminFetch } from "@/features/admin/admin-client";
import type { AccountNotificationView } from "@/types/contracts";

export function AccountNotificationStatusPanel({
  applicationId,
  notification,
  hasEmail,
  provisionStatus,
  busy,
  onChanged,
  onProblem,
  onScheduled,
}: {
  applicationId: string;
  notification: AccountNotificationView | null;
  hasEmail: boolean;
  provisionStatus: string;
  busy: boolean;
  onChanged: (notification: AccountNotificationView) => void;
  onProblem: (message: string) => void;
  onScheduled: () => void;
}) {
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  async function retry() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      const result = await adminFetch<AccountNotificationView>(
        `/api/v1/admin/join-applications/${applicationId}/notification/retry`,
        { method: "POST" },
      );
      if (!result.ok) {
        onProblem(result.message);
        return;
      }
      onChanged(result.data);
      onScheduled();
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }
  return (
    <div className="admin-section">
      <h3 className="admin-panel__title">{copy.title}</h3>
      <p className="admin-status">
        {notification
          ? copy.status[notification.status]
          : !hasEmail
            ? copy.noEmail
            : provisionStatus === "SUCCEEDED"
              ? copy.notQueued
              : copy.afterProvision}
      </p>
      {notification ? (
        <p className="admin-note">
          {copy.attempts
            .replace("{round}", String(notification.roundAttemptCount))
            .replace("{count}", String(notification.attemptCount))}
          {notification.lastErrorCode && notification.lastErrorCode in copy.errors
            ? ` · ${copy.errors[notification.lastErrorCode as keyof typeof copy.errors]}`
            : ""}
        </p>
      ) : null}
      {notification?.status === "UNCERTAIN" ? <p className="admin-note">{copy.uncertain}</p> : null}
      {notification?.canRetry ? (
        <>
          <p className="admin-note">{copy.retryHint}</p>
          <Button disabled={busy || sending} onClick={() => void retry()}>
            {copy.retry}
          </Button>
        </>
      ) : null}
    </div>
  );
}
