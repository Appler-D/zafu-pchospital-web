"use client";

import { useCallback, useEffect, useState } from "react";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { DashStat, DashStats, DashTile } from "@/components/ui/dash";
import { adminCopy, adminNavGroups } from "@/config/admin";
import type { AdminDashboardSummary } from "@/features/admin/admin-dashboard";
import { buildCommitInfo } from "@/lib/build-info";

/** 待办与模块目录；加载失败与零待办分别显示。 */

export function AdminHome() {
  const copy = adminCopy.home;
  const [summary, setSummary] = useState<AdminDashboardSummary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [today, setToday] = useState<string | null>(null);

  useEffect(() => {
    setToday(
      new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
        timeZone: "Asia/Shanghai",
      }).format(new Date()),
    );
  }, []);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch("/api/v1/admin/dashboard", { cache: "no-store" });
      const json = await response.json();
      if (!json.success) throw new Error(json?.error?.code ?? "DASHBOARD_FAILED");
      setSummary(json.data as AdminDashboardSummary);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const allClear =
    summary !== null &&
    summary.repairsPending === 0 &&
    summary.recruitmentFollowup === 0 &&
    summary.provisionFailed === 0;

  return (
    <>
      <header className="dash-hero">
        <div className="dash-hero__text">
          <p className="dash-hero__eyebrow">{adminCopy.titleEn}</p>
          <h1 className="dash-hero__name" id="admin-home-title">
            {adminCopy.title}
          </h1>
          <p className="dash-hero__meta">
            {today ? <span>{today}</span> : null}
            <span
              className="dash-hero__version"
              title={
                buildCommitInfo.commit
                  ? copy.versionTitle.replace("{sha}", buildCommitInfo.commit)
                  : undefined
              }
            >
              {copy.versionLabel} <b>{buildCommitInfo.short || copy.versionUnknown}</b>
            </span>
          </p>
        </div>
      </header>

      {state === "error" ? (
        <Card variant="notice">
          <p>{copy.todoLoadFailed}</p>
          <Button onClick={() => void load()}>{copy.retry}</Button>
        </Card>
      ) : null}

      {state === "loading" ? (
        <div className="dash-skeleton" role="status" aria-live="polite">
          <div className="dash-skeleton__stats" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((index) => (
              <span className="dash-skeleton__bar dash-skeleton__bar--stat" key={index} />
            ))}
          </div>
        </div>
      ) : null}

      {state === "ready" && summary ? (
        <section className="dash-block" aria-labelledby="admin-todo-title">
          <div className="dash-block__head">
            <h2 className="dash-block__title" id="admin-todo-title">
              {copy.todoTitle}
            </h2>
            <span className="dash-block__tag">{copy.todoTag}</span>
          </div>
          <DashStats>
            <DashStat
              label={copy.todoRepairs}
              value={summary.repairsPending}
              hint={copy.todoRepairsHint}
              href="/admin/repairs"
              active
            />
            <DashStat
              label={copy.todoRecruitment}
              value={summary.recruitmentFollowup}
              hint={copy.todoRecruitmentHint}
              href="/admin/join-applications"
              active
            />
            <DashStat
              label={copy.todoProvisionFailed}
              value={summary.provisionFailed}
              hint={copy.todoProvisionFailedHint}
              href="/admin/join-applications"
              active
            />
            <DashStat
              label={copy.todoInvites}
              value={summary.inviteActive}
              hint={copy.todoInvitesHint}
              href="/admin/invite-codes"
            />
            <DashStat
              label={copy.todoMembers}
              value={summary.memberTotal}
              hint={copy.todoMembersHint}
              href="/admin/members"
            />
          </DashStats>
          {allClear ? <p className="dash-allclear">{copy.todoAllClear}</p> : null}
        </section>
      ) : null}

      <section className="dash-block" aria-labelledby="admin-directory-title">
        <div className="dash-block__head">
          <h2 className="dash-block__title" id="admin-directory-title">
            {copy.directoryTitle}
          </h2>
          <span className="dash-block__tag">{copy.directoryTag}</span>
        </div>
        <div className="dash-directory">
          {adminNavGroups.map((group) => (
            <div className="dash-directory__group" key={group.id}>
              <h3 className="dash-directory__title">{group.title}</h3>
              <div className="dash-directory__grid">
                {group.items.map((item) => (
                  <DashTile
                    key={item.href}
                    icon={item.icon ?? "fileText"}
                    label={item.label}
                    desc={copy.directoryDesc[item.href]}
                    href={item.href}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
