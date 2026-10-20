import { shanghaiAcademicYearRange, type UtcRange } from "@/lib/academic-term";
import {
  RANKING_PREVIEW_LIMIT,
  type PublicHomeAnalytics,
  type RankingDisplayNameMode,
} from "@/types/contracts";
import {
  getPublicRepairSummary,
  listRankingMemberInfo,
  listRankingPage,
} from "./analytics-repository";
import { DISPLAY_NAME_FALLBACK, toSafeInteger } from "./analytics-policy";
import { readPublicHomePolicy } from "./public-home-repository";

/** 公开姓名不得复用内部回退链：「仅昵称」缺失时也不能回退实名或登录账号。 */
export function publicRankingName(
  mode: RankingDisplayNameMode,
  member?: { nickname: string | null; realName: string | null },
): string {
  if (mode === "HIDDEN") return DISPLAY_NAME_FALLBACK;
  if (mode === "REAL_NAME") return member?.realName?.trim() || DISPLAY_NAME_FALLBACK;
  if (mode === "NICKNAME") return member?.nickname?.trim() || DISPLAY_NAME_FALLBACK;
  return DISPLAY_NAME_FALLBACK;
}

async function loadRankings(
  mode: RankingDisplayNameMode,
  range: UtcRange,
): Promise<PublicHomeAnalytics["rankings"]> {
  // 排名、并列规则与成员榜单共用 M5 数据库聚合，不创建公开版排名算法。
  const rows = await listRankingPage("REPAIR_COUNT", range, 0, RANKING_PREVIEW_LIMIT);
  const members =
    mode === "HIDDEN" ? [] : await listRankingMemberInfo(rows.map((row) => row.memberProfileId));
  const byId = new Map(members.map((member) => [member.id, member]));
  return {
    items: rows.map((row) => ({
      rank: toSafeInteger(row.rankingPosition),
      displayName: publicRankingName(mode, byId.get(row.memberProfileId)),
      approvedCount: toSafeInteger(row.approvedCount),
    })),
  };
}

/** 每次首页请求读取策略；配置不可读时保守隐藏，单个数据区块失败不影响其它区块。 */
export const publicHomeService = {
  async get(now: Date = new Date()): Promise<PublicHomeAnalytics> {
    // 学年固定可算（9/1 → 次年 9/1），不再有「未配置」态；首页是 force-dynamic，
    // 因此跨年时下一次请求就会换成新学年，不需要重新构建。
    const year = shanghaiAcademicYearRange(now);
    const hidden: PublicHomeAnalytics = {
      academicYear: {
        label: year.label,
        startInclusive: year.startInclusive.toISOString(),
        endExclusive: year.endExclusive.toISOString(),
      },
      repairStats: null,
      rankings: null,
    };
    const policy = await readPublicHomePolicy().catch(() => null);
    if (!policy) return hidden;
    const [stats, rankings] = await Promise.allSettled([
      policy.publicRepairStatsEnabled
        ? getPublicRepairSummary(policy.publicRepairStatsDetailEnabled, year)
        : Promise.resolve(null),
      policy.publicRankingsEnabled
        ? loadRankings(policy.rankingDisplayName as RankingDisplayNameMode, year)
        : Promise.resolve(null),
    ]);
    return {
      ...hidden,
      repairStats: stats.status === "fulfilled" ? stats.value : null,
      rankings: rankings.status === "fulfilled" ? rankings.value : null,
    };
  },
};
