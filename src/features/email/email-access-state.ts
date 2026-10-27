import type { Prisma } from "@/generated/prisma/client";

/**
 * 邮箱门禁所需的状态读取。
 *
 * 单独成模块的原因：认证守卫（`src/lib/auth/*`）必须在**不引入发信、SMTP 配置与
 * 认证服务**的前提下得到同一个「已验证邮箱 / 有效豁免」结论，否则会形成
 * `request → 邮箱 Service → request` 的依赖环。绑定与豁免管理侧（任务 4）同样复用
 * 这一份读取，判定规则全站只有一处。
 *
 * 这里只读数据库：不解析邮件配置、不发消息、不抛业务错误 —— 状态异常（多条身份、
 * 有身份但未验证）以受控结果返回，由调用方决定如何处理。
 */

export type EmailIdentityRow = {
  id: string;
  identifierNormalized: string;
  verifiedAt: Date | null;
};

export type EmailExemptionRow = {
  id: string;
  reason: string;
  expiresAt: Date;
};

/** 当前邮箱身份的分类结论。`UNVERIFIED` / `CONFLICT` 都不能算已验证。 */
export type CurrentEmailOutcome =
  | { kind: "MISSING" }
  | { kind: "VERIFIED"; identity: EmailIdentityRow }
  | { kind: "UNVERIFIED"; identity: EmailIdentityRow }
  | { kind: "CONFLICT"; count: number };

/**
 * 未删除的 EMAIL 身份行。
 *
 * 兼容口径：`activeEmailKey` 为空但 `verifiedAt` 已有值的历史身份同样有效 ——
 * 判定只看「有效且已验证」，不依赖那把唯一键，也不为此全库回填。
 */
export function readEmailIdentities(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<EmailIdentityRow[]> {
  return tx.userIdentity.findMany({
    where: { userId, type: "EMAIL", deletedAt: null },
    select: { id: true, identifierNormalized: true, verifiedAt: true },
    orderBy: { createdAt: "asc" },
  });
}

export function classifyCurrentEmail(rows: EmailIdentityRow[]): CurrentEmailOutcome {
  if (rows.length > 1) return { kind: "CONFLICT", count: rows.length };
  const row = rows[0];
  if (!row) return { kind: "MISSING" };
  return row.verifiedAt
    ? { kind: "VERIFIED", identity: row }
    : { kind: "UNVERIFIED", identity: row };
}

export type EmailAccessState = {
  outcome: CurrentEmailOutcome;
  /** 未撤销且**按读取后的当前时间**仍未到期的豁免；没有则为 `null`。 */
  exemption: EmailExemptionRow | null;
  /** 本次判定实际使用的时间（在阻塞读取完成之后取得）。 */
  at: Date;
};

/**
 * 一次读取邮箱状态：身份 + 豁免。
 *
 * 时间基准取**读取完成之后**（同一口径）：豁免 `now >= expiresAt`
 * 即失效，撤销 / 到期在下一次请求自然生效，不靠进程缓存或登录时快照。
 */
export async function readEmailAccessState(
  tx: Prisma.TransactionClient,
  userId: string,
  now: () => Date = () => new Date(),
): Promise<EmailAccessState> {
  const identities = await readEmailIdentities(tx, userId);
  const exemptions = await tx.emailExemption.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, reason: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
  });
  const at = now();
  const outcome = classifyCurrentEmail(identities);
  const exemption = exemptions.find((row) => row.expiresAt > at) ?? null;
  return { outcome, exemption, at };
}
