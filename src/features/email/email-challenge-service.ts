import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { resolveAccountBlockedReason } from "@/features/auth/account-recovery";
import {
  consumeEmailVerifyIpQuota,
  lockEmailVerificationFailureBucket,
  preoccupyEmailSendQuota,
  readEmailVerificationBlock,
  recordEmailVerificationFailure,
} from "@/features/email/email-rate-limit";
import { AppError } from "@/lib/api/errors";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { maskEmail } from "@/lib/audit/redaction";
import { buildEmailChallengeMessage, emailChallengeExpiresInMinutes } from "@/config/email";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { getMailConfig, type MailConfig } from "@/lib/env";
import {
  getDefaultEmailSender,
  type EmailDeliveryOutcome,
  type EmailSender,
} from "@/lib/email/mailer";
import { normalizeEmail } from "@/lib/security/normalization";
import {
  digestEmailCode,
  emailCodeDigestMatches,
  generateEmailCode,
} from "@/lib/security/email-security";
import { EMAIL_CHALLENGE_TTL_MS } from "@/lib/security/email-policy";
import {
  EmailChallengePurpose,
  type EmailChallengeProof,
  type EmailChallengeRequestResult,
  type EmailChallengeServiceContract,
  type RequestEmailChallengeInput,
  type PublicRequestContext,
  type VerifyEmailChallengeInput,
} from "@/types/contracts";

/**
 * 邮箱验证码挑战服务（/§5）。
 *
 * 发送顺序固定为三段（§5.2）：
 * 1. 短事务：预占额度 / 冷却 + 作废旧挑战 + 建待发送挑战（`PENDING`）；
 * 2. 事务外发送一次（SMTP 永远不持锁，也不进入自动重试回调）；
 * 3. 短事务记录发送结果：仅服务商**已接受**的挑战转 `ACTIVE` 可验证。
 *
 * 明确的保守取舍（产品口径）：成功、明确失败、超时 / 不确定都消耗已预占的额度与冷却，
 * 不退款不补发；失败 / 不确定的挑战不可验证，用户需在冷却后主动重发。
 */

export type EmailChallengeServiceDeps = {
  /** 注入测试 Sender；缺省按环境配置组装 SMTP 直发。 */
  sender?: EmailSender;
  /** 注入时间（测试用）；缺省系统时间。真实运行时始终用服务端当前时间。 */
  now?: () => Date;
  /** 注入验证码生成器（测试用）；缺省 crypto 安全随机 6 位数字。 */
  codeFactory?: () => string;
};

const CHALLENGE_PURPOSES = EmailChallengePurpose as readonly string[];

/** 验码决策结果：在串行事务内产出，事务外据此抛业务错误 / 返回证明（F1）。 */
type VerifyDecision =
  { kind: "BLOCKED"; blockedUntil: Date } | { kind: "INVALID" } | { kind: "OK" };

function assertChallengePurpose(value: unknown): EmailChallengePurpose {
  if (typeof value !== "string" || !CHALLENGE_PURPOSES.includes(value)) {
    throw new AppError("VALIDATION_FAILED", "验证码用途无效");
  }
  return value as EmailChallengePurpose;
}

/** 邮件未启用 / 配置不完整时统一在这里拒绝：不伪装成功，也不让应用因缺配置起不来。 */
function requireEnabledMailConfig(): Extract<MailConfig, { enabled: true }> {
  const config = getMailConfig();
  if (!config.enabled) {
    throw new AppError("EMAIL_NOT_ENABLED", "邮件功能当前未启用");
  }
  return config;
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 审计 targetId 是 CHAR(36)：用户输入形态未知时用零值占位，不把垃圾写进列。 */
function safeAuditTargetId(value: string): string {
  return UUID_LIKE.test(value) ? value : "00000000-0000-0000-0000-000000000000";
}

type ChallengeIdentity = {
  userId: string;
  emailNormalized: string;
  emailIdentityId: string | null;
  credentialVersion: number | null;
};

export class EmailChallengeService implements EmailChallengeServiceContract {
  constructor(private readonly deps: EmailChallengeServiceDeps = {}) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private get sender(): EmailSender {
    return this.deps.sender ?? getDefaultEmailSender();
  }

  /**
   * 签发验证码挑战并发出一封验证码邮件。
   *
   * 目标解析全部服务端权威（§4.1）：`EMAIL_CHANGE_OLD` / `PASSWORD_RESET` 的收件地址
   * 按当前**有效且已验证**的邮箱身份解析，调用方不能指定；`EMAIL_BIND` /
   * `EMAIL_CHANGE_NEW` 的地址来自调用方提交值，但必须通过规范化与全局归属检查。
   */
  async requestEmailChallenge(
    input: RequestEmailChallengeInput,
    context: PublicRequestContext,
    options: { anonymous?: boolean } = {},
  ): Promise<EmailChallengeRequestResult> {
    const mail = requireEnabledMailConfig();
    const purpose = assertChallengePurpose(input.purpose);
    const target = await this.resolveChallengeTarget(input, purpose);
    const code = (this.deps.codeFactory ?? generateEmailCode)();
    const challengeId = randomUUID();

    let expiresAt: Date;
    try {
      expiresAt = await inSerializableTransaction(async (tx) => {
        // ① 原子预占全部额度与冷却 —— 未预占成功不调用 SMTP（抛错即整体回滚，无消耗）。
        //    预占在**锁齐全部桶之后**取时并把它返回（补充）：
        //    锁等待 / 可串行化重试的经过时间都体现在预占时刻上，挑战的
        //    createdAt / expiresAt 与冷却 / 窗口全部以该时刻为准，不沿用请求开始快照。
        const txNow = await preoccupyEmailSendQuota(tx, {
          userId: target.userId,
          emailNormalized: target.emailNormalized,
          ipAddress: context.ipAddress ?? null,
          now: () => this.now(),
          dailyBudget: mail.dailyBudget,
        });
        // ② 同一（用户, 用途）的未终结挑战整批失效 —— 包括发往不同目标邮箱的旧挑战；
        //    「发新挑战使前一个失效」不区分目标。串行化：上面刚锁过该用户共用的冷却 /
        //    每日桶，同一用户的签到族请求在这里必然排成先后。
        await tx.emailChallenge.updateMany({
          where: { userId: target.userId, purpose, status: { in: ["PENDING", "ACTIVE"] } },
          data: { status: "INVALIDATED", finishedAt: txNow, updatedAt: txNow },
        });
        // ③ 建待发送挑战（PENDING：只有发送结果被确认接受后才转 ACTIVE）。
        const txExpiresAt = new Date(txNow.getTime() + EMAIL_CHALLENGE_TTL_MS);
        await tx.emailChallenge.create({
          data: {
            id: challengeId,
            userId: target.userId,
            purpose,
            targetEmailNormalized: target.emailNormalized,
            emailIdentityId: target.emailIdentityId,
            credentialVersion: target.credentialVersion,
            codeDigest: digestEmailCode({
              challengeId,
              userId: target.userId,
              purpose,
              emailNormalized: target.emailNormalized,
              code,
            }),
            status: "PENDING",
            expiresAt: txExpiresAt,
            finishedAt: null,
            createdAt: txNow,
            updatedAt: txNow,
          },
        });
        await appendAuditLog(tx, {
          actor: context,
          actorType: options.anonymous ? "SYSTEM" : "USER",
          actorUserId: options.anonymous ? undefined : target.userId,
          action: "email.challenge.requested",
          targetType: "EmailChallenge",
          targetId: challengeId,
          result: "SUCCESS",
          after: { purpose, expiresAt: txExpiresAt.toISOString() },
        });
        return txExpiresAt;
      });
    } catch (error) {
      // 限流 / 预算拒绝也是「挑战申请」的结果，留痕供审计筛选（其余入口校验错误不写）。
      if (
        error instanceof AppError &&
        (error.code === "EMAIL_RATE_LIMITED" || error.code === "EMAIL_BUDGET_EXHAUSTED")
      ) {
        await this.writeAudit(context, {
          action: "email.challenge.requested",
          targetId: "00000000-0000-0000-0000-000000000000",
          result: "FAILURE",
          errorCode: error.code,
          after: { userId: target.userId, purpose },
        });
      }
      throw error;
    }

    // 事务外发送一次；接口异常也不放行验证（按不确定处理）。
    let outcome: EmailDeliveryOutcome;
    try {
      outcome = await this.sender.send({
        to: target.emailNormalized,
        ...buildEmailChallengeMessage({
          purpose,
          code,
          expiresInMinutes: emailChallengeExpiresInMinutes,
        }),
      });
    } catch {
      outcome = { status: "UNCERTAIN" };
    }

    const recorded = await recordChallengeSendResult({
      challengeId,
      outcome,
      context,
      // 传时间提供者：结果记录事务拿到挑战行锁后重新取时。
      now: () => this.now(),
    });

    if (outcome.status === "ACCEPTED") {
      if (recorded === "ACTIVATED") {
        return {
          challengeId,
          maskedEmail: maskEmail(target.emailNormalized),
          expiresAt: expiresAt.toISOString(),
        };
      }
      // 发送结果迟到、挑战已被后续签发替代：不激活、不伪装成功。
      throw new AppError("EMAIL_CHALLENGE_INVALID", "本次验证码已失效，请使用最新收到的验证码");
    }
    if (outcome.status === "FAILED") {
      throw new AppError("EMAIL_SEND_FAILED", "验证码邮件发送失败，请稍后重试");
    }
    throw new AppError("EMAIL_SEND_UNCERTAIN", "邮件发送结果未知，请稍后重试");
  }

  /**
   * 独立校验一次验证码（**不消费**）。
   *
   * 账号级串行化：按（账号, 用途）锁定失败计数行后，
   * 「检查阻断 → 判定验证码 / 状态 → 记失败」在同一事务里完成 —— 重发前后的不同
   * 挑战、换 IP 与并发请求都无法在「读到未阻断」之后各自继续：5 次上限精确成立。
   * 失败计数与该次失败审计随决策事务**先行提交**，之后才向调用方抛业务错误。
   * IP 校验请求桶仍按每次调用计数（独立事务）；用途 / 目标不符属服务端调用方
   * 用法问题，直接拒绝且**不计入**用户失败次数。
   *
   * 调用方拿到证明后，仍必须在自己的事务里用 {@link consumeEmailChallenge} 做条件消费：
   * 同一挑战并发下最多一份有效证明。
   */
  async verifyEmailChallenge(
    input: VerifyEmailChallengeInput,
    context: PublicRequestContext,
  ): Promise<EmailChallengeProof> {
    requireEnabledMailConfig();
    const challenge =
      typeof input.challengeId === "string"
        ? await getDb().emailChallenge.findUnique({ where: { id: input.challengeId } })
        : null;

    // IP 校验请求桶：每次调用计一次（与账号失败桶共同生效）。超限回滚本次计数并拒绝；
    // 时间以提供者传入，桶锁等待完成后才取时（补充）。
    try {
      await inSerializableTransaction((tx) =>
        consumeEmailVerifyIpQuota(tx, context.ipAddress ?? null, () => this.now()),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "EMAIL_RATE_LIMITED") {
        await this.writeAudit(context, {
          action: "email.challenge.verify_blocked",
          targetId: challenge ? challenge.id : safeAuditTargetId(String(input.challengeId ?? "")),
          result: "FAILURE",
          errorCode: "EMAIL_RATE_LIMITED",
          after: challenge
            ? { purpose: challenge.purpose, reason: "IP_LIMIT" }
            : { reason: "IP_LIMIT" },
        });
      }
      throw error;
    }

    if (!challenge) {
      await this.writeAudit(context, {
        action: "email.challenge.verify_failed",
        targetId: safeAuditTargetId(String(input.challengeId ?? "")),
        result: "FAILURE",
        errorCode: "EMAIL_CHALLENGE_INVALID",
      });
      throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
    }

    if (input.expectedUserId !== undefined && challenge.userId !== input.expectedUserId) {
      throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
    }
    if (input.expectedPurpose !== undefined && challenge.purpose !== input.expectedPurpose) {
      throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
    }
    if (
      input.expectedEmailNormalized !== undefined &&
      challenge.targetEmailNormalized !== input.expectedEmailNormalized
    ) {
      throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
    }

    const decision = await inSerializableTransaction<VerifyDecision>(async (tx) => {
      // 先锁（账号, 用途）失败桶：同一账号的并发验码在这里排成先后（F1）。
      await lockEmailVerificationFailureBucket(tx, {
        userId: challenge.userId,
        purpose: challenge.purpose,
      });
      // 锁后取时（F3）：阻断检查与失败窗口都按实际判定时刻，不用请求开始时的快照。
      const decisionNow = this.now();
      const blockedUntil = await readEmailVerificationBlock(
        tx,
        { userId: challenge.userId, purpose: challenge.purpose },
        decisionNow,
      );
      if (blockedUntil) return { kind: "BLOCKED", blockedUntil };

      const stateUsable =
        challenge.status === "ACTIVE" && challenge.expiresAt.getTime() > decisionNow.getTime();
      const codeMatches = emailCodeDigestMatches(
        digestEmailCode({
          challengeId: challenge.id,
          userId: challenge.userId,
          purpose: challenge.purpose,
          emailNormalized: challenge.targetEmailNormalized,
          code: String(input.code ?? ""),
        }),
        challenge.codeDigest,
      );
      if (!stateUsable || !codeMatches) {
        // 失败计数与审计随本事务提交：向外抛错前必须已经持久化（任务书 §4.1）。
        await recordEmailVerificationFailure(
          tx,
          { userId: challenge.userId, purpose: challenge.purpose },
          decisionNow,
        );
        await appendAuditLog(tx, {
          actor: context,
          actorType: "SYSTEM",
          action: "email.challenge.verify_failed",
          targetType: "EmailChallenge",
          targetId: challenge.id,
          result: "FAILURE",
          errorCode: "EMAIL_CHALLENGE_INVALID",
          after: { userId: challenge.userId, purpose: challenge.purpose },
        });
        return { kind: "INVALID" };
      }
      return { kind: "OK" };
    });

    if (decision.kind === "BLOCKED") {
      await this.writeAudit(context, {
        action: "email.challenge.verify_blocked",
        targetId: challenge.id,
        result: "FAILURE",
        errorCode: "EMAIL_RATE_LIMITED",
        after: {
          userId: challenge.userId,
          purpose: challenge.purpose,
          blockedUntil: decision.blockedUntil.toISOString(),
        },
      });
      throw new AppError("EMAIL_RATE_LIMITED", "验证尝试过于频繁，请稍后再试");
    }
    if (decision.kind === "INVALID") {
      throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
    }

    await this.writeAudit(context, {
      action: "email.challenge.verified",
      targetId: challenge.id,
      result: "SUCCESS",
      after: { userId: challenge.userId, purpose: challenge.purpose },
    });
    return {
      challengeId: challenge.id,
      userId: challenge.userId,
      purpose: challenge.purpose as EmailChallengePurpose,
      emailNormalized: challenge.targetEmailNormalized,
    };
  }

  /* ------------------------------------------------------------ 内部工具 */

  private async writeAudit(
    context: PublicRequestContext,
    event: {
      action: string;
      targetId: string;
      result: "SUCCESS" | "FAILURE";
      errorCode?: string;
      after?: unknown;
    },
  ): Promise<void> {
    await inSerializableTransaction((tx) =>
      appendAuditLog(tx, {
        actor: context,
        actorType: "SYSTEM",
        action: event.action,
        targetType: "EmailChallenge",
        targetId: event.targetId,
        result: event.result,
        errorCode: event.errorCode,
        after: event.after,
      }),
    );
  }

  /** 目标解析与资格检查（服务端权威）。 */
  private async resolveChallengeTarget(
    input: RequestEmailChallengeInput,
    purpose: EmailChallengePurpose,
  ): Promise<ChallengeIdentity> {
    const db = getDb();
    const user = await db.user.findUnique({
      where: { id: input.userId },
      include: {
        memberProfile: true,
        passwordCredential: true,
        roles: { where: { revokedAt: null }, include: { role: true } },
      },
    });
    if (!user || user.deletedAt || user.status !== "ACTIVE") {
      throw new AppError("ACCOUNT_DISABLED", "账号当前不可用");
    }
    const blocked = resolveAccountBlockedReason(user, null);
    if (blocked === "DISABLED") throw new AppError("ACCOUNT_DISABLED", "账号当前不可用");
    if (blocked === "MEMBER_INACTIVE") {
      throw new AppError("MEMBER_PROFILE_INACTIVE", "成员身份当前不可用");
    }

    const emailRows = await db.userIdentity.findMany({
      where: { userId: user.id, type: "EMAIL", deletedAt: null, verifiedAt: { not: null } },
    });
    if (emailRows.length > 1)
      throw new AppError("EMAIL_ALREADY_BOUND", "当前邮箱身份存在冲突，请联系管理员");
    const currentEmail = emailRows[0] ?? null;
    if (purpose === "EMAIL_CHANGE_OLD" || purpose === "PASSWORD_RESET") {
      if (input.targetEmail !== undefined) {
        throw new AppError("VALIDATION_FAILED", "该用途的收件地址由服务端按当前有效邮箱解析");
      }
      const identity = currentEmail;
      if (!identity) {
        throw new AppError("EMAIL_NOT_VERIFIED", "当前账号还没有已验证的邮箱");
      }
      return {
        userId: user.id,
        emailNormalized: identity.identifierNormalized,
        emailIdentityId: identity.id,
        credentialVersion: user.passwordCredential?.credentialVersion ?? null,
      };
    }

    // EMAIL_BIND / EMAIL_CHANGE_NEW：目标来自调用方提交值，但必须过规范化与全局归属。
    const emailNormalized = normalizeEmail(input.targetEmail);
    const existingRows = await db.userIdentity.findMany({
      where: { type: "EMAIL", identifierNormalized: emailNormalized },
      select: { userId: true, deletedAt: true },
    });
    // 邮箱不释放、不跨账号转移（任务书 §3.1）：任何归属其它账号的行（含软删除历史行）
    // 都意味着这个地址不可能再绑给当前用户 —— 提前拒绝，不发无意义的验证码。
    if (existingRows.some((row) => row.userId !== user.id)) {
      throw new AppError("EMAIL_ALREADY_BOUND", "该邮箱已被其他账号使用");
    }
    // 自己的**生效中**行 = 已经绑定（BIND / CHANGE_NEW 都无事可做）；
    // 自己的软删除历史行允许走「重新验证激活」的流程（本挑战只负责验证）。
    if (existingRows.some((row) => row.deletedAt === null)) {
      throw new AppError("EMAIL_ALREADY_BOUND", "该邮箱已经是当前账号的绑定邮箱");
    }
    return {
      userId: user.id,
      emailNormalized,
      emailIdentityId: currentEmail?.id ?? null,
      credentialVersion: user.passwordCredential?.credentialVersion ?? null,
    };
  }
}

export const emailChallengeService = new EmailChallengeService();

/* ---------------------------------------------------------------- 消费原语 */

/**
 * 事务内「条件消费」原语（绑定 / 换绑流程与重置服务共用）。
 *
 * - 锁挑战行后用**锁后服务端时间**校验：未过期、状态 `ACTIVE`、用途一致、
 *   目标一致（给定时）、验证码摘要恒定时间比对；
 * - 只有条件更新命中一行才视为消费成功 —— 同一挑战并发消费最多一份有效证明；
 * - 业务写入与消费共用调用方事务：后续绑定失败时整笔回滚，不会「验证码先被独立消费」。
 *
 * 本原语**不做失败计数**：调用方应先用 `verifyEmailChallenge` 完成一次（带计数与
 * IP 桶的）校验，再在事务里消费；直接调用本原语的路径由挑战状态与摘要比对兜底。
 * 消费成功不写审计（校验事件已由 verify 记录），重置流程在签发授权时统一留痕。
 */
export async function consumeEmailChallenge(
  tx: Prisma.TransactionClient,
  input: {
    challengeId: string;
    code: string;
    purpose: EmailChallengePurpose;
    emailNormalized?: string;
    expectedUserId?: string;
    now?: () => Date;
  },
): Promise<EmailChallengeProof> {
  await tx.$queryRaw`SELECT id FROM email_challenges WHERE id = ${input.challengeId} FOR UPDATE`;
  const row = await tx.emailChallenge.findUnique({ where: { id: input.challengeId } });
  const now = input.now?.() ?? new Date();
  if (row && input.expectedUserId !== undefined && row.userId !== input.expectedUserId) {
    throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
  }
  if (!row || row.status !== "ACTIVE" || row.expiresAt.getTime() <= now.getTime()) {
    throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
  }
  if (row.purpose !== input.purpose) {
    throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
  }
  if (input.emailNormalized !== undefined && row.targetEmailNormalized !== input.emailNormalized) {
    throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
  }
  const codeMatches = emailCodeDigestMatches(
    digestEmailCode({
      challengeId: row.id,
      userId: row.userId,
      purpose: row.purpose,
      emailNormalized: row.targetEmailNormalized,
      code: String(input.code ?? ""),
    }),
    row.codeDigest,
  );
  if (!codeMatches) {
    throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
  }
  const updated = await tx.emailChallenge.updateMany({
    where: { id: row.id, status: "ACTIVE" },
    data: { status: "CONSUMED", finishedAt: now, updatedAt: now },
  });
  if (updated.count !== 1) {
    throw new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
  }
  return {
    challengeId: row.id,
    userId: row.userId,
    purpose: row.purpose as EmailChallengePurpose,
    emailNormalized: row.targetEmailNormalized,
  };
}

/* ------------------------------------------------------------ 发送结果记录 */

/**
 * 记录一次发送结果（短事务）。
 *
 * - 只有仍为 `PENDING` 且未过期的**本代**挑战可以从「已接受」转 `ACTIVE`：
 *   迟到的发送结果不得复活已被后续签发替代（`INVALIDATED`）的挑战；
 * - 判定时间在拿到挑战行锁之后重新取得—— 等待锁期间
 *   跨过有效期时，迟到的「已接受」不得再激活挑战；
 * - 失败 / 不确定的挑战保持 `PENDING`（不可验证），到期由清理收走，不恢复发送；
 * - 挑战行已被清理时同样只记录一条丢弃审计。
 */
async function recordChallengeSendResult(input: {
  challengeId: string;
  outcome: EmailDeliveryOutcome;
  context: PublicRequestContext;
  now: () => Date;
}): Promise<"ACTIVATED" | "DISCARDED" | "FAILED"> {
  return inSerializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM email_challenges WHERE id = ${input.challengeId} FOR UPDATE`;
    const row = await tx.emailChallenge.findUnique({ where: { id: input.challengeId } });
    const lockedNow = input.now();
    if (!row) {
      await appendAuditLog(tx, {
        actor: input.context,
        actorType: "SYSTEM",
        action: "email.challenge.send_discarded",
        targetType: "EmailChallenge",
        targetId: safeAuditTargetId(input.challengeId),
        result: "FAILURE",
        errorCode: "EMAIL_CHALLENGE_INVALID",
      });
      return "DISCARDED";
    }
    if (input.outcome.status === "ACCEPTED") {
      if (row.status === "PENDING" && row.expiresAt.getTime() > lockedNow.getTime()) {
        await tx.emailChallenge.updateMany({
          where: { id: row.id, status: "PENDING" },
          data: { status: "ACTIVE", updatedAt: lockedNow },
        });
        await appendAuditLog(tx, {
          actor: input.context,
          actorType: "SYSTEM",
          action: "email.challenge.sent",
          targetType: "EmailChallenge",
          targetId: row.id,
          result: "SUCCESS",
          after: {
            userId: row.userId,
            purpose: row.purpose,
            expiresAt: row.expiresAt.toISOString(),
          },
        });
        return "ACTIVATED";
      }
      await appendAuditLog(tx, {
        actor: input.context,
        actorType: "SYSTEM",
        action: "email.challenge.send_discarded",
        targetType: "EmailChallenge",
        targetId: row.id,
        result: "FAILURE",
        errorCode: "EMAIL_CHALLENGE_INVALID",
        after: { userId: row.userId, purpose: row.purpose },
      });
      return "DISCARDED";
    }
    await appendAuditLog(tx, {
      actor: input.context,
      actorType: "SYSTEM",
      action: "email.challenge.send_failed",
      targetType: "EmailChallenge",
      targetId: row.id,
      result: "FAILURE",
      errorCode: input.outcome.status === "FAILED" ? "EMAIL_SEND_FAILED" : "EMAIL_SEND_UNCERTAIN",
      after: { userId: row.userId, purpose: row.purpose },
    });
    return "FAILED";
  });
}
