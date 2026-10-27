import { getDb } from "@/lib/db/client";
import { EMAIL_SECURITY_RETENTION_MS } from "@/lib/security/email-policy";

/**
 * 过期邮箱安全数据的有界清理。
 *
 * - **有界**：每张表单次最多删 `batchSize` 行（先按到期索引选主键再按主键删，
 *   不让一次 DELETE 扫全表）；返回 `hasMore` 供调用方决定是否继续；
 * - **幂等**：可反复执行；只删「保留期外」的记录；
 * - **不越界**：不删未到期挑战 / 授权、不删身份历史（`user_identities` 一行都不动）、
 *   不删业务审计。清理失败（连接中断等）不影响任何安全有效期 —— 到期判定都在读取时。
 *
 * 调用方式见 `docs/contracts/data-contract.md`；本期不安装 cron / 定时任务。
 */

export type EmailCleanupResult = {
  challengesDeleted: number;
  authorizationsDeleted: number;
  countersDeleted: number;
  /** 任一表的删除触到批次上限时为 true：调用方应再跑一轮。 */
  hasMore: boolean;
};

export const EMAIL_CLEANUP_DEFAULT_BATCH = 500;
const MAX_BATCH = 5_000;

export async function purgeExpiredEmailSecurityRecords(
  input: {
    now?: Date;
    batchSize?: number;
    /** 仅测试注入：候选选出后、计数桶删除前的时点钩子（验证删除侧复检生效）。 */
    beforeCounterDelete?: () => Promise<void>;
  } = {},
): Promise<EmailCleanupResult> {
  const now = input.now ?? new Date();
  const batchSize = Math.min(
    Math.max(input.batchSize ?? EMAIL_CLEANUP_DEFAULT_BATCH, 1),
    MAX_BATCH,
  );
  const retentionCutoff = new Date(now.getTime() - EMAIL_SECURITY_RETENTION_MS);
  const db = getDb();

  // 挑战：已终结（CONSUMED / INVALIDATED）按 finished_at 判保留期；未终结但已过期的
  // 按 expires_at 判 —— 过期挑战本就不可验证，保留 7 天只为事后排查。
  const finishedChallenges = await db.emailChallenge.findMany({
    where: { finishedAt: { lt: retentionCutoff } },
    select: { id: true },
    take: batchSize,
  });
  const expiredChallenges = await db.emailChallenge.findMany({
    where: { status: { in: ["PENDING", "ACTIVE"] }, expiresAt: { lt: retentionCutoff } },
    select: { id: true },
    take: batchSize,
  });
  const challengeIds = [...finishedChallenges, ...expiredChallenges].map((row) => row.id);
  let challengesDeleted = 0;
  if (challengeIds.length > 0) {
    const result = await db.emailChallenge.deleteMany({ where: { id: { in: challengeIds } } });
    challengesDeleted = result.count;
  }

  // 授权：同挑战口径（ISSUED 且过期 / 已消费 / 已作废）。
  const finishedAuthorizations = await db.passwordResetAuthorization.findMany({
    where: { finishedAt: { lt: retentionCutoff } },
    select: { id: true },
    take: batchSize,
  });
  const expiredAuthorizations = await db.passwordResetAuthorization.findMany({
    where: { status: "ISSUED", expiresAt: { lt: retentionCutoff } },
    select: { id: true },
    take: batchSize,
  });
  const authorizationIds = [...finishedAuthorizations, ...expiredAuthorizations].map(
    (row) => row.id,
  );
  let authorizationsDeleted = 0;
  if (authorizationIds.length > 0) {
    const result = await db.passwordResetAuthorization.deleteMany({
      where: { id: { in: authorizationIds } },
    });
    authorizationsDeleted = result.count;
  }

  // 计数桶：窗口已过期且不再有未到期的阻断时才惰性（不对任何窗口产生影响）。
  const staleCounters = await db.emailSecurityCounter.findMany({
    where: {
      windowExpiresAt: { lt: now },
      OR: [{ blockedUntil: null }, { blockedUntil: { lt: now } }],
    },
    select: { bucketKeyDigest: true },
    take: batchSize,
  });
  let countersDeleted = 0;
  if (staleCounters.length > 0) {
    await input.beforeCounterDelete?.();
    // 候选选出后桶可能被续用（窗口顺延 / 新阻断），删除条件必须复检同一有效性
    // 续用过的桶留在原地，不做仅按主键的删除。
    const result = await db.emailSecurityCounter.deleteMany({
      where: {
        bucketKeyDigest: { in: staleCounters.map((row) => row.bucketKeyDigest) },
        windowExpiresAt: { lt: now },
        OR: [{ blockedUntil: null }, { blockedUntil: { lt: now } }],
      },
    });
    countersDeleted = result.count;
  }

  return {
    challengesDeleted,
    authorizationsDeleted,
    countersDeleted,
    hasMore:
      finishedChallenges.length >= batchSize ||
      expiredChallenges.length >= batchSize ||
      finishedAuthorizations.length >= batchSize ||
      expiredAuthorizations.length >= batchSize ||
      staleCounters.length >= batchSize,
  };
}
