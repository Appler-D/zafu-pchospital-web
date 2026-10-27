"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  memberRepairActivitiesCopy,
  memberRepairActivityStatusLabels,
} from "@/config/repair-activities";
import type { StaffActivityListItem } from "@/features/repair-activities/repair-activity-staff-service";
import { formatShanghaiDateTime } from "@/components/repair-activities/activity-format";
import { memberRepairActivityStatusBadgeClass } from "@/components/repair-activities/activity-status-badge";

export function MemberRepairActivityList() {
  const copy = memberRepairActivitiesCopy.list;
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [items, setItems] = useState<StaffActivityListItem[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/v1/member/repair-activities", { cache: "no-store" });
        const json = (await response.json()) as {
          success: boolean;
          data?: StaffActivityListItem[];
          error?: { message?: string };
        };
        if (cancelled) return;
        if (!json.success || !json.data) {
          setState("error");
          setMessage(json.error?.message ?? copy.loadFailed);
          return;
        }
        setItems(
          [...json.data].sort(
            (a, b) => new Date(b.activityAt).getTime() - new Date(a.activityAt).getTime(),
          ),
        );
        setState("ready");
      } catch {
        if (!cancelled) {
          setState("error");
          setMessage(copy.loadFailed);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [copy.loadFailed]);

  if (state === "loading") {
    return <p className="muted">正在加载…</p>;
  }
  if (state === "error") {
    return (
      <p className="admin-status admin-status--error" role="alert">
        {message}
      </p>
    );
  }
  if (items.length === 0) {
    return <p className="muted">{copy.empty}</p>;
  }

  return (
    <ul className="activity-list">
      {items.map((item) => (
        <li key={item.id}>
          <Card className="activity-card repair-panel">
            <div className="activity-card__head">
              <h2 className="activity-card__title">{item.title}</h2>
              <span className={memberRepairActivityStatusBadgeClass(item.status)}>
                {memberRepairActivityStatusLabels[item.status]}
              </span>
            </div>
            <dl className="activity-card__meta">
              <div>
                <dt>{copy.activityAt}</dt>
                <dd>{formatShanghaiDateTime(item.activityAt)}</dd>
              </div>
              <div>
                <dt>名额</dt>
                <dd>
                  {copy.capacity
                    .replace("{registered}", String(item.registeredCount))
                    .replace("{capacity}", String(item.capacity))}
                </dd>
              </div>
              <div>
                <dt>出勤</dt>
                <dd>{item.attended ? copy.attended : copy.notAttended}</dd>
              </div>
            </dl>
            <div className="activity-card__footer">
              <Button
                href={`/member/repair-activities/${item.id}`}
                trailingIcon="arrowUpRight"
                className={`border-line-strong before:hidden ${
                  item.status === "CLOSED" ? "bg-accent-wash text-accent-deep" : "text-ink"
                }`}
              >
                {copy.openBoard}
              </Button>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
