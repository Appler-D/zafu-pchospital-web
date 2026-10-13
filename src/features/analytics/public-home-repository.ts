import { getDb } from "@/lib/db/client";
import { PUBLIC_CONTENT_SETTINGS_ID } from "@/features/admin/public-content-settings-service";

/** 只读取对外策略，不读取修改人及其内部档案。 */
export async function readPublicHomePolicy() {
  return getDb().publicContentSetting.findUnique({
    where: { id: PUBLIC_CONTENT_SETTINGS_ID },
    select: {
      publicRepairStatsEnabled: true,
      publicRepairStatsDetailEnabled: true,
      publicRankingsEnabled: true,
      rankingDisplayName: true,
    },
  });
}
