import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { resolveAccountBlockedReason } from "@/features/auth/account-recovery";
import {
  consumeEmailChallenge,
  emailChallengeService,
  type EmailChallengeService,
} from "./email-challenge-service";
import {
  lockEmailVerificationFailureBucket,
  readEmailVerificationBlock,
  recordEmailVerificationFailure,
} from "./email-rate-limit";
import { AppError } from "@/lib/api/errors";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { maskEmail } from "@/lib/audit/redaction";
import { permissionsForRoles, requirePermission } from "@/lib/auth/permissions";
import { loginDestination } from "@/lib/auth/login-destination";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { getMailConfig } from "@/lib/env";
import { normalizeEmail } from "@/lib/security/normalization";
import { digestSessionToken, generateSessionToken, verifyPassword } from "@/lib/security/secrets";
import type {
  AccountEmailServiceContract,
  AdminAccountEmailServiceContract,
  AccountEmailChallengeInput,
  AccountEmailConfirmInput,
  AuthorizedActor,
  EmailCodeInput,
  EmailChallengePurpose,
  PublicRequestContext,
  RoleCode,
} from "@/types/contracts";

const userInclude = {
  passwordCredential: true,
  memberProfile: true,
  roles: { where: { revokedAt: null }, include: { role: true } },
} as const;
type Tx = Prisma.TransactionClient;
const invalid = () => new AppError("EMAIL_CHALLENGE_INVALID", "邮箱状态或验证已失效，请刷新后重试");
const passwordBucket = (userId: string) => ({ userId, purpose: "ACCOUNT_EMAIL_PASSWORD" });

export function emailReturnDestination(value: string | undefined, roles: RoleCode[]): string {
  const fallback = loginDestination({ roles, mustChangePassword: false });
  if (!value || /[\\\u0000-\u0020\u007f%?#]/.test(value)) return fallback;
  // 仅允许当前权限对应的业务页；拒绝编码、查询串和非规范路径，避免重定向歧义。
  if (!/^\/(member|admin)(\/[-a-zA-Z0-9]+)*\/?$/.test(value)) return fallback;
  if (value.startsWith("/admin") && !roles.includes("ADMIN")) return fallback;
  if (value.startsWith("/member") && !roles.includes("MEMBER")) return fallback;
  return value;
}

async function eligible(tx: Tx, userId: string, allowForced = false) {
  const user = await tx.user.findUnique({ where: { id: userId }, include: userInclude });
  if (!user || resolveAccountBlockedReason(user, null))
    throw new AppError("ACCOUNT_DISABLED", "账号或成员身份当前不可用");
  if (!user.passwordCredential) throw new AppError("ACCOUNT_DISABLED", "账号凭据不可用");
  if (!allowForced && user.passwordCredential.mustChangePassword)
    throw new AppError("PASSWORD_CHANGE_REQUIRED", "请先修改初始密码");
  return user;
}
async function currentEmail(tx: Tx, userId: string) {
  const rows = await tx.userIdentity.findMany({
    where: { userId, type: "EMAIL", deletedAt: null },
  });
  if (rows.length > 1) throw invalid();
  // 历史 activeEmailKey=NULL 的有效已验证身份也算已绑定；不猜选、不全库回填。
  if (rows[0] && !rows[0].verifiedAt) throw invalid();
  return rows[0] ?? null;
}
async function available(tx: Tx, userId: string, email: string) {
  const row = await tx.userIdentity.findUnique({
    where: { type_identifierNormalized: { type: "EMAIL", identifierNormalized: email } },
  });
  if (row && (row.userId !== userId || !row.deletedAt))
    throw new AppError("EMAIL_ALREADY_BOUND", "该邮箱已有归属或已是当前邮箱");
  return row;
}
async function assistance(
  tx: Tx,
  userId: string,
  oldId: string | null,
  version: number,
  now: Date,
  id?: string,
) {
  const row = await tx.emailAssistance.findFirst({
    where: {
      userId,
      ...(id ? { id } : {}),
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
      oldEmailIdentityId: oldId,
      credentialVersion: version,
    },
    orderBy: { createdAt: "desc" },
  });
  if (id && !row) throw invalid();
  return row;
}
/** 内部状态查询：不认证、不读取 SMTP，不接入本轮门禁；允许调用方复用事务。 */
export async function getEmailVerificationState(
  userId: string,
  tx: Tx = getDb(),
  now: () => Date = () => new Date(),
) {
  const identity = await currentEmail(tx, userId);
  const rows = await tx.emailExemption.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  const at = now();
  const row = rows.find((r) => r.expiresAt > at);
  return {
    verified: !!identity,
    exemption: row
      ? { id: row.id, reason: row.reason, expiresAt: row.expiresAt.toISOString() }
      : null,
  };
}

export class AccountEmailService
  implements AccountEmailServiceContract, AdminAccountEmailServiceContract
{
  constructor(
    private readonly deps: { challenges?: EmailChallengeService; now?: () => Date } = {},
  ) {}
  private now = () => this.deps.now?.() ?? new Date();
  private get challenges() {
    return this.deps.challenges ?? emailChallengeService;
  }

  /** 会话 -> 凭据锁 -> 当前身份 -> 待办；沿用 Serializable 有界重试。
   * 改密/重置也触及 Session 与凭据；冲突由既有 P2034 重试重新读取及重新取时。
   * 验码失败桶独立提交且不跨入此锁链；SMTP 永远不在事务中。 */
  private async self(tx: Tx, token: string, expectedVersion?: number) {
    const session = await tx.authSession.findUnique({
      where: { tokenDigest: digestSessionToken(token) },
    });
    if (!session) throw new AppError("AUTH_SESSION_INVALID", "请重新登录");
    await tx.$queryRaw`SELECT user_id FROM password_credentials WHERE user_id = ${session.userId} FOR UPDATE`;
    const user = await eligible(tx, session.userId);
    const now = this.now();
    if (
      session.revokedAt ||
      session.expiresAt <= now ||
      (expectedVersion !== undefined &&
        user.passwordCredential!.credentialVersion !== expectedVersion)
    )
      throw new AppError("AUTH_SESSION_INVALID", "登录或密码状态已变化，请重新登录");
    return { session, user, old: await currentEmail(tx, user.id) };
  }
  private async password(token: string, password: string, context: PublicRequestContext) {
    const result = await inSerializableTransaction(async (tx) => {
      const snap = await this.self(tx, token);
      const bucket = passwordBucket(snap.user.id);
      await lockEmailVerificationFailureBucket(tx, bucket);
      const at = this.now();
      if (await readEmailVerificationBlock(tx, bucket, at)) return { blocked: true } as const;
      if (!(await verifyPassword(password, snap.user.passwordCredential!.passwordHash))) {
        await recordEmailVerificationFailure(tx, bucket, this.now());
        await appendAuditLog(tx, {
          actor: context,
          actorType: "USER",
          actorUserId: snap.user.id,
          action: "email.password.rejected",
          targetType: "User",
          targetId: snap.user.id,
          result: "FAILURE",
        });
        return { failed: true } as const;
      }
      return { version: snap.user.passwordCredential!.credentialVersion } as const;
    });
    if ("blocked" in result)
      throw new AppError("EMAIL_RATE_LIMITED", "当前密码验证已阻断，请 15 分钟后重试");
    if ("failed" in result) throw new AppError("PASSWORD_CURRENT_INVALID", "当前密码错误");
    return result.version;
  }
  private async verify(
    userId: string,
    email: string,
    purpose: EmailChallengePurpose,
    proof: EmailCodeInput,
    ctx: PublicRequestContext,
  ) {
    return this.challenges.verifyEmailChallenge(
      {
        ...proof,
        expectedUserId: userId,
        expectedPurpose: purpose,
        expectedEmailNormalized: email,
      },
      ctx,
    );
  }
  async getState(token: string) {
    return inSerializableTransaction(async (tx) => {
      const { user, old } = await this.self(tx, token);
      const a = await assistance(
        tx,
        user.id,
        old?.id ?? null,
        user.passwordCredential!.credentialVersion,
        this.now(),
      );
      // 关闭/配置故障仅影响发码，不能阻塞状态和管理操作。
      let mailEnabled = false;
      try {
        mailEnabled = getMailConfig().enabled;
      } catch {
        /* 受控不可用 */
      }
      return {
        ...(await getEmailVerificationState(user.id, tx, this.now)),
        email: old?.identifierNormalized ?? null,
        assistance: a
          ? { id: a.id, targetEmail: a.targetEmailNormalized, expiresAt: a.expiresAt.toISOString() }
          : null,
        mailEnabled,
      };
    });
  }
  async requestChallenge(
    token: string,
    input: AccountEmailChallengeInput,
    ctx: PublicRequestContext,
  ) {
    const version =
      input.mode === "BIND" ? undefined : await this.password(token, input.currentPassword, ctx);
    const snap = await inSerializableTransaction(async (tx) => {
      const s = await this.self(tx, token, version);
      if (input.mode === "BIND" && s.old) throw invalid();
      if ((input.mode === "OLD" || input.mode === "NEW") && !s.old) throw invalid();
      const a =
        input.mode === "ASSISTED"
          ? await assistance(
              tx,
              s.user.id,
              s.old?.id ?? null,
              s.user.passwordCredential!.credentialVersion,
              this.now(),
              input.assistanceId,
            )
          : null;
      return {
        ...s,
        target:
          a?.targetEmailNormalized ??
          ("targetEmail" in input ? normalizeEmail(input.targetEmail) : undefined),
      };
    });
    if (input.mode === "NEW")
      await this.verify(
        snap.user.id,
        snap.old!.identifierNormalized,
        "EMAIL_CHANGE_OLD",
        input.old,
        ctx,
      );
    const purpose =
      input.mode === "OLD" ? "EMAIL_CHANGE_OLD" : snap.old ? "EMAIL_CHANGE_NEW" : "EMAIL_BIND";
    return this.challenges.requestEmailChallenge(
      {
        userId: snap.user.id,
        purpose,
        targetEmail: input.mode === "OLD" ? undefined : snap.target,
      },
      ctx,
    );
  }
  async confirm(token: string, input: AccountEmailConfirmInput, ctx: PublicRequestContext) {
    const version =
      input.mode === "BIND" ? undefined : await this.password(token, input.currentPassword, ctx);
    const snap = await inSerializableTransaction(async (tx) => {
      const s = await this.self(tx, token, version);
      if ((input.mode === "BIND" && s.old) || (input.mode === "CHANGE" && !s.old)) throw invalid();
      const a =
        input.mode === "ASSISTED"
          ? await assistance(
              tx,
              s.user.id,
              s.old?.id ?? null,
              s.user.passwordCredential!.credentialVersion,
              this.now(),
              input.assistanceId,
            )
          : null;
      return {
        ...s,
        a,
        target:
          a?.targetEmailNormalized ??
          normalizeEmail("targetEmail" in input ? input.targetEmail : undefined),
      };
    });
    if (input.mode === "CHANGE")
      await this.verify(
        snap.user.id,
        snap.old!.identifierNormalized,
        "EMAIL_CHANGE_OLD",
        input.old,
        ctx,
      );
    const purpose = snap.old ? "EMAIL_CHANGE_NEW" : "EMAIL_BIND";
    await this.verify(snap.user.id, snap.target, purpose, input.proof, ctx);
    const newToken = generateSessionToken();
    try {
      return await inSerializableTransaction(async (tx) => {
        const fresh = await this.self(tx, token, snap.user.passwordCredential!.credentialVersion);
        if ((fresh.old?.id ?? null) !== (snap.old?.id ?? null)) throw invalid();
        if (snap.a)
          await assistance(
            tx,
            fresh.user.id,
            fresh.old?.id ?? null,
            fresh.user.passwordCredential!.credentialVersion,
            this.now(),
            snap.a.id,
          );
        const previous = await available(tx, fresh.user.id, snap.target);
        const proofIds = [
          input.proof.challengeId,
          ...(input.mode === "CHANGE" ? [input.old.challengeId] : []),
        ].sort();
        const proofExpiries: Date[] = [];
        for (const id of proofIds) {
          await tx.$queryRaw`SELECT id FROM email_challenges WHERE id = ${id} FOR UPDATE`;
          const challenge = await tx.emailChallenge.findUnique({ where: { id } });
          if (
            !challenge ||
            challenge.credentialVersion !== fresh.user.passwordCredential!.credentialVersion ||
            challenge.emailIdentityId !== (fresh.old?.id ?? null)
          )
            throw invalid();
          proofExpiries.push(challenge.expiresAt);
        }

        if (input.mode === "CHANGE")
          await consumeEmailChallenge(tx, {
            ...input.old,
            expectedUserId: fresh.user.id,
            purpose: "EMAIL_CHANGE_OLD",
            emailNormalized: fresh.old!.identifierNormalized,
            now: this.now,
          });
        await consumeEmailChallenge(tx, {
          ...input.proof,
          expectedUserId: fresh.user.id,
          purpose,
          emailNormalized: snap.target,
          now: this.now,
        });
        // 所有阻塞读取/证明消费结束后再判期限，重试重新取时。
        const at = this.now();
        if (fresh.session.expiresAt <= at || proofExpiries.some((expires) => expires <= at))
          throw invalid();
        if (snap.a) {
          const consumed = await tx.emailAssistance.updateMany({
            where: {
              id: snap.a.id,
              userId: fresh.user.id,
              consumedAt: null,
              revokedAt: null,
              expiresAt: { gt: at },
            },
            data: { consumedAt: at },
          });
          if (consumed.count !== 1) throw invalid();
        }
        if (fresh.old)
          await tx.userIdentity.update({
            where: { id: fresh.old.id },
            data: { deletedAt: at, activeEmailKey: null },
          });
        const data = { verifiedAt: at, deletedAt: null, activeEmailKey: `email:${fresh.user.id}` };
        if (previous) await tx.userIdentity.update({ where: { id: previous.id }, data });
        else
          await tx.userIdentity.create({
            data: {
              ...data,
              id: randomUUID(),
              userId: fresh.user.id,
              type: "EMAIL",
              identifierNormalized: snap.target,
              createdAt: at,
              updatedAt: at,
            },
          });
        await tx.emailChallenge.updateMany({
          where: { userId: fresh.user.id, status: { in: ["ACTIVE", "PENDING"] } },
          data: { status: "INVALIDATED", finishedAt: at },
        });
        await tx.passwordResetAuthorization.updateMany({
          where: { userId: fresh.user.id, status: "ISSUED" },
          data: { status: "INVALIDATED", finishedAt: at },
        });
        await tx.emailAssistance.updateMany({
          where: { userId: fresh.user.id, consumedAt: null, revokedAt: null },
          data: { revokedAt: at },
        });
        const revokedExemptions = await tx.emailExemption.updateMany({
          where: { userId: fresh.user.id, revokedAt: null },
          data: { revokedAt: at, revokedByUserId: fresh.user.id },
        });
        await tx.authSession.updateMany({
          where: { userId: fresh.user.id, revokedAt: null },
          data: { revokedAt: at },
        });
        await tx.authSession.create({
          data: {
            id: randomUUID(),
            userId: fresh.user.id,
            tokenDigest: digestSessionToken(newToken),
            createdAt: at,
            lastSeenAt: at,
            expiresAt: fresh.session.expiresAt,
            rememberMe: fresh.session.rememberMe,
          },
        });
        const actor: AuthorizedActor = {
          ...ctx,
          actorType: "USER",
          userId: fresh.user.id,
          userStatus: "ACTIVE",
          permissions: [],
        };
        await this.audit(tx, actor, fresh.user.id, fresh.old ? "email.changed" : "email.bound", {
          email: maskEmail(snap.target),
          assistanceId: snap.a?.id,
          revokedExemptions: revokedExemptions.count,
        });
        await this.audit(tx, actor, fresh.user.id, "auth.session.revoked", {
          reason: "EMAIL_CHANGED",
        });
        return {
          token: newToken,
          expiresAt: fresh.session.expiresAt.toISOString(),
          destination: emailReturnDestination(
            input.returnTo,
            fresh.user.roles
              .map((r) => r.role.code)
              .filter((r): r is RoleCode => r === "ADMIN" || r === "MEMBER"),
          ),
        };
      });
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "P2002")
        throw new AppError("EMAIL_ALREADY_BOUND", "该邮箱已被其他账号使用");
      throw e;
    }
  }
  private async admin(tx: Tx, actor: AuthorizedActor, userId: string, selfForbidden = false) {
    requirePermission(actor, "member:manage");
    if (!actor.userId) throw new AppError("UNAUTHENTICATED", "请先登录");
    const operator = await eligible(tx, actor.userId);
    requirePermission(
      {
        ...actor,
        permissions: permissionsForRoles(
          operator.roles
            .map((r) => r.role.code)
            .filter((r): r is RoleCode => r === "ADMIN" || r === "MEMBER"),
        ),
      },
      "member:manage",
    );
    if (selfForbidden && actor.userId === userId)
      throw new AppError("FORBIDDEN", "不能为自己创建协助或授予豁免，请联系另一位管理员");
    // 同一目标所有管理写操作与自助切换共用凭据行串行化。
    await tx.$queryRaw`SELECT user_id FROM password_credentials WHERE user_id = ${userId} FOR UPDATE`;
    return eligible(tx, userId, true);
  }
  async getAdminState(userId: string, actor: AuthorizedActor) {
    return inSerializableTransaction(async (tx) => {
      const user = await this.admin(tx, actor, userId);
      const old = await currentEmail(tx, userId);
      const a = await assistance(
        tx,
        userId,
        old?.id ?? null,
        user.passwordCredential!.credentialVersion,
        this.now(),
      );
      return {
        ...(await getEmailVerificationState(userId, tx, this.now)),
        maskedEmail: old ? maskEmail(old.identifierNormalized) : null,
        assistance: a
          ? {
              id: a.id,
              targetEmail: maskEmail(a.targetEmailNormalized),
              expiresAt: a.expiresAt.toISOString(),
            }
          : null,
        canAssist: actor.userId !== userId && !user.passwordCredential!.mustChangePassword,
        canExempt: actor.userId !== userId,
        mustChangePassword: user.passwordCredential!.mustChangePassword,
      };
    });
  }
  async reveal(userId: string, actor: AuthorizedActor) {
    return inSerializableTransaction(async (tx) => {
      const user = await this.admin(tx, actor, userId);
      const old = await currentEmail(tx, userId);
      const a = await assistance(
        tx,
        userId,
        old?.id ?? null,
        user.passwordCredential!.credentialVersion,
        this.now(),
      );
      await this.audit(tx, actor, userId, "email.detail.revealed");
      return {
        email: old?.identifierNormalized ?? null,
        targetEmail: a?.targetEmailNormalized ?? null,
      };
    });
  }
  async createAssistance(
    userId: string,
    input: { targetEmail: string; reason: string },
    actor: AuthorizedActor,
  ) {
    const target = normalizeEmail(input.targetEmail);
    const reason = validReason(input.reason);
    await inSerializableTransaction(async (tx) => {
      const user = await this.admin(tx, actor, userId, true);
      if (user.passwordCredential!.mustChangePassword)
        throw new AppError("PASSWORD_CHANGE_REQUIRED", "目标账号需先完成改密，再创建协助");
      const old = await currentEmail(tx, userId);
      await available(tx, userId, target);
      const at = this.now();
      await tx.emailAssistance.updateMany({
        where: { userId, revokedAt: null, consumedAt: null },
        data: { revokedAt: at },
      });
      await tx.emailChallenge.updateMany({
        where: {
          userId,
          purpose: { in: ["EMAIL_BIND", "EMAIL_CHANGE_NEW"] },
          status: { in: ["PENDING", "ACTIVE"] },
        },
        data: { status: "INVALIDATED", finishedAt: at },
      });
      await tx.emailAssistance.create({
        data: {
          id: randomUUID(),
          userId,
          targetEmailNormalized: target,
          oldEmailIdentityId: old?.id ?? null,
          credentialVersion: user.passwordCredential!.credentialVersion,
          createdByUserId: actor.userId!,
          reason,
          createdAt: at,
          expiresAt: new Date(at.getTime() + 30 * 60_000),
        },
      });
      await this.audit(tx, actor, userId, "email.assistance.created", {
        email: maskEmail(target),
        reason,
      });
    });
  }
  async revokeAssistance(userId: string, id: string, actor: AuthorizedActor) {
    await inSerializableTransaction(async (tx) => {
      await this.admin(tx, actor, userId);
      const row = await tx.emailAssistance.findUnique({ where: { id } });
      if (!row || row.userId !== userId) throw new AppError("RESOURCE_NOT_FOUND", "协助记录不存在");
      if (row.revokedAt || row.consumedAt) return;
      const at = this.now();
      await tx.emailAssistance.update({ where: { id }, data: { revokedAt: at } });
      await tx.emailChallenge.updateMany({
        where: {
          userId,
          targetEmailNormalized: row.targetEmailNormalized,
          purpose: { in: ["EMAIL_BIND", "EMAIL_CHANGE_NEW"] },
          status: { in: ["PENDING", "ACTIVE"] },
        },
        data: { status: "INVALIDATED", finishedAt: at },
      });
      await this.audit(tx, actor, userId, "email.assistance.revoked", { assistanceId: id });
    });
  }
  async grantExemption(
    userId: string,
    input: { reason: string; durationHours?: number },
    actor: AuthorizedActor,
  ) {
    const reason = validReason(input.reason);
    const hours = input.durationHours ?? 24;
    if (!Number.isInteger(hours) || hours < 1 || hours > 168)
      throw new AppError("VALIDATION_FAILED", "豁免时长须为 1–168 小时整数");
    await inSerializableTransaction(async (tx) => {
      await this.admin(tx, actor, userId, true);
      const at = this.now();
      await tx.emailExemption.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: at, revokedByUserId: actor.userId },
      });
      await tx.emailExemption.create({
        data: {
          id: randomUUID(),
          userId,
          reason,
          createdByUserId: actor.userId!,
          createdAt: at,
          expiresAt: new Date(at.getTime() + hours * 3600_000),
        },
      });
      await this.audit(tx, actor, userId, "email.exemption.granted", {
        reason,
        durationHours: hours,
      });
    });
  }
  async revokeExemption(userId: string, id: string, actor: AuthorizedActor) {
    await inSerializableTransaction(async (tx) => {
      await this.admin(tx, actor, userId);
      const row = await tx.emailExemption.findUnique({ where: { id } });
      if (!row || row.userId !== userId) throw new AppError("RESOURCE_NOT_FOUND", "豁免记录不存在");
      if (row.revokedAt) return;
      await tx.emailExemption.update({
        where: { id },
        data: { revokedAt: this.now(), revokedByUserId: actor.userId },
      });
      await this.audit(tx, actor, userId, "email.exemption.revoked", { exemptionId: id });
    });
  }
  private audit(tx: Tx, actor: AuthorizedActor, userId: string, action: string, after?: unknown) {
    return appendAuditLog(tx, {
      actor,
      actorType: "USER",
      actorUserId: actor.userId,
      targetType: "User",
      targetId: userId,
      action,
      result: "SUCCESS",
      after,
    });
  }
}
function validReason(value: string) {
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 500)
    throw new AppError("VALIDATION_FAILED", "原因须为 2–500 字符");
  return value.trim();
}
export const accountEmailService = new AccountEmailService();
