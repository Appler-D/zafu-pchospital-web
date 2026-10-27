import { randomUUID } from "node:crypto";
import type { AccountNotification, Prisma } from "@/generated/prisma/client";
import {
  ACCOUNT_NOTIFICATION_KIND,
  ACCOUNT_NOTIFICATION_LEASE_MS,
  ACCOUNT_NOTIFICATION_MAX_ATTEMPTS,
  ACCOUNT_NOTIFICATION_RETRY_MS,
  buildAccountNotificationMessage,
} from "@/config/account-notification";
import { resolveAccountBlockedReason } from "@/features/auth/account-recovery";
import { AppError } from "@/lib/api/errors";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { requirePermission } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { getMailConfig, type MailConfig } from "@/lib/env";
import {
  createSmtpEmailSender,
  type EmailSender,
  type EmailDeliveryOutcome,
  type EmailMessage,
} from "@/lib/email/mailer";
import { initialPasswordFromQq, normalizeEmail } from "@/lib/security/normalization";
import { verifyPassword } from "@/lib/security/secrets";
import type {
  AccountNotificationBatchResult,
  AccountNotificationServiceContract,
  AccountNotificationView,
  AuthorizedActor,
} from "@/types/contracts";
import { preoccupyGlobalEmailBudget } from "./email-rate-limit";

type Tx = Prisma.TransactionClient;
type Claim = { id: string; claimId: string };
const release = { claimId: null, leaseExpiresAt: null };

/** 只由建档成功事务调用；数据库唯一键是最终幂等保证。不补历史任务。 */
export async function enqueueAccountNotification(
  tx: Tx,
  input: {
    provisionId: string;
    applicationId: string;
    userId: string;
    recipientEmail: string | null;
    qqNormalized: string;
    credentialCreated: boolean;
    credentialVersion: number;
  },
) {
  if (!input.recipientEmail) return;
  const at = new Date();
  const row = await tx.accountNotification.create({
    data: {
      ...input,
      id: randomUUID(),
      recipientEmail: input.recipientEmail,
      kind: ACCOUNT_NOTIFICATION_KIND,
      status: "PENDING",
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    },
  });
  await audit(tx, row, "queued");
}
/** 通知任务 → 详情视图。报名邮箱更正复用它返回同一口径的状态。 */
export function toAccountNotificationView(row: AccountNotification): AccountNotificationView {
  return {
    status: row.status as AccountNotificationView["status"],
    attemptCount: row.attemptCount,
    roundAttemptCount: row.roundAttemptCount,
    nextAttemptAt: row.status === "PENDING" ? row.nextAttemptAt.toISOString() : null,
    lastErrorCode: row.lastErrorCode,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    messageId: row.messageId,
    canRetry: row.status === "FAILED",
  };
}
async function audit(tx: Tx, row: AccountNotification, action: string, actor?: AuthorizedActor) {
  await appendAuditLog(tx, {
    actor: actor ?? { requestId: `notification:${row.id}` },
    actorType: actor?.actorType ?? "SYSTEM",
    actorUserId: actor?.userId,
    action: `account.notification.${action}`,
    targetType: "AccountNotification",
    targetId: row.id,
    result: ["failed", "uncertain"].includes(action) ? "FAILURE" : "SUCCESS",
    after: {
      status: row.status,
      attemptCount: row.attemptCount,
      roundAttemptCount: row.roundAttemptCount,
      lastErrorCode: row.lastErrorCode,
      applicationId: row.applicationId,
      userId: row.userId,
    },
  });
}
async function locked(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM account_notifications WHERE id = ${id} FOR UPDATE`;
  return tx.accountNotification.findUniqueOrThrow({ where: { id } });
}
export class AccountNotificationService implements AccountNotificationServiceContract {
  constructor(
    private readonly deps: {
      sender?: EmailSender;
      now?: () => Date;
      mailConfig?: () => MailConfig;
    } = {},
  ) {}
  private now = () => this.deps.now?.() ?? new Date();
  async get(applicationId: string, actor: AuthorizedActor) {
    requirePermission(actor, "join:read");
    const row = await getDb().accountNotification.findFirst({
      where: { applicationId, kind: ACCOUNT_NOTIFICATION_KIND, application: { deletedAt: null } },
    });
    return row ? toAccountNotificationView(row) : null;
  }
  async retry(applicationId: string, actor: AuthorizedActor) {
    requirePermission(actor, "join:review");
    return inSerializableTransaction(async (tx) => {
      const candidate = await tx.accountNotification.findFirst({
        where: { applicationId, kind: ACCOUNT_NOTIFICATION_KIND, application: { deletedAt: null } },
      });
      if (!candidate) throw new AppError("RESOURCE_NOT_FOUND", "没有可重试的通知任务");
      const row = await locked(tx, candidate.id);
      if (row.status === "PENDING" || row.status === "SENDING")
        return toAccountNotificationView(row);
      if (row.status !== "FAILED")
        throw new AppError("STATE_TRANSITION_INVALID", "该通知不能重新发送");
      const updated = await tx.accountNotification.update({
        where: { id: row.id },
        data: { status: "PENDING", roundAttemptCount: 0, nextAttemptAt: this.now(), ...release },
      });
      // 上次受控失败原因和累计次数保留，审计保留操作者 / 时间；后续实际尝试再替换原因。
      await audit(tx, updated, "retry_requested", actor);
      return toAccountNotificationView(updated);
    });
  }
  private async recoverExpired(limit: number) {
    const candidates = await getDb().accountNotification.findMany({
      where: { status: "SENDING", leaseExpiresAt: { lte: this.now() } },
      orderBy: { leaseExpiresAt: "asc" },
      take: limit,
      select: { id: true },
    });
    let count = 0;
    for (const candidate of candidates)
      count += await inSerializableTransaction(async (tx) => {
        const row = await locked(tx, candidate.id),
          at = this.now();
        if (row.status !== "SENDING" || !row.leaseExpiresAt || row.leaseExpiresAt > at) return 0;
        const updated = await tx.accountNotification.update({
          where: { id: row.id },
          data: { status: "UNCERTAIN", lastErrorCode: "LEASE_EXPIRED", ...release },
        });
        await audit(tx, updated, "uncertain");
        return 1;
      });
    return count;
  }
  private async claim(id: string): Promise<Claim | null> {
    return inSerializableTransaction(async (tx) => {
      const row = await locked(tx, id),
        at = this.now();
      if (row.status !== "PENDING" || row.nextAttemptAt > at) return null;
      const claimId = randomUUID();
      await tx.accountNotification.update({
        where: { id },
        data: {
          status: "SENDING",
          claimId,
          leaseExpiresAt: new Date(at.getTime() + ACCOUNT_NOTIFICATION_LEASE_MS),
        },
      });
      return { id, claimId };
    });
  }
  private async prepare(claim: Claim, dailyBudget: number): Promise<EmailMessage | null> {
    return inSerializableTransaction(async (tx) => {
      const row = await locked(tx, claim.id);
      if (row.status !== "SENDING" || row.claimId !== claim.claimId) return null;
      // 本轮锁链：任务 -> 凭据 -> 资格 / QQ -> 原全站预算；SMTP 不持任何锁。
      await tx.$queryRaw`SELECT user_id FROM password_credentials WHERE user_id = ${row.userId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: row.userId },
        include: {
          memberProfile: true,
          passwordCredential: true,
          roles: { where: { revokedAt: null }, include: { role: true } },
        },
      });
      const identity = await tx.userIdentity.findUnique({
        where: {
          type_identifierNormalized: { type: "QQ", identifierNormalized: row.qqNormalized },
        },
      });
      const application = await tx.joinApplication.findUnique({ where: { id: row.applicationId } });
      const provision = await tx.accountProvision.findUnique({ where: { id: row.provisionId } });
      let errorCode: string | null = null,
        to = "";
      if (
        !user ||
        !user.passwordCredential ||
        resolveAccountBlockedReason(user, null) !== null ||
        !application ||
        application.deletedAt ||
        provision?.status !== "SUCCEEDED" ||
        provision.userId !== row.userId
      )
        errorCode = "ACCOUNT_UNAVAILABLE";
      else if (!identity || identity.deletedAt || identity.userId !== row.userId)
        errorCode = "QQ_IDENTITY_CHANGED";
      try {
        to = normalizeEmail(row.recipientEmail);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        errorCode = "INVALID_RECIPIENT";
      }
      let initialPassword: string | undefined;
      if (
        !errorCode &&
        row.credentialCreated &&
        user!.passwordCredential!.credentialVersion === row.credentialVersion &&
        user!.passwordCredential!.mustChangePassword
      ) {
        const candidate = initialPasswordFromQq(row.qqNormalized);
        if (await verifyPassword(candidate, user!.passwordCredential!.passwordHash))
          initialPassword = candidate;
      }
      if (!row.leaseExpiresAt || row.leaseExpiresAt <= this.now()) {
        const updated = await tx.accountNotification.update({
          where: { id: row.id },
          data: { status: "UNCERTAIN", lastErrorCode: "LEASE_EXPIRED", ...release },
        });
        await audit(tx, updated, "uncertain");
        return null;
      }
      if (errorCode) {
        const updated = await tx.accountNotification.update({
          where: { id: row.id },
          data: { status: "FAILED", lastErrorCode: errorCode, ...release },
        });
        await audit(tx, updated, "failed");
        return null;
      }
      const quota = await preoccupyGlobalEmailBudget(tx, { dailyBudget, now: this.now });
      // 所有等待完成后再判领取期限，不沿用等锁前的时刻。
      if (row.leaseExpiresAt <= this.now()) {
        const updated = await tx.accountNotification.update({
          where: { id: row.id },
          data: { status: "UNCERTAIN", lastErrorCode: "LEASE_EXPIRED", ...release },
        });
        await audit(tx, updated, "uncertain");
        return null;
      }
      if (quota.nextAt) {
        await tx.accountNotification.update({
          where: { id: row.id },
          data: {
            status: "PENDING",
            nextAttemptAt: quota.nextAt,
            lastErrorCode: "BUDGET_DEFERRED",
            ...release,
          },
        });
        return null;
      }
      return buildAccountNotificationMessage({ to, qq: row.qqNormalized, initialPassword });
    });
  }
  /** Sender 已调用后才计数；仅领取 / 资格失败 / 预算等待不计 SMTP 尝试。 */
  private async countAttempt(claim: Claim) {
    await inSerializableTransaction(async (tx) => {
      const row = await locked(tx, claim.id);
      if (row.status !== "SENDING" || row.claimId !== claim.claimId) return;
      const updated = await tx.accountNotification.update({
        where: { id: row.id },
        data: {
          attemptCount: { increment: 1 },
          roundAttemptCount: { increment: 1 },
          lastAttemptAt: this.now(),
        },
      });
      await audit(tx, updated, "attempted");
    });
  }
  private async finish(claim: Claim, outcome: EmailDeliveryOutcome) {
    await inSerializableTransaction(async (tx) => {
      const row = await locked(tx, claim.id),
        at = this.now();
      if (row.status !== "SENDING" || row.claimId !== claim.claimId) return;
      let status: string,
        lastErrorCode: string | null = null,
        nextAttemptAt = row.nextAttemptAt;
      if (!row.leaseExpiresAt || row.leaseExpiresAt <= at) {
        status = "UNCERTAIN";
        lastErrorCode = "LEASE_EXPIRED";
      } else if (outcome.status === "ACCEPTED") status = "ACCEPTED";
      else if (outcome.status === "UNCERTAIN") {
        status = "UNCERTAIN";
        lastErrorCode = "SMTP_UNCERTAIN";
      } else if (outcome.retryable && row.roundAttemptCount < ACCOUNT_NOTIFICATION_MAX_ATTEMPTS) {
        status = "PENDING";
        lastErrorCode = "SMTP_TEMPORARY_REJECTED";
        nextAttemptAt = new Date(
          at.getTime() + ACCOUNT_NOTIFICATION_RETRY_MS[row.roundAttemptCount - 1],
        );
      } else {
        status = "FAILED";
        lastErrorCode = outcome.retryable ? "SMTP_TEMPORARY_EXHAUSTED" : "SMTP_REJECTED";
      }
      const updated = await tx.accountNotification.update({
        where: { id: row.id },
        data: {
          status,
          lastErrorCode,
          nextAttemptAt,
          ...release,
          ...(status === "ACCEPTED" && outcome.status === "ACCEPTED"
            ? { acceptedAt: at, messageId: outcome.messageId ?? null }
            : {}),
        },
      });
      await audit(tx, updated, status === "PENDING" ? "retry_scheduled" : status.toLowerCase());
    });
  }
  async runBatch(input: { limit?: number } = {}): Promise<AccountNotificationBatchResult> {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new AppError("VALIDATION_FAILED", "批次大小应为 1–50");
    const result: AccountNotificationBatchResult = {
      claimed: 0,
      accepted: 0,
      failed: 0,
      uncertain: await this.recoverExpired(limit),
      pending: 0,
      disabled: false,
    };
    const mail = (this.deps.mailConfig ?? getMailConfig)();
    if (!mail.enabled) return { ...result, disabled: true };
    const sender = this.deps.sender ?? createSmtpEmailSender(mail);
    for (let i = 0; i < limit; i++) {
      const candidate = await getDb().accountNotification.findFirst({
        where: { status: "PENDING", nextAttemptAt: { lte: this.now() } },
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (!candidate) break;
      const claim = await this.claim(candidate.id);
      if (!claim) continue;
      result.claimed++;
      const message = await this.prepare(claim, mail.dailyBudget);
      if (message) {
        // 所有数据库重试结束后调用一次；同步抛出或不可分类异常也按未知处理。
        let delivery: Promise<EmailDeliveryOutcome>;
        try {
          delivery = Promise.resolve(sender.send(message)).catch(() => ({
            status: "UNCERTAIN" as const,
          }));
        } catch {
          delivery = Promise.resolve({ status: "UNCERTAIN" });
        }
        await this.countAttempt(claim);
        await this.finish(claim, await delivery);
      }
      const current = await getDb().accountNotification.findUniqueOrThrow({
        where: { id: claim.id },
      });
      if (current.status === "ACCEPTED") result.accepted++;
      else if (current.status === "FAILED") result.failed++;
      else if (current.status === "UNCERTAIN") result.uncertain++;
      else result.pending++;
    }
    return result;
  }
}
export const accountNotificationService = new AccountNotificationService();
