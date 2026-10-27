import { inviteOrderBy } from "@/features/admin/table-order";
import { INVITE_FILTERABLE, TABLE_GROUPS } from "@/features/admin/table-fields";
import { checkedFilters, dateFilter, textFilter, numberFilter } from "@/lib/table/filter-value";
import { checkedGroup, groupSummary } from "@/lib/table/group-summary";
import { InviteCodeEffectiveStatus as EffectiveStatuses } from "@/types/contracts";
import { randomUUID } from "node:crypto";

import {
  ensureMemberProfile,
  grantMemberRole,
  resolveOrCreateUser,
  setRegistrationPassword,
} from "@/features/accounts/account-repository";
import type { InviteCode, Prisma } from "@/generated/prisma/client";
import { paginationMeta } from "@/lib/api/pagination";
import { AppError } from "@/lib/api/errors";
import { isPasswordLengthValid, passwordLengthMessage } from "@/lib/security/password-policy";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { maskPhone, maskQq } from "@/lib/audit/redaction";
import { requirePermission } from "@/lib/auth/permissions";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { getDb } from "@/lib/db/client";
import {
  normalizeClassName,
  normalizePhone,
  normalizeQq,
  normalizeStudentId,
  PERSON_NAME_LENGTH_MESSAGE,
  trimPersonName,
} from "@/lib/security/normalization";
import { digestInviteCode, generateInviteCode } from "@/lib/security/secrets";
import { claimHistoryForNewMember } from "@/features/repairs/repair-history-import-service";
import type {
  AuthorizedActor,
  CreateInviteCodeInput,
  CreateInviteCodeResult,
  InviteCodeAdminView,
  InviteCodeEffectiveStatus,
  InviteCodeListInput,
  InviteCodeListResult,
  InviteCodeServiceContract,
  InviteCodeView,
  MemberRegistrationResult,
  PublicRequestContext,
  RedeemInviteCodeInput,
  UpdateInviteCodeInput,
} from "@/types/contracts";

export function getInviteCodeEffectiveStatus(
  code: Pick<InviteCode, "status" | "activeFrom" | "expiresAt" | "maxUses" | "usedCount">,
  now = new Date(),
): InviteCodeEffectiveStatus {
  if (code.status === "REVOKED") return "REVOKED";
  if (code.activeFrom && code.activeFrom > now) return "NOT_STARTED";
  if (code.expiresAt && code.expiresAt <= now) return "EXPIRED";
  if (code.usedCount >= code.maxUses) return "EXHAUSTED";
  return "ACTIVE";
}

export class InviteCodeService implements InviteCodeServiceContract {
  /** 邀请码列表支持分页与筛选。 */
  async list(input: InviteCodeListInput, actor: AuthorizedActor): Promise<InviteCodeListResult> {
    requirePermission(actor, "invite:read");
    const now = new Date();
    const where: Prisma.InviteCodeWhereInput = {
      deletedAt: null,

      OR: buildSearch(input.query),
      AND: [
        effectiveStatusWhere(input.status, now),
        ...checkedFilters(input.filters, INVITE_FILTERABLE).map(
          (rule): Prisma.InviteCodeWhereInput => {
            if (rule.field === "status") {
              if (!(EffectiveStatuses as readonly string[]).includes(rule.value))
                throw new AppError("VALIDATION_FAILED", "邀请码状态无效");
              const where = effectiveStatusWhere(rule.value as InviteCodeEffectiveStatus, now);
              return rule.op === "neq" ? { NOT: where } : where;
            }
            return {
              [rule.field]:
                rule.field === "displayPrefix"
                  ? textFilter(rule)
                  : rule.field === "maxUses" || rule.field === "usedCount"
                    ? numberFilter(rule)
                    : dateFilter(rule),
            };
          },
        ),
      ],
    };
    const group = checkedGroup(input.groupBy, TABLE_GROUPS["invite-codes"]);
    const [records, total] = await Promise.all([
      getDb().inviteCode.findMany({
        where,
        orderBy: inviteOrderBy(input.sort),
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      getDb().inviteCode.count({ where }),
    ]);
    const counts: { value: string; count: number }[] = [];
    // 派生状态必须与列表使用同一 now/谓词；按需串行计数，不同时占用五条连接。
    if (group)
      for (const status of EffectiveStatuses) {
        counts.push({
          value: status,
          count: await getDb().inviteCode.count({
            where: { AND: [where, effectiveStatusWhere(status, now)] },
          }),
        });
      }
    return {
      summary: group ? groupSummary(group, counts) : undefined,
      items: records.map((record) => ({ ...toView(record, now), ...adminFields(record) })),
      pagination: paginationMeta(input, total),
    };
  }
  async create(
    input: CreateInviteCodeInput,
    actor: AuthorizedActor,
  ): Promise<CreateInviteCodeResult> {
    requirePermission(actor, "invite:create");
    validateInvitePolicy(input);
    const plainCode = generateInviteCode();
    const now = new Date();
    const record = await inSerializableTransaction(async (tx) => {
      const created = await tx.inviteCode.create({
        data: {
          id: randomUUID(),
          codeDigest: digestInviteCode(plainCode),
          displayPrefix: plainCode.slice(0, 8),
          status: "ACTIVE",
          activeFrom: parseOptionalDate(input.activeFrom),
          expiresAt: parseOptionalDate(input.expiresAt),
          maxUses: input.maxUses,
          usedCount: 0,
          boundQqNormalized: input.boundQq ? normalizeQq(input.boundQq) : undefined,
          boundPhoneNormalized: input.boundPhone ? normalizePhone(input.boundPhone) : undefined,
          createdByUserId: actor.userId!,
          createdAt: now,
          updatedAt: now,
        },
      });
      await appendAuditLog(tx, {
        actor,
        actorType: actor.actorType,
        actorUserId: actor.userId,
        action: "invite.code.created",
        targetType: "InviteCode",
        targetId: created.id,
        result: "SUCCESS",
        after: {
          displayPrefix: created.displayPrefix,
          activeFrom: created.activeFrom,
          expiresAt: created.expiresAt,
          maxUses: created.maxUses,
          boundQq: created.boundQqNormalized,
          boundPhone: created.boundPhoneNormalized,
        },
      });
      return created;
    });
    return { ...toView(record), plainCode };
  }

  async update(
    inviteCodeId: string,
    input: UpdateInviteCodeInput,
    actor: AuthorizedActor,
  ): Promise<InviteCodeView> {
    requirePermission(actor, "invite:create");
    return inSerializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM invite_codes WHERE id = ${inviteCodeId} FOR UPDATE`;
      const current = await tx.inviteCode.findUnique({ where: { id: inviteCodeId } });
      if (!current || current.deletedAt) throw new AppError("RESOURCE_NOT_FOUND", "邀请码不存在");
      if (
        input.maxUses !== undefined &&
        (!Number.isInteger(input.maxUses) ||
          input.maxUses < Math.max(1, current.usedCount) ||
          input.maxUses > 1_000_000)
      ) {
        throw new AppError("INVITE_CODE_USAGE_LIMIT_INVALID", "最大使用次数不能小于已使用次数");
      }
      const activeFrom =
        input.activeFrom === undefined ? current.activeFrom : parseOptionalDate(input.activeFrom);
      const expiresAt =
        input.expiresAt === undefined ? current.expiresAt : parseOptionalDate(input.expiresAt);
      validateDateRange(activeFrom, expiresAt);
      const updated = await tx.inviteCode.update({
        where: { id: current.id },
        data: { activeFrom, expiresAt, maxUses: input.maxUses },
      });
      await appendAuditLog(tx, {
        actor,
        actorType: actor.actorType,
        actorUserId: actor.userId,
        action: "invite.code.policy_updated",
        targetType: "InviteCode",
        targetId: current.id,
        result: "SUCCESS",
        before: {
          activeFrom: current.activeFrom,
          expiresAt: current.expiresAt,
          maxUses: current.maxUses,
        },
        after: { activeFrom, expiresAt, maxUses: updated.maxUses },
      });
      return toView(updated);
    });
  }

  async revoke(inviteCodeId: string, actor: AuthorizedActor): Promise<InviteCodeView> {
    requirePermission(actor, "invite:revoke");
    return inSerializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM invite_codes WHERE id = ${inviteCodeId} FOR UPDATE`;
      const current = await tx.inviteCode.findUnique({ where: { id: inviteCodeId } });
      if (!current || current.deletedAt) throw new AppError("RESOURCE_NOT_FOUND", "邀请码不存在");
      if (current.status === "REVOKED") return toView(current);
      const updated = await tx.inviteCode.update({
        where: { id: current.id },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      await appendAuditLog(tx, {
        actor,
        actorType: actor.actorType,
        actorUserId: actor.userId,
        action: "invite.code.revoked",
        targetType: "InviteCode",
        targetId: current.id,
        result: "SUCCESS",
        before: { status: current.status },
        after: { status: updated.status },
      });
      return toView(updated);
    });
  }

  async redeem(
    input: RedeemInviteCodeInput,
    context: PublicRequestContext,
  ): Promise<MemberRegistrationResult> {
    if (!isPasswordLengthValid(input.password)) {
      throw new AppError("VALIDATION_FAILED", passwordLengthMessage());
    }
    // 姓名：与公开招募同一份约束 —— 只去首尾空白，trim 后 2–64 字符，
    // 保留内部字符与空格；字段错误沿用统一信封（与学号 / 班级同款）。
    const realName = trimPersonName(input.realName);
    if (realName === null) {
      throw new AppError("VALIDATION_FAILED", PERSON_NAME_LENGTH_MESSAGE, {
        fieldErrors: { realName: [PERSON_NAME_LENGTH_MESSAGE] },
      });
    }
    const qq = normalizeQq(input.qq);
    const phone = normalizePhone(input.phone);
    // 学号 / 班级必填：服务端独立校验（路由已把非字符串拒掉，这里保住
    // 直接调用 Service 的入口），规范化结果（trim、保留前导零）用于建档。
    const studentId = normalizeStudentId(input.studentId);
    const className = normalizeClassName(input.className);
    const digest = digestInviteCode(input.code);
    const redeemed = await inSerializableTransaction(async (tx) => {
      const replay = await tx.inviteCodeRedemption.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: {
          inviteCode: { select: { codeDigest: true } },
          user: {
            select: {
              identities: {
                where: { type: { in: ["QQ", "PHONE"] }, deletedAt: null },
                select: { type: true, identifierNormalized: true },
              },
            },
          },
        },
      });
      if (replay) {
        const sameCode = Buffer.from(replay.inviteCode.codeDigest).equals(Buffer.from(digest));
        const sameQq = replay.user.identities.some(
          (identity) => identity.type === "QQ" && identity.identifierNormalized === qq,
        );
        const samePhone = replay.user.identities.some(
          (identity) => identity.type === "PHONE" && identity.identifierNormalized === phone,
        );
        if (!sameCode || !sameQq || !samePhone) {
          throw new AppError("IDEMPOTENCY_CONFLICT", "幂等键已用于另一项注册请求");
        }
        const provision = await tx.accountProvision.findUniqueOrThrow({
          where: {
            sourceType_sourceId: { sourceType: "INVITE_REDEMPTION", sourceId: replay.id },
          },
        });
        return {
          userId: replay.userId,
          memberProfileId: replay.memberProfileId,
          redemptionId: replay.id,
          provisionId: provision.id,
        };
      }

      await tx.$queryRaw`SELECT id FROM invite_codes WHERE code_digest = ${digest} FOR UPDATE`;
      const code = await tx.inviteCode.findUnique({ where: { codeDigest: digest } });
      if (!code || code.deletedAt) throw new AppError("INVITE_CODE_INVALID", "邀请码无效");
      assertRedeemable(code, qq, phone);

      const userId = await resolveOrCreateUser(tx, { qq, phone }, realName);
      const memberProfileId = await ensureMemberProfile(tx, {
        userId,
        realName,
        studentId,
        className,
      });
      await grantMemberRole(tx, {
        userId,
        sourceType: "INVITE_REDEMPTION",
        sourceId: code.id,
      });
      await setRegistrationPassword(tx, userId, input.password);

      const consumed = await tx.inviteCode.updateMany({
        where: { id: code.id, status: "ACTIVE", usedCount: { lt: code.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (consumed.count !== 1) throw new AppError("INVITE_CODE_EXHAUSTED", "邀请码已用尽");

      const redemptionId = randomUUID();
      await tx.inviteCodeRedemption.create({
        data: {
          id: redemptionId,
          inviteCodeId: code.id,
          userId,
          memberProfileId,
          idempotencyKey: input.idempotencyKey,
          redeemedAt: new Date(),
        },
      });
      const provision = await tx.accountProvision.create({
        data: {
          id: randomUUID(),
          sourceType: "INVITE_REDEMPTION",
          sourceId: redemptionId,
          idempotencyKey: input.idempotencyKey,
          status: "SUCCEEDED",
          userId,
          memberProfileId,
          attemptCount: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: new Date(),
        },
      });
      await appendAuditLog(tx, {
        actor: context,
        actorType: "SYSTEM",
        action: "invite.code.redeemed",
        targetType: "InviteCode",
        targetId: code.id,
        result: "SUCCESS",
        after: { displayPrefix: code.displayPrefix, userId, memberProfileId },
      });
      return { userId, memberProfileId, redemptionId, provisionId: provision.id };
    });
    // 注册成功后按姓名补录历史暂存行：本人可能「先修过机、后注册」。
    // 独立事务且内部吞异常 —— 历史数据的问题不能让注册失败；重复请求触发的重放
    // 也会走到这里，但暂存行已认领过，第二次是空操作。
    await claimHistoryForNewMember({
      memberProfileId: redeemed.memberProfileId,
      realName,
      actor: context,
      actorType: "SYSTEM",
      actorUserId: redeemed.userId,
    });
    return redeemed;
  }
}

function assertRedeemable(code: InviteCode, qq: string, phone: string): void {
  const effective = getInviteCodeEffectiveStatus(code);
  if (effective === "NOT_STARTED") throw new AppError("INVITE_CODE_NOT_ACTIVE", "邀请码尚未生效");
  if (effective === "REVOKED") throw new AppError("INVITE_CODE_REVOKED", "邀请码已撤销");
  if (effective === "EXPIRED") throw new AppError("INVITE_CODE_EXPIRED", "邀请码已失效");
  if (effective === "EXHAUSTED") throw new AppError("INVITE_CODE_EXHAUSTED", "邀请码已用尽");
  if (
    (code.boundQqNormalized && code.boundQqNormalized !== qq) ||
    (code.boundPhoneNormalized && code.boundPhoneNormalized !== phone)
  ) {
    throw new AppError("INVITE_CODE_BINDING_MISMATCH", "邀请码与登记信息不匹配");
  }
}

function validateInvitePolicy(input: CreateInviteCodeInput): void {
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 1_000_000) {
    throw new AppError("INVITE_CODE_USAGE_LIMIT_INVALID", "最大使用次数必须是正整数");
  }
  validateDateRange(parseOptionalDate(input.activeFrom), parseOptionalDate(input.expiresAt));
}

function parseOptionalDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AppError("VALIDATION_FAILED", "时间格式无效");
  return parsed;
}

function validateDateRange(activeFrom: Date | null, expiresAt: Date | null): void {
  if (activeFrom && expiresAt && expiresAt <= activeFrom) {
    throw new AppError("VALIDATION_FAILED", "失效时间必须晚于生效时间");
  }
}

function toView(record: InviteCode, now?: Date): InviteCodeView {
  return {
    id: record.id,
    displayPrefix: record.displayPrefix,
    status: getInviteCodeEffectiveStatus(record, now),
    activeFrom: record.activeFrom?.toISOString() ?? null,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    maxUses: record.maxUses,
    usedCount: record.usedCount,
  };
}

/**
 * 生效状态下推到 SQL。
 *
 * 与 `getInviteCodeEffectiveStatus` 的分支**顺序严格对应**（REVOKED → NOT_STARTED →
 * EXPIRED → EXHAUSTED → ACTIVE），任何一侧改了判定，另一侧必须同步改。
 *
 * ⚠️ 时间条件一律走 `AND: [{ OR: … }, …]`，**不能**把两个 `OR` 平铺进同一个对象：
 * 后写的键会覆盖先写的（后者是同一个 `OR` 键），而且 `list` 还要在最外层挂关键字检索的
 * `OR`，平铺写法会连检索条件一起吃掉。这两个坑都实际踩到过。
 *
 * `used_count` 与 `max_uses` 的比较用 Prisma 的字段引用写成列对列比较：
 * 把 `maxUses` 读出来当常量比较需要 N 次查询，且无法把分页下推到 SQL。
 */
function effectiveStatusWhere(
  status: InviteCodeEffectiveStatus | undefined,
  now: Date,
): Prisma.InviteCodeWhereInput {
  if (!status) return {};
  if (status === "REVOKED") return { status: "REVOKED" };
  const started: Prisma.InviteCodeWhereInput = {
    OR: [{ activeFrom: null }, { activeFrom: { lte: now } }],
  };
  const notExpired: Prisma.InviteCodeWhereInput = {
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
  const fields = getDb().inviteCode.fields;
  switch (status) {
    case "NOT_STARTED":
      return { status: "ACTIVE", activeFrom: { gt: now } };
    case "EXPIRED":
      return { status: "ACTIVE", AND: [started], expiresAt: { lte: now } };
    case "EXHAUSTED":
      return {
        status: "ACTIVE",
        AND: [started, notExpired],
        usedCount: { gte: fields.maxUses },
      };
    default:
      return {
        status: "ACTIVE",
        AND: [started, notExpired],
        usedCount: { lt: fields.maxUses },
      };
  }
}

/**
 * 管理端附加字段。
 *
 * 绑定信息按 PII 规则脱敏：列表页只需要「这条码是否绑定了某个 QQ / 手机号」，
 * 不需要拿到原文；要核对绑定关系时看脱敏值的前后几位就足够。
 */
function adminFields(record: InviteCode): Omit<InviteCodeAdminView, keyof InviteCodeView> {
  return {
    boundQqMasked: record.boundQqNormalized ? maskQq(record.boundQqNormalized) : null,
    boundPhoneMasked: record.boundPhoneNormalized ? maskPhone(record.boundPhoneNormalized) : null,
    createdAt: record.createdAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
  };
}

/** 关键字：明文前缀（`displayPrefix` 是唯一可检索的码片段）与绑定的 QQ / 手机号。 */
function buildSearch(query: string | undefined): Prisma.InviteCodeWhereInput[] | undefined {
  const value = query?.trim();
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  return [
    { displayPrefix: { contains: value.toUpperCase() } },
    ...(digits ? [{ boundQqNormalized: digits }, { boundPhoneNormalized: digits }] : []),
  ];
}

export const inviteCodeService = new InviteCodeService();
