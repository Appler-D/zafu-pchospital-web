import { Card } from "@/components/ui/Card";
import { Readout, type ReadoutRow } from "@/components/ui/Readout";
import { Section } from "@/components/ui/Section";
import { SectionHead } from "@/components/ui/SectionHead";
import { SectionTitle } from "@/components/ui/SectionTitle";
import { homePublicAnalytics as copy } from "@/config/home";
import type { PublicHomeAnalytics } from "@/types/contracts";

/** 只接收已按公开策略裁剪的 DTO，不接收内部排行或管理员设置。 */
export function HomePublicAnalytics({ data }: { data: PublicHomeAnalytics }) {
  if (!data.repairStats && !data.rankings) return null;
  const rows: ReadoutRow[] = [];
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
    <Section id="public-statistics" labelledBy="home-statistics-title">
      <SectionHead index={copy.index} label={copy.label} />
      <div className="sec-titlebar">
        <SectionTitle id="home-statistics-title">{copy.title}</SectionTitle>
      </div>
      <div className="gap-s-5 grid lg:grid-cols-2">
        {data.repairStats ? (
          <Readout title={copy.statsTitle} tag={copy.statsTag} rows={rows} footnote={copy.note} />
        ) : null}
        {data.rankings ? (
          <Card>
            <h3 className="mb-s-4">{copy.rankingTitle}</h3>
            {data.rankings.status === "UNCONFIGURED" ? (
              <p className="muted">{copy.rankingUnconfigured}</p>
            ) : data.rankings.items.length === 0 ? (
              <p className="muted">{copy.rankingEmpty}</p>
            ) : (
              <ol className="ranking-list">
                {data.rankings.items.map((item, index) => (
                  <li className="gap-s-3 border-line py-s-3 flex items-center border-b" key={index}>
                    <span className="ranking-row__rank">
                      {copy.rankLabel.replace("{rank}", String(item.rank))}
                    </span>
                    <span className="ranking-row__name flex-1">{item.displayName}</span>
                    <span className="ranking-row__value">
                      {copy.rankingCount.replace("{count}", String(item.approvedCount))}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        ) : null}
      </div>
    </Section>
  );
}
