import { RankingRow } from "@/components/rankings/RankingRow";
import { memberCopy } from "@/config/member";
import type { MemberRankingPreview } from "@/types/contracts";

export function MemberRankingPreviewView({ preview }: { preview: MemberRankingPreview }) {
  if (!preview.available) return null;

  const copy = memberCopy.dashboard;

  return (
    <div className="ranking-preview">
      <p className="ranking-preview__meta">
        {copy.rankingTopLabel.replace("{count}", String(preview.leaders.length))}
      </p>

      {preview.leaders.length === 0 ? (
        <p className="member-section__note">{copy.rankingEmpty}</p>
      ) : (
        <ol className="ranking-list">
          {preview.leaders.map((entry) => (
            <RankingRow entry={entry} metric={preview.metric} key={entry.memberProfileId} />
          ))}
        </ol>
      )}

      <p className="ranking-preview__mine">
        <span className="ranking-preview__mine-label">{copy.rankingMyRank}</span>
        {preview.currentMember ? (
          <span className="ranking-preview__mine-value">
            {copy.rankingMyRankValue.replace("{rank}", String(preview.currentMember.rank))}
          </span>
        ) : (
          <span className="ranking-preview__mine-value">{copy.rankingNoRank}</span>
        )}
      </p>
    </div>
  );
}
