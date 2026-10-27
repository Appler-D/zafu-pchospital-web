import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { resolveAccountBlockedReason } from "@/features/auth/account-recovery";
import {
  consumeEmailChallenge,
  EmailChallengeService,
  emailChallengeService,
} from "@/features/email/email-challenge-service";
import { AppError } from "@/lib/api/errors";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { getMailConfig } from "@/lib/env";
import {
  digestPasswordResetToken,
  generatePasswordResetToken,
} from "@/lib/security/email-security";
import { PASSWORD_RESET_AUTHORIZATION_TTL_MS } from "@/lib/security/email-policy";
import type {
  IssuePasswordResetAuthorizationResult,
  PasswordResetAuthorizationProof,
  PasswordResetServiceContract,
  PublicRequestContext,
  VerifyEmailChallengeInput,
} from "@/types/contracts";

/**
 * 密码重置授权服务。
 *
 * 本阶段只实现服务级链路：`PASSWORD_RESET` 挑战验证 → **原子**消费挑战并签发
 * 一次性重置授权；以及给后续阶段用的事务内条件消费原语。
 * **不做** HTTP 找回端点、不写密码、不撤销 Session、不自动登录。
 *
 * 授权是「用户自设密码」的一次性许可，不是临时密码、不是登录 Session；
 * 明文令牌只在签发返回值里出现一次，库里只有摘要。
 */

export type PasswordResetServiceDeps = {
  /** 注入测试用挑战服务（时间 / Sender / 验证码生成器随之注入）。 */
  challengeService?: EmailChallengeService;
  /** 注入时间（测试用）；缺省系统时间。 */
  now?: () => Date;
};

export class PasswordResetService implements PasswordResetServiceContract {
  private readonly challenges: EmailChallengeService;

  constructor(private readonly deps: PasswordResetServiceDeps = {}) {
    this.challenges = deps.challengeService ?? emailChallengeService;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * 「验证 PASSWORD_RESET 验证码 → 原子消费挑战并签发重置授权」。
   *
   * 资格在签发时重查（不接受调用方任意填写 userId）：挑战本身已由服务端绑定
   * 用户与当前有效已验证邮箱；这里再复核账号可用性、邮箱身份仍是同一个、
   * 凭据代次未被重置推进 —— 管理员刚重置过密码时，旧验证码不能兑换新代次授权。
   */
  async verifyChallengeAndIssue(
    input: VerifyEmailChallengeInput,
    context: PublicRequestContext,
  ): Promise<IssuePasswordResetAuthorizationResult> {
    const mail = getMailConfig();
    if (!mail.enabled) {
      throw new AppError("EMAIL_NOT_ENABLED", "邮件功能当前未启用");
    }
    // 用途在验证这一步就锁死：非 PASSWORD_RESET 的挑战直接拒绝且不计失败、
    // 不写「已验证」审计（若留到消费阶段才发现，会先记一笔误导性的成功审计）。
    const proof = await this.challenges.verifyEmailChallenge(
      { challengeId: input.challengeId, code: input.code, expectedPurpose: "PASSWORD_RESET" },
      context,
    );

    const token = generatePasswordResetToken();
    const tokenDigest = digestPasswordResetToken(token);
    const issued = await inSerializableTransaction(async (tx) => {
      // 先条件消费挑战（锁行 + 复核状态 / 期限 / 用途 / 摘要，成功一次）。
      const consumed = await consumeEmailChallenge(tx, {
        challengeId: input.challengeId,
        code: input.code,
        purpose: "PASSWORD_RESET",
      });
      const challenge = await tx.emailChallenge.findUniqueOrThrow({
        where: { id: consumed.challengeId },
      });

      // 账号资格：与登录 / 管理员恢复同一口径（无 SELF 概念 —— 自助找回本人）。
      const user = await tx.user.findUnique({
        where: { id: consumed.userId },
        include: {
          memberProfile: true,
          roles: { where: { revokedAt: null }, include: { role: true } },
        },
      });
      if (!user) throw invalidChallenge();
      if (resolveAccountBlockedReason(user, null) !== null) throw invalidChallenge();

      // 邮箱身份复核：仍是签发挑战时那条有效且已验证的 EMAIL 身份。
      if (!challenge.emailIdentityId) throw invalidChallenge();
      const identity = await tx.userIdentity.findUnique({
        where: { id: challenge.emailIdentityId },
      });
      if (
        !identity ||
        identity.deletedAt !== null ||
        identity.type !== "EMAIL" ||
        identity.verifiedAt === null ||
        identity.userId !== consumed.userId ||
        identity.identifierNormalized !== consumed.emailNormalized
      ) {
        throw invalidChallenge();
      }

      // 凭据代次复核：管理员重置推进代次后，旧验证码不得兑换新代次授权。
      const credential = await tx.passwordCredential.findUnique({
        where: { userId: consumed.userId },
      });
      const currentVersion = credential?.credentialVersion ?? null;
      if (currentVersion !== challenge.credentialVersion) throw invalidChallenge();

      // 资格读取全部完成后取时：锁等待 / 可串行化重试之后，
      // 签发期限基于实际写入时刻，不沿用消费挑战前的快照。
      const txNow = this.now();
      // 新授权使同一账号此前未消费的授权失效（一次性语义：同一时刻至多一个有效授权）。
      await tx.passwordResetAuthorization.updateMany({
        where: { userId: consumed.userId, status: "ISSUED" },
        data: { status: "INVALIDATED", finishedAt: txNow, updatedAt: txNow },
      });
      const grantId = randomUUID();
      const expiresAt = new Date(txNow.getTime() + PASSWORD_RESET_AUTHORIZATION_TTL_MS);
      await tx.passwordResetAuthorization.create({
        data: {
          id: grantId,
          userId: consumed.userId,
          emailIdentityId: identity.id,
          emailNormalized: consumed.emailNormalized,
          credentialVersion: currentVersion,
          tokenDigest,
          status: "ISSUED",
          expiresAt,
          finishedAt: null,
          createdAt: txNow,
          updatedAt: txNow,
        },
      });
      await appendAuditLog(tx, {
        actor: context,
        actorType: "USER",
        actorUserId: consumed.userId,
        action: "email.reset.authorization.issued",
        targetType: "PasswordResetAuthorization",
        targetId: grantId,
        result: "SUCCESS",
        // 明文令牌绝不进审计（`token` 键被脱敏器拦下），只记内部对象 ID 与期限。
        after: { grantId, expiresAt: expiresAt.toISOString() },
      });
      return { grantId, expiresAt };
    });

    return {
      grantId: issued.grantId,
      userId: proof.userId,
      token,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }
}

export const passwordResetService = new PasswordResetService();

function invalidChallenge(): AppError {
  return new AppError("EMAIL_CHALLENGE_INVALID", "验证码无效或已过期");
}

/**
 * 事务内条件消费原语（给后续「自设密码」阶段用）。
 *
 * 在调用方现有 Prisma 事务里：锁定授权行 → 用**锁后服务端时间**复核未消费 /
 * 未过期 → 复核账号仍可用、成员 / 管理员恢复资格与现有认证口径一致、仍是同一
 * 有效已验证邮箱身份、凭据代次未变 → 条件消费前再以当前时间复核期限
 * （资格读取期间可能跨过到期时刻）→ 条件消费（`ISSUED` → `CONSUMED`，
 * 并发下最多一次成功）。
 *
 * 后续阶段把「消费授权 + 写新密码 + 递增代次 + 撤销全部 Session / 其他授权」
 * 放进同一事务；任一步失败整笔回滚，授权不会被独立消费。
 */
export async function consumePasswordResetAuthorization(
  tx: Prisma.TransactionClient,
  input: { token: string; context: PublicRequestContext; now?: () => Date },
): Promise<PasswordResetAuthorizationProof> {
  const digest = digestPasswordResetToken(input.token);
  await tx.$queryRaw`SELECT id FROM password_reset_authorizations WHERE token_digest = ${digest} FOR UPDATE`;
  const row = await tx.passwordResetAuthorization.findUnique({
    where: { tokenDigest: digest },
  });
  const readNow = input.now?.() ?? new Date();
  if (!row || row.status !== "ISSUED" || row.expiresAt.getTime() <= readNow.getTime()) {
    throw invalidAuthorization();
  }

  const user = await tx.user.findUnique({
    where: { id: row.userId },
    include: {
      memberProfile: true,
      roles: { where: { revokedAt: null }, include: { role: true } },
    },
  });
  if (!user || resolveAccountBlockedReason(user, null) !== null) throw invalidAuthorization();

  const identity = await tx.userIdentity.findUnique({ where: { id: row.emailIdentityId } });
  if (
    !identity ||
    identity.deletedAt !== null ||
    identity.type !== "EMAIL" ||
    identity.verifiedAt === null ||
    identity.userId !== row.userId ||
    identity.identifierNormalized !== row.emailNormalized
  ) {
    throw invalidAuthorization();
  }

  const credential = await tx.passwordCredential.findUnique({ where: { userId: row.userId } });
  if ((credential?.credentialVersion ?? null) !== row.credentialVersion) {
    throw invalidAuthorization();
  }

  // 条件消费前用**当前**服务端时间复核期限：资格读取期间
  // 可能已跨过到期时刻，锁前读到的行快照不能当放行依据。
  const consumeNow = input.now?.() ?? new Date();
  if (row.expiresAt.getTime() <= consumeNow.getTime()) {
    throw invalidAuthorization();
  }
  const updated = await tx.passwordResetAuthorization.updateMany({
    where: { id: row.id, status: "ISSUED" },
    data: { status: "CONSUMED", finishedAt: consumeNow, updatedAt: consumeNow },
  });
  if (updated.count !== 1) throw invalidAuthorization();

  await appendAuditLog(tx, {
    actor: input.context,
    actorType: "USER",
    actorUserId: row.userId,
    action: "email.reset.authorization.consumed",
    targetType: "PasswordResetAuthorization",
    targetId: row.id,
    result: "SUCCESS",
    after: { grantId: row.id },
  });

  return {
    grantId: row.id,
    userId: row.userId,
    emailIdentityId: row.emailIdentityId,
    emailNormalized: row.emailNormalized,
    credentialVersion: row.credentialVersion,
  };
}

function invalidAuthorization(): AppError {
  return new AppError(
    "EMAIL_RESET_AUTHORIZATION_INVALID",
    "重置授权无效或已过期，请重新获取验证码",
  );
}
