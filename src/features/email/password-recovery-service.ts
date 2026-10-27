import { randomUUID } from "node:crypto";
import { resolveAccountBlockedReason } from "@/features/auth/account-recovery";
import { emailChallengeService, type EmailChallengeService } from "./email-challenge-service";
import {
  passwordResetService,
  consumePasswordResetAuthorization,
  type PasswordResetService,
} from "./password-reset-service";
import { preoccupyPasswordRecoveryRequestQuota } from "./email-rate-limit";
import { passwordRecoveryCopy } from "@/config/password-recovery";
import { AppError } from "@/lib/api/errors";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { getMailConfig } from "@/lib/env";
import { normalizeQq } from "@/lib/security/normalization";
import { hashPassword } from "@/lib/security/secrets";
import { digestPasswordResetToken } from "@/lib/security/email-security";
import { EMAIL_CHALLENGE_TTL_MS } from "@/lib/security/email-policy";
import { isPasswordLengthValid, passwordLengthMessage } from "@/lib/security/password-policy";
import type {
  EmailCodeInput,
  PasswordRecoveryConfirmInput,
  PasswordRecoveryRequestInput,
  PasswordRecoveryServiceContract,
  PublicRequestContext,
} from "@/types/contracts";

const hiddenFailures = new Set([
  "ACCOUNT_DISABLED",
  "MEMBER_PROFILE_INACTIVE",
  "EMAIL_NOT_VERIFIED",
  "EMAIL_ALREADY_BOUND",
  "EMAIL_RATE_LIMITED",
  "EMAIL_BUDGET_EXHAUSTED",
  "EMAIL_SEND_FAILED",
  "EMAIL_SEND_UNCERTAIN",
  "EMAIL_CHALLENGE_INVALID",
]);
const invalidGrant = () =>
  new AppError("EMAIL_RESET_AUTHORIZATION_INVALID", passwordRecoveryCopy.invalidGrant);
const ANONYMOUS_TARGET = "00000000-0000-0000-0000-000000000000";
export class PasswordRecoveryService implements PasswordRecoveryServiceContract {
  constructor(
    private readonly deps: {
      challenges?: EmailChallengeService;
      reset?: PasswordResetService;
      now?: () => Date;
    } = {},
  ) {}
  private now = () => this.deps.now?.() ?? new Date();
  async request(input: PasswordRecoveryRequestInput, context: PublicRequestContext) {
    const qq = normalizeQq(input.qq);
    if (!getMailConfig().enabled)
      throw new AppError("EMAIL_NOT_ENABLED", "邮件功能暂不可用，请联系管理员");
    let at: Date;
    try {
      at = await inSerializableTransaction((tx) =>
        preoccupyPasswordRecoveryRequestQuota(tx, {
          qq,
          ipAddress: context.ipAddress,
          now: this.now,
        }),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "EMAIL_RATE_LIMITED")
        await this.auditRequest(context, qq, null, "FAILURE", error.code);
      throw error;
    }
    // 公共计数已提交，才允许查询 QQ；不合格结果不能退回请求额度。
    const identity = await getDb().userIdentity.findUnique({
      where: { type_identifierNormalized: { type: "QQ", identifierNormalized: qq } },
      include: {
        user: {
          include: {
            passwordCredential: true,
            memberProfile: true,
            roles: { where: { revokedAt: null }, include: { role: true } },
          },
        },
      },
    });
    let challengeId: string = randomUUID(),
      expiresAt = new Date(at.getTime() + EMAIL_CHALLENGE_TTL_MS).toISOString();
    let outcome = "UNAVAILABLE";
    const eligible =
      identity &&
      !identity.deletedAt &&
      identity.user.passwordCredential &&
      resolveAccountBlockedReason(identity.user, null) === null;
    if (eligible) {
      try {
        const sent = await (this.deps.challenges ?? emailChallengeService).requestEmailChallenge(
          { userId: identity.userId, purpose: "PASSWORD_RESET" },
          context,
          { anonymous: true },
        );
        challengeId = sent.challengeId;
        expiresAt = sent.expiresAt;
        outcome = "SENT";
      } catch (error) {
        if (!(error instanceof AppError) || !hiddenFailures.has(error.code)) throw error;
        outcome = error.code;
      }
    }
    await this.auditRequest(context, qq, identity?.userId ?? null, "SUCCESS", outcome);
    return { challengeId, expiresAt, message: passwordRecoveryCopy.accepted };
  }
  async verify(input: EmailCodeInput, context: PublicRequestContext) {
    const { token, expiresAt } = await (
      this.deps.reset ?? passwordResetService
    ).verifyChallengeAndIssue(input, context);
    return { token, expiresAt };
  }
  async confirm(
    token: string,
    input: PasswordRecoveryConfirmInput,
    context: PublicRequestContext,
  ): Promise<{ changed: true; destination: "/login" }> {
    if (
      typeof input.newPassword !== "string" ||
      typeof input.newPasswordConfirmation !== "string" ||
      !isPasswordLengthValid(input.newPassword)
    )
      throw new AppError("VALIDATION_FAILED", passwordLengthMessage());
    if (input.newPassword !== input.newPasswordConfirmation)
      throw new AppError("PASSWORD_CONFIRMATION_MISMATCH", "两次输入的新密码不一致");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidGrant();
    const digest = digestPasswordResetToken(token);
    // 只读预检避免为垃圾 token 做高成本哈希，真正授权仍由锁后的条件消费决定。
    const preview = await getDb().passwordResetAuthorization.findUnique({
      where: { tokenDigest: digest },
    });
    if (!preview || preview.status !== "ISSUED" || preview.expiresAt <= this.now())
      throw invalidGrant();
    const passwordHash = await hashPassword(input.newPassword);
    await inSerializableTransaction(async (tx) => {
      // 目标从授权摘要解析；凭据锁 -> 授权锁 -> 资格 / 身份读取 -> 条件更新 -> Session。
      // 与临时密码恢复 / 邮箱切换交叉时依赖既有 Serializable 有界重试，重试重新读取和取时。
      await tx.$queryRaw`SELECT user_id FROM password_credentials WHERE user_id = ${preview.userId} FOR UPDATE`;
      const proof = await consumePasswordResetAuthorization(tx, { token, context, now: this.now });
      const at = this.now();
      if (preview.expiresAt <= at) throw invalidGrant();
      const updated = await tx.passwordCredential.updateMany({
        where: { userId: proof.userId, credentialVersion: proof.credentialVersion ?? -1 },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: at,
          temporaryExpiresAt: null,
          temporaryConsumedAt: null,
          credentialVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw invalidGrant();
      await tx.authSession.updateMany({
        where: { userId: proof.userId, revokedAt: null },
        data: { revokedAt: at },
      });
      await tx.emailChallenge.updateMany({
        where: { userId: proof.userId, status: { in: ["ACTIVE", "PENDING"] } },
        data: { status: "INVALIDATED", finishedAt: at },
      });
      await tx.passwordResetAuthorization.updateMany({
        where: { userId: proof.userId, status: "ISSUED" },
        data: { status: "INVALIDATED", finishedAt: at },
      });
      for (const action of ["auth.password.recovered", "auth.session.revoked"])
        await appendAuditLog(tx, {
          actor: context,
          actorType: "USER",
          actorUserId: proof.userId,
          action,
          targetType: "User",
          targetId: proof.userId,
          result: "SUCCESS",
        });
    });
    return { changed: true, destination: "/login" };
  }
  private auditRequest(
    context: PublicRequestContext,
    qq: string,
    userId: string | null,
    result: "SUCCESS" | "FAILURE",
    outcome: string,
  ) {
    return inSerializableTransaction((tx) =>
      appendAuditLog(tx, {
        actor: context,
        actorType: "SYSTEM",
        action:
          result === "SUCCESS"
            ? "email.recovery.request.accepted"
            : "email.recovery.request.rejected",
        targetType: "User",
        targetId: userId ?? ANONYMOUS_TARGET,
        result,
        after: { qq, outcome },
      }),
    );
  }
}
export const passwordRecoveryService = new PasswordRecoveryService();
