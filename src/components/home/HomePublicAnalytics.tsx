import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { homePublicAnalytics as copy } from "@/config/home";
import type { PublicHomeAnalytics } from "@/types/contracts";

type AnalyticsRow = { label: string; value: string; accent?: boolean };

/** 两张表共用标题、行结构和数值对齐；不改变公共 UI 组件 API。 */
function AnalyticsTable({
  title,
  tag,
  rows,
  message,
}: {
  title: string;
  tag: string;
  rows: AnalyticsRow[];
  message?: string;
}) {
  return (
    <Card className="home-analytics__panel">
      <table className="home-analytics__table">
        <caption>
          <span className="home-analytics__caption">
            <span>{title}</span>
            <span className="home-analytics__tag">{tag}</span>
          </span>
        </caption>
        <tbody>
          {message ? (
            <tr>
              <td colSpan={2} className="home-analytics__empty">
                {message}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={index}>
                <th scope="row">{row.label}</th>
                <td className={row.accent ? "is-accent" : undefined}>{row.value}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}

/** 只接收已按公开策略裁剪的 DTO，不接收内部排行或管理员设置。 */
export function HomePublicAnalytics({ data }: { data: PublicHomeAnalytics }) {
  if (!data.repairStats && !data.rankings) return null;
  const rows: AnalyticsRow[] = [];
  if (data.repairStats) {
    rows.push({
      label: copy.total,
      value: `${data.repairStats.totalApprovedCount.toLocaleString("zh-CN")} ${copy.countUnit}`,
      accent: true,
    });
    if (data.repairStats.details) {
      const { termApprovedCount, totalApprovedDurationMinutes } = data.repairStats.details;
      rows.push(
        {
          label: copy.term,
          value:
            termApprovedCount.status === "UNCONFIGURED"
              ? copy.unconfigured
              : `${termApprovedCount.value} ${copy.countUnit}`,
        },
        {
          label: copy.duration,
          value: `${(totalApprovedDurationMinutes / 60).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ${copy.durationUnit}`,
        },
      );
    }
  }
  return (
    <Section
      id="public-statistics"
      labelledBy="home-statistics-title"
      variant="plain"
      contained={false}
      className="home-analytics"
    >
      <h2 id="home-statistics-title" className="sr-only">
        {copy.title}
      </h2>
      {data.repairStats ? (
        <AnalyticsTable title={copy.statsTitle} tag={copy.statsTag} rows={rows} />
      ) : null}
      {data.rankings ? (
        <AnalyticsTable
          title={copy.rankingTitle}
          tag={copy.rankingTag}
          rows={data.rankings.items.map((item) => ({
            label: `${copy.rankLabel.replace("{rank}", String(item.rank))} · ${item.displayName}`,
            value: copy.rankingCount.replace("{count}", String(item.approvedCount)),
          }))}
          message={
            data.rankings.status === "UNCONFIGURED"
              ? copy.rankingUnconfigured
              : data.rankings.items.length === 0
                ? copy.rankingEmpty
                : undefined
          }
        />
      ) : null}
      <p className="home-analytics__note">{data.repairStats ? copy.note : copy.rankingNote}</p>
    </Section>
  );
}
