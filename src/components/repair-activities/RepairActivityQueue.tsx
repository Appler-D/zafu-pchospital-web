"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { repairActivitiesPage } from "@/config/repair-activities";
import type { RepairActivityQueueView } from "@/features/repair-activities/repair-activity-service";
import { formatShanghaiDateTime } from "./activity-format";
import styles from "./RepairActivityDetail.module.css";

const REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

function isQueueView(data: unknown): data is RepairActivityQueueView {
  if (!data || typeof data !== "object") return false;
  const value = data as Partial<RepairActivityQueueView>;
  return (
    (value.waitingCount === null ||
      (typeof value.waitingCount === "number" &&
        Number.isSafeInteger(value.waitingCount) &&
        value.waitingCount >= 0)) &&
    typeof value.observedAt === "string" &&
    Number.isFinite(Date.parse(value.observedAt))
  );
}

/** 独立刷新汇总，不重取或卸载报名表单，也不调用成员接待台。 */
export function RepairActivityQueue({ activityId }: { activityId: string }) {
  const copy = repairActivitiesPage.detail.queue;
  const [sample, setSample] = useState<RepairActivityQueueView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [terminal, setTerminal] = useState<"ended" | "missing" | null>(null);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let active = true;
    let stopped = false;
    let current: AbortController | null = null;
    let timer: number | undefined;
    const clearTimer = () => window.clearTimeout(timer);
    setSample(null);
    setFailed(false);
    setTerminal(null);
    setBusy(false);

    const refresh = async () => {
      if (!active || stopped || current || document.visibilityState !== "visible") return;
      clearTimer();
      const controller = new AbortController();
      current = controller;
      setBusy(true);
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/v1/repair-activities/${activityId}/queue`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          success?: boolean;
          data?: unknown;
          error?: { code?: string };
        };
        if (!active || current !== controller) return;
        if (
          !response.ok &&
          (payload.error?.code === "ACTIVITY_ENDED" || payload.error?.code === "ACTIVITY_NOT_FOUND")
        ) {
          stopped = true;
          setTerminal(payload.error.code === "ACTIVITY_ENDED" ? "ended" : "missing");
          setSample(null);
          setFailed(false);
        } else if (response.ok && payload.success && isQueueView(payload.data)) {
          setSample(payload.data);
          setFailed(false);
        } else {
          setFailed(true);
        }
      } catch {
        if (active && current === controller) setFailed(true);
      } finally {
        window.clearTimeout(timeout);
        if (active && current === controller) {
          current = null;
          setBusy(false);
          if (!stopped && document.visibilityState === "visible") {
            timer = window.setTimeout(() => void refresh(), REFRESH_MS);
          }
        }
      }
    };
    const visibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      } else {
        clearTimer();
        const previous = current;
        current = null;
        previous?.abort();
        setBusy(false);
      }
    };
    const focus = () => void refresh();
    refreshRef.current = refresh;
    void refresh();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      clearTimer();
      current?.abort();
      refreshRef.current = null;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
    };
  }, [activityId]);

  const title = terminal === "ended" ? copy.ended : terminal === "missing" ? copy.missing : null;
  return (
    <section className={styles.queue} aria-labelledby="activity-queue-title">
      <div className={styles.queueHead}>
        <h2 id="activity-queue-title" className="admin-panel__title">
          {copy.title}
        </h2>
        <Button disabled={busy || terminal !== null} onClick={() => void refreshRef.current?.()}>
          {copy.refresh}
        </Button>
      </div>
      <div className={styles.queueResult} aria-live="polite" aria-atomic="true">
        {title ? (
          <p>{title}</p>
        ) : sample?.waitingCount === null ? (
          <>
            <p>{copy.notOpen}</p>
            <p className={styles.queueHint}>{copy.notOpenHint}</p>
          </>
        ) : sample ? (
          <>
            <p className={styles.queueCount}>
              <strong>{sample.waitingCount}</strong> {copy.waiting}
            </p>
            <p className={styles.queueHint}>{copy.definition}</p>
          </>
        ) : (
          <p>{failed ? copy.unavailable : copy.loading}</p>
        )}
        {!terminal && sample ? (
          <p className={styles.queueHint}>
            {(failed ? copy.lastUpdated : copy.updated).replace(
              "{time}",
              formatShanghaiDateTime(sample.observedAt),
            )}
          </p>
        ) : null}
        {!terminal && sample && failed ? <p className={styles.queueWarning}>{copy.stale}</p> : null}
      </div>
      <p className={styles.queueGuidance}>{copy.guidance}</p>
    </section>
  );
}
