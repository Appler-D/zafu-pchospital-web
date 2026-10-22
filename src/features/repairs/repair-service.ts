import { randomUUID } from "node:crypto";
import { defaultRepairResult } from "@/config/repairs";
import type { Prisma } from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { AppError } from "@/lib/api/errors";
import { requirePermission } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import { assertCanEditRepair, assertCanWithdrawRepair } from "./repair-policy";
import { repairDetailInclude, repairRepository } from "./repair-repository";
import {
  isBlankDraftFields,
  normalizeDraftFields,
  parseRepairDate,
  validateDraftFields,
  validateSubmission,
} from "./repair-validation";
import { toRepairView } from "./repair-view";
import { assertRepairTransition } from "./repair-state";
import type { RepairDraftFields, RepairServiceContract } from "@/types/contracts";

export const repairService: RepairServiceContract = {
  async createDraft(input, actor) {
    requirePermission(actor, "repair:create");
    const member = await repairRepository.activeMemberForUser(actor.userId);
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 128) throw new AppError("VALIDATION_FAILED", "Idempotency-Key 无效");
    const existing = await getDb().repairRecord.findUnique({
      where: { createRequestKey: key },
      include: repairDetailInclude,
    });
    if (existing) {
      if (existing.memberProfileId !== member.id)
        throw new AppError("IDEMPOTENCY_CONFLICT", "幂等键已被使用");
      return toRepairView(existing, { canViewOwnerPhone: true });
    }
    const fields = normalizeDraftFields(input);
    validateDraftFields(fields);
    if (fields.participantIds?.length) await assertParticipantsExist(fields.participantIds);
    // 空白建档请求复用本人最新的空白草稿（PR #73 评审 3）：
    // 新建页「进页面即建档」，成员反复进出不应攒出一串空草稿。
    if (isBlankDraftFields(fields)) {
      const reusable = await repairRepository.latestEmptyDraft(member.id);
      if (reusable) return toRepairView(reusable, { canViewOwnerPhone: true });
    }
    const draft = { ...fields, result: fields.result ?? defaultRepairResult };
    const now = new Date();
    const record = await inSerializableTransaction(async (tx) => {
      const created = await tx.repairRecord.create({
        data: {
          id: randomUUID(),
          memberProfileId: member.id,
          status: "DRAFT",
          createRequestKey: key,
          ...dataFields(draft),
          createdAt: now,
        },
        include: repairDetailInclude,
      });
      await timeline(tx, created.id, actor.userId, "CREATED", { status: "DRAFT" }, now);
      // 参与维修人员（issue #114）：创建人恒为第一行；无额外人员时也落这一行（不变量）。
      await insertRepairParticipants(
        tx,
        created.id,
        composeParticipantIds(member.id, fields.participantIds ?? []),
        now,
      );
      return tx.repairRecord.findUniqueOrThrow({
        where: { id: created.id },
        include: repairDetailInclude,
      });
    });
    return toRepairView(record, { canViewOwnerPhone: true });
  },

  async update(recordId, input, actor) {
    const record = await repairRepository.getById(recordId);
    assertCanEditRepair(actor, record);
    if (record.version !== input.version)
      throw new AppError("REPAIR_VERSION_CONFLICT", "记录已被更新，请刷新后重试");
    const fields = normalizeDraftFields(input);
    validateDraftFields(fields);
    // 参与人员的变更单独 diff（它是关系数据，不在记录行上），以 "participants" 记入时间线。
    const desiredParticipants =
      fields.participantIds === undefined
        ? null
        : composeParticipantIds(record.memberProfileId, fields.participantIds);
    if (desiredParticipants)
      await assertParticipantsExist(
        desiredParticipants,
        record.participants.map((row) => row.memberProfileId),
      );
    const participantsChanged =
      desiredParticipants !== null &&
      desiredParticipants.join(",") !==
        record.participants.map((row) => row.memberProfileId).join(",");
    const changes = changedFields(record, fields);
    if (participantsChanged) changes.push("participants");
    const now = new Date();
    const updated = await inSerializableTransaction(async (tx) => {
      const result = await tx.repairRecord.updateMany({
        where: { id: recordId, version: input.version, deletedAt: null },
        data: { ...dataFields(fields), version: { increment: 1 } },
      });
      if (result.count !== 1)
        throw new AppError("REPAIR_VERSION_CONFLICT", "记录已被更新，请刷新后重试");
      if (desiredParticipants)
        await replaceRepairParticipants(tx, recordId, desiredParticipants, now);
      await timeline(tx, recordId, actor.userId, "UPDATED", { fields: changes }, now);
      return tx.repairRecord.findUniqueOrThrow({
        where: { id: recordId },
        include: repairDetailInclude,
      });
    });
    return toRepairView(updated, { canViewOwnerPhone: true });
  },

  async submit(recordId, input, actor) {
    requirePermission(actor, "repair:submit");
    const record = await repairRepository.getById(recordId);
    const retry = record.timeline.find((event) => {
      if (event.eventType !== "SUBMITTED" && event.eventType !== "RESUBMITTED") return false;
      const summary = event.summary as { idempotencyKey?: unknown } | null;
      return summary?.idempotencyKey === input.idempotencyKey;
    });
    if (record.status === "PENDING" && retry)
      return toRepairView(record, { canViewOwnerPhone: true });
    assertCanEditRepair(actor, record);
    if (record.version !== input.version)
      throw new AppError("REPAIR_VERSION_CONFLICT", "记录已被更新，请刷新后重试");
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 128)
      throw new AppError("VALIDATION_FAILED", "Idempotency-Key 无效");
    const category = record.categoryId
      ? await getDb().repairCategory.findFirst({
          where: { id: record.categoryId, deletedAt: null },
        })
      : null;
    if (record.categoryId && (!category || !category.isActive))
      throw new AppError("REPAIR_CATEGORY_INACTIVE", "所选分类已停用");
    validateSubmission(record);
    const from = record.status;
    assertRepairTransition(from as "DRAFT" | "REJECTED", "PENDING");
    const now = new Date();
    const updated = await inSerializableTransaction(async (tx) => {
      const result = await tx.repairRecord.updateMany({
        where: { id: recordId, version: input.version, status: from, deletedAt: null },
        data: { status: "PENDING", submittedAt: now, reviewedAt: null, version: { increment: 1 } },
      });
      if (result.count !== 1) throw new AppError("REPAIR_STATE_CONFLICT", "记录状态已变化");
      await timeline(
        tx,
        recordId,
        actor.userId,
        from === "REJECTED" ? "RESUBMITTED" : "SUBMITTED",
        { from, to: "PENDING", idempotencyKey: input.idempotencyKey },
        now,
      );
      return tx.repairRecord.findUniqueOrThrow({
        where: { id: recordId },
        include: repairDetailInclude,
      });
    });
    return toRepairView(updated, { canViewOwnerPhone: true });
  },

  /**
   * 撤回审核（issue #165）：创建人把尚未审核的记录退回草稿，修改后可重新提交。
   *
   * 保留 `submittedAt` 作为「提交过」的标记 —— 前端据此把这条草稿标成「已撤回」，
   * 接待流程也据此把它排除在「未提交的接待草稿」之外。审核结论、通知与统计不受影响。
   */
  async withdraw(recordId, input, actor) {
    requirePermission(actor, "repair:submit");
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 128) throw new AppError("VALIDATION_FAILED", "Idempotency-Key 无效");
    const record = await repairRepository.getById(recordId);
    const retry = record.timeline.some((event) => {
      if (event.eventType !== "WITHDRAWN") return false;
      const summary = event.summary as { idempotencyKey?: unknown } | null;
      return summary?.idempotencyKey === key;
    });
    assertCanWithdrawRepair(actor, record, { allowNonPending: retry });
    if (retry) return toRepairView(record, { canViewOwnerPhone: true });
    if (record.version !== input.version)
      throw new AppError("REPAIR_VERSION_CONFLICT", "记录已被更新，请刷新后重试");
    const now = new Date();
    const updated = await inSerializableTransaction(async (tx) => {
      const result = await tx.repairRecord.updateMany({
        where: { id: recordId, version: input.version, status: "PENDING", deletedAt: null },
        // 不动 submittedAt：它同时是「这条草稿曾经提交过」的标记（issue #165 的「已撤回」标签）。
        data: { status: "DRAFT", version: { increment: 1 } },
      });
      if (result.count !== 1) throw new AppError("REPAIR_STATE_CONFLICT", "记录状态已变化");
      await timeline(
        tx,
        recordId,
        actor.userId,
        "WITHDRAWN",
        { from: "PENDING", to: "DRAFT", idempotencyKey: key },
        now,
      );
      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair.withdrawn",
        targetType: "RepairRecord",
        targetId: recordId,
        result: "SUCCESS",
        before: { status: "PENDING", version: record.version },
        after: { status: "DRAFT", version: record.version + 1 },
      });
      return tx.repairRecord.findUniqueOrThrow({
        where: { id: recordId },
        include: repairDetailInclude,
      });
    });
    return toRepairView(updated, { canViewOwnerPhone: true });
  },

  async softDelete(recordId, reason, actor) {
    requirePermission(actor, "repair:delete");
    const note = reason.trim();
    if (!note || note.length > 2000)
      throw new AppError("VALIDATION_FAILED", "删除原因必填且不能超过 2000 字");
    const record = await repairRepository.getById(recordId);
    const now = new Date();
    await inSerializableTransaction(async (tx) => {
      await tx.repairRecord.update({
        where: { id: recordId },
        data: { deletedAt: now, version: { increment: 1 } },
      });
      await timeline(tx, recordId, actor.userId, "DELETED", { reason: note }, now);
      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair.deleted",
        targetType: "RepairRecord",
        targetId: recordId,
        result: "SUCCESS",
        before: { status: record.status },
        after: { deleted: true, reason: note },
      });
    });
  },
};

/** 草稿字段 → 数据库列。管理端编辑（`repair-admin-service`）复用同一映射与 diff 计算。 */
export function dataFields(input: RepairDraftFields) {
  return {
    repairDate: parseRepairDate(input.repairDate),
    durationMinutes: input.durationMinutes,
    categoryId: input.categoryId,
    ownerName: input.ownerName,
    ownerPhone: input.ownerPhone,
    content: input.content,
    result: input.result,
    remark: input.remark,
  };
}
export function changedFields(
  record: Record<string, unknown>,
  input: Record<string, unknown>,
): string[] {
  return Object.keys(input).filter(
    (key) =>
      // 参与人员是关系数据（不在记录行上）：由调用方单独 diff 后以 "participants" 记入。
      key !== "participantIds" &&
      input[key] !== undefined &&
      String(record[key] ?? "") !== String(input[key] ?? ""),
  );
}
export async function timeline(
  tx: Prisma.TransactionClient,
  repairRecordId: string,
  actorUserId: string | undefined,
  eventType: string,
  summary: Prisma.InputJsonValue,
  createdAt: Date,
) {
  await tx.repairTimelineEvent.create({
    data: { id: randomUUID(), repairRecordId, actorUserId, eventType, summary, createdAt },
  });
}

/* ---------------------------------------------------- 参与维修人员（issue #114） */

/**
 * 参与维修人员的不变量与写入口径。
 *
 * - 每条记录恒有 ≥1 参与行：创建人本人、`sort_order = 0`（迁移已回填存量记录）；
 * - 输入数组（`participantIds`）只装额外成员、不含创建人本人；这里统一组装成最终有序集合；
 * - 建档 / 落单 / 历史导入是「一次性插入」，编辑是「整体替换」，都在与记录同一条事务内完成。
 */
export function composeParticipantIds(
  creatorMemberProfileId: string,
  extras: readonly string[],
): string[] {
  return [...new Set([creatorMemberProfileId, ...extras].map((id) => id.trim().toLowerCase()))];
}

/** 仅新增关联要求成员未软删除；保留历史参与者不阻止普通编辑。 */
export async function assertParticipantsExist(
  memberProfileIds: readonly string[],
  existingMemberProfileIds: readonly string[] = [],
): Promise<void> {
  const existing = new Set(existingMemberProfileIds.map((id) => id.toLowerCase()));
  const added = [...new Set(memberProfileIds.map((id) => id.toLowerCase()))].filter(
    (id) => !existing.has(id),
  );
  if (added.length === 0) return;
  const count = await getDb().memberProfile.count({
    where: { id: { in: added }, deletedAt: null },
  });
  if (count !== added.length)
    throw new AppError("VALIDATION_FAILED", "参与维修人员中有不存在的成员，请刷新页面后重试");
}

/** 建档 / 落单 / 历史导入路径：一次插入整组参与行（顺序即数组顺序）。 */
export async function insertRepairParticipants(
  tx: Prisma.TransactionClient,
  repairRecordId: string,
  orderedMemberIds: readonly string[],
  now: Date,
): Promise<void> {
  await tx.repairRecordParticipant.createMany({
    data: orderedMemberIds.map((memberProfileId, index) => ({
      id: randomUUID(),
      repairRecordId,
      memberProfileId,
      sortOrder: index,
      createdAt: now,
    })),
  });
}

/** 编辑路径：把参与行整体替换为目标集合，并修正 `sort_order`（顺序语义在这里落地）。 */
export async function replaceRepairParticipants(
  tx: Prisma.TransactionClient,
  repairRecordId: string,
  orderedMemberIds: readonly string[],
  now: Date,
): Promise<void> {
  const current = await tx.repairRecordParticipant.findMany({
    where: { repairRecordId },
    select: { memberProfileId: true, sortOrder: true },
  });
  const desired = new Set(orderedMemberIds);
  const removed = current
    .filter((row) => !desired.has(row.memberProfileId))
    .map((row) => row.memberProfileId);
  if (removed.length)
    await tx.repairRecordParticipant.deleteMany({
      where: { repairRecordId, memberProfileId: { in: removed } },
    });
  const currentIds = new Set(current.map((row) => row.memberProfileId));
  const added = orderedMemberIds.filter((id) => !currentIds.has(id));
  if (added.length)
    await tx.repairRecordParticipant.createMany({
      data: added.map((memberProfileId) => ({
        id: randomUUID(),
        repairRecordId,
        memberProfileId,
        sortOrder: orderedMemberIds.indexOf(memberProfileId),
        createdAt: now,
      })),
    });
  const sortOrderByMember = new Map(current.map((row) => [row.memberProfileId, row.sortOrder]));
  for (const [index, id] of orderedMemberIds.entries()) {
    const previous = sortOrderByMember.get(id);
    if (previous !== undefined && previous !== index)
      await tx.repairRecordParticipant.updateMany({
        where: { repairRecordId, memberProfileId: id },
        data: { sortOrder: index },
      });
  }
}

/**
 * 活动接待内部落单通道（仅供维修活动 serve 在同一可序列化事务内调用）。
 *
 * 生成 **DRAFT**（issue #79 第 6 项）：预填机主（姓名 / 电话）与日期 / 分类 / 机型，
 * 正文、时长、备注全部留空，由成员在表单里补齐后自行提交；只写 CREATED 时间线，
 * 不写 SUBMITTED、不置 `submittedAt`。来源痕留在时间线 summary 与审计里。
 * 参与维修人员（issue #114）先落接待人本人一行，其他成员由成员在表单里添加。
 */
export type CreateServeDraftForActivityInput = {
  memberProfileId: string;
  /** 分类映射结果；映射不到 / 已停用时为 null，由成员在表单里补选，接待动作本身必须成功。 */
  categoryId: string | null;
  repairDate: string; // YYYY-MM-DD（上海日历日）
  ownerName: string;
  /** 完整 11 位；可见性收口在视图层（`toRepairView` 的 `canViewOwnerPhone`），不在这里掩码。 */
  ownerPhone: string;
  /** 报名时选填的机型（issue #68）；没填传 null。 */
  deviceModel: string | null;
  /** 幂等键；固定 `activity-serve:{registrationId}` */
  createRequestKey: string;
  registrationId: string;
  activityId: string;
};

export async function createServeDraftForActivity(
  tx: Prisma.TransactionClient,
  input: CreateServeDraftForActivityInput,
  actor: import("@/types/contracts").AuthorizedActor,
  now: Date,
): Promise<{ repairRecordId: string }> {
  const existing = await tx.repairRecord.findUnique({
    where: { createRequestKey: input.createRequestKey },
  });
  if (existing && !existing.deletedAt) {
    return { repairRecordId: existing.id };
  }

  const repairDate = parseRepairDate(input.repairDate);
  if (!repairDate) {
    throw new AppError("VALIDATION_FAILED", "维修日期无效");
  }

  const recordId = randomUUID();
  await tx.repairRecord.create({
    data: {
      id: recordId,
      memberProfileId: input.memberProfileId,
      status: "DRAFT",
      createRequestKey: input.createRequestKey,
      repairDate,
      categoryId: input.categoryId,
      deviceModel: input.deviceModel,
      ownerName: input.ownerName,
      ownerPhone: input.ownerPhone,
      // 正文 / 时长 / 备注留空：模板正文、「1 分钟」占位与「活动接待自动落单」备注是旧流程
      // 的产物，改造后由成员在表单里补齐（issue #79 第 6 项）。
      content: null,
      durationMinutes: null,
      remark: null,
      result: defaultRepairResult,
      createdAt: now,
    },
  });
  await timeline(
    tx,
    recordId,
    actor.userId,
    "CREATED",
    {
      status: "DRAFT",
      source: "repair_activity_serve",
      activityId: input.activityId,
      registrationId: input.registrationId,
    },
    now,
  );
  // 参与维修人员（issue #114）：接待人本人先落一行（不变量：每条记录恒有 ≥1 参与行）。
  await insertRepairParticipants(tx, recordId, [input.memberProfileId], now);
  await appendAuditLog(tx, {
    actor,
    actorType: "USER",
    actorUserId: actor.userId,
    action: "repair.created_from_activity_serve",
    targetType: "RepairRecord",
    targetId: recordId,
    result: "SUCCESS",
    after: {
      activityId: input.activityId,
      registrationId: input.registrationId,
      categoryId: input.categoryId,
      status: "DRAFT",
    },
  });
  return { repairRecordId: recordId };
}
