import { disconnectDb } from "../src/lib/db/client";
import { purgeExpiredEmailSecurityRecords } from "../src/features/email/email-cleanup-service";

/**
 * 过期邮箱安全数据清理。
 *
 * 用法：
 *   corepack pnpm email:cleanup [--batch=500] [--max-rounds=50]
 *
 * - 只删保留期（7 天）外的已终结 / 过期挑战与授权，以及不再生效的计数桶；
 *   **不删**未到期记录、身份历史与业务审计；
 * - 有界分批（每轮每表最多 `--batch` 行），循环到没有可删记录或到 `--max-rounds`
 *   上限为止；可幂等重复执行，失败重跑即可；
 * - 清理不影响任何安全有效期（到期判定在读取时独立生效）。
 */

function readIntArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return fallback;
  const value = Number(raw.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} 必须是正整数`);
  }
  return value;
}

async function main(): Promise<void> {
  const batchSize = readIntArg("batch", 500);
  const maxRounds = readIntArg("max-rounds", 50);
  let totals = { challengesDeleted: 0, authorizationsDeleted: 0, countersDeleted: 0 };
  let rounds = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    const result = await purgeExpiredEmailSecurityRecords({ batchSize });
    rounds = round;
    totals = {
      challengesDeleted: totals.challengesDeleted + result.challengesDeleted,
      authorizationsDeleted: totals.authorizationsDeleted + result.authorizationsDeleted,
      countersDeleted: totals.countersDeleted + result.countersDeleted,
    };
    console.log(
      `第 ${round} 轮：挑战 ${result.challengesDeleted} / 授权 ${result.authorizationsDeleted} / 计数桶 ${result.countersDeleted}${result.hasMore ? "（仍有剩余，继续）" : ""}`,
    );
    if (!result.hasMore) break;
  }
  console.log(`完成（共 ${rounds} 轮）：${JSON.stringify(totals)}`);
}

main()
  .catch((error: unknown) => {
    console.error("清理失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
