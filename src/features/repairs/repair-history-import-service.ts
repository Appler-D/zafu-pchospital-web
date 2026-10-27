import { randomUUID } from "node:crypto";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { requirePermission } from "@/lib/auth/permissions";
import { inSerializableTransaction } from "@/lib/db/transaction";
import type { AuthorizedActor, PublicRequestContext } from "@/types/contracts";
import { insertRepairParticipants, timeline } from "./repair-service";
import type { PendingHistoryRow, ValidHistoryRow } from "./repair-history-import";

/**
 * 历史修机数据落库通道（CLI 与注册流程调用）。
 *
 * 与活动接待一样属于「非成员手工流程」的例外：历史记录已实际完成、由管理员整批
 * 确认导入，直接写 `APPROVED`（无照片、不走 `repair_reviews`），以 timeline 与
 * 审计说明来源是 `history_import`。行指纹幂等：重复导入同一行会跳过。
 *
 * 「先修机、后注册」由两段接力完成（评审 1，保证历史数据只导入一次）：
 * `storePendingHistory` 把姓名尚未在册的行暂存到 `repair_history_pending`；
 * 该姓名的新成员在三条建档路径（邀请码注册、面试通过发放、管理端新增）建档后，
 * 由 `claimHistoryForNewMember` 自动补录 —— 与 CLI 共用一个指纹，谁先到都不重复。
 */
export async function applyHistoryImport(
  rows: ValidHistoryRow[],
  actor: AuthorizedActor,
): Promise<{ inserted: number; skipped: number }> {
  requirePermission(actor, "repair:review");
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    // 计数放在事务外：可序列化事务遇 P2034 会重跑回调，事务内累加会重复计数（评审）。
    const outcome = await inSerializableTransaction(async (tx) => {
      const existing = await tx.repairRecord.findUnique({
        where: { createRequestKey: row.idempotencyKey },
      });
      if (existing) return "skipped" as const;
      const recordId = randomUUID();
      const now = new Date();
      // 三条 timeline 若共用同一毫秒，按 createdAt 排序的结果不稳定（实测会乱序成
      // SUBMITTED/APPROVED/CREATED）；以 1ms 步长错开，时间线顺序才确定。
      const createdEventAt = now;
      const submittedEventAt = new Date(now.getTime() + 1);
      const approvedEventAt = new Date(now.getTime() + 2);
      await tx.repairRecord.create({
        data: {
          id: recordId,
          memberProfileId: row.memberProfileId,
          status: "APPROVED",
          createRequestKey: row.idempotencyKey,
          repairDate: new Date(`${row.repairDate}T00:00:00.000Z`),
          durationMinutes: row.durationMinutes,
          categoryId: row.categoryId,
          content: row.content,
          result: row.result,
          remark: row.remark,
          submittedAt: now,
          reviewedAt: now,
          createdAt: now,
        },
      });
      // 参与维修人员：历史行按「维修人员姓名」匹配出的成员本人一行。
      await insertRepairParticipants(tx, recordId, [row.memberProfileId], now);
      await timeline(
        tx,
        recordId,
        actor.userId,
        "CREATED",
        { status: "DRAFT", source: "history_import" },
        createdEventAt,
      );
      await timeline(
        tx,
        recordId,
        actor.userId,
        "SUBMITTED",
        {
          from: "DRAFT",
          to: "PENDING",
          source: "history_import",
          idempotencyKey: row.idempotencyKey,
        },
        submittedEventAt,
      );
      await timeline(
        tx,
        recordId,
        actor.userId,
        "APPROVED",
        { from: "PENDING", to: "APPROVED", source: "history_import" },
        approvedEventAt,
      );
      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair.history_imported",
        targetType: "RepairRecord",
        targetId: recordId,
        result: "SUCCESS",
        after: {
          source: "history_import",
          lineNo: row.lineNo,
          memberProfileId: row.memberProfileId,
          categoryId: row.categoryId,
          status: "APPROVED",
        },
      });
      return "inserted" as const;
    });
    if (outcome === "inserted") inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}

/**
 * 暂存「姓名尚未在册」的历史行（CLI `--apply` 调用）。
 *
 * 与 `applyHistoryImport` 同一次运行、同一把行指纹：能直接导入的走前者，
 * 人名对不上的走这里落 `repair_history_pending` —— 于是这份历史数据**只被消费一次**，
 * 谁先（导入时已建成员 / 之后注册）都不会重复。按指纹幂等，重跑只跳过。
 */
export async function storePendingHistory(
  rows: PendingHistoryRow[],
  actor: AuthorizedActor,
  sourceFile?: string,
): Promise<{ stored: number; skipped: number }> {
  requirePermission(actor, "repair:review");
  const unique = new Map<string, PendingHistoryRow>();
  for (const row of rows) unique.set(row.fingerprint, row);
  const incoming = [...unique.values()];
  if (incoming.length === 0) return { stored: 0, skipped: 0 };
  return inSerializableTransaction(async (tx) => {
    const known = new Set(
      (
        await tx.repairHistoryPending.findMany({
          where: { fingerprint: { in: incoming.map((row) => row.fingerprint) } },
          select: { fingerprint: true },
        })
      ).map((row) => row.fingerprint),
    );
    const fresh = incoming.filter((row) => !known.has(row.fingerprint));
    const now = new Date();
    // 先算好 id：审计的 targetId 要指向本批第一行，createMany 自己生成不了。
    const created = fresh.map((row) => ({ id: randomUUID(), row }));
    if (created.length > 0) {
      await tx.repairHistoryPending.createMany({
        data: created.map(({ id, row }) => ({
          id,
          fingerprint: row.fingerprint,
          realName: row.realName,
          repairDate: new Date(`${row.repairDate}T00:00:00.000Z`),
          durationMinutes: row.durationMinutes,
          categoryId: row.categoryId,
          content: row.content,
          result: row.result,
          remark: row.remark,
          sourceFile: sourceFile ?? null,
          sourceLine: row.lineNo,
          importedByUserId: actor.userId ?? null,
          importedAt: now,
        })),
      });
      await appendAuditLog(tx, {
        actor,
        actorType: "USER",
        actorUserId: actor.userId,
        action: "repair.history_pending_imported",
        targetType: "RepairHistoryPending",
        targetId: created[0]!.id,
        result: "SUCCESS",
        after: {
          source: "history_import",
          stored: created.length,
          skipped: incoming.length - created.length,
          sourceFile: sourceFile ?? null,
        },
      });
    }
    return { stored: created.length, skipped: incoming.length - created.length };
  });
}

export type HistoryClaimInput = {
  memberProfileId: string;
  /** 与暂存行的 realName 同口径的姓名（trim 后）。 */
  realName: string;
  /** 审计上下文（requestId 等）。 */
  actor: AuthorizedActor | PublicRequestContext;
  actorType: "USER" | "SYSTEM";
  /** 触发补录的人：管理员建档为管理员，注册流程为该用户本人；纯系统流程可空。 */
  actorUserId?: string;
};

/**
 * 把暂存的历史行补录给刚建档的成员——「先修机、后注册」的自动闭环。
 *
 * 三条硬规则：
 * 1. **重名不猜**：同名在册成员不止一位时整组不认领（与导入口径一致，留人工）；
 * 2. **指纹即 createRequestKey**：如果该行已经被 CLI 导入过（成员后来被导入时匹配上），
 *    只标记认领、不重复建记录；
 * 3. 与导入通道同样落 `APPROVED` + 三条 timeline（source 为 `history_import_claim`），
 *    每个成员一条审计汇总，而不是每行一条。
 */
export async function claimPendingHistoryForProfile(input: HistoryClaimInput): Promise<number> {
  return inSerializableTransaction(async (tx) => {
    const sameName = await tx.memberProfile.count({
      where: { realName: input.realName, deletedAt: null, status: "ACTIVE" },
    });
    if (sameName !== 1) return 0;
    const pending = await tx.repairHistoryPending.findMany({
      where: { realName: input.realName, claimedAt: null },
      orderBy: [{ importedAt: "asc" }, { id: "asc" }],
    });
    if (pending.length === 0) return 0;
    const now = new Date();
    const pendingIds: string[] = [];
    const recordIds: string[] = [];
    for (const row of pending) {
      const existing = await tx.repairRecord.findUnique({
        where: { createRequestKey: row.fingerprint },
        select: { id: true },
      });
      let recordId = existing?.id;
      if (!recordId) {
        // 兜底分类若已被删除，记录照常补录（categoryId 可空），只是没有分类标签。
        const category = await tx.repairCategory.findFirst({
          where: { id: row.categoryId, deletedAt: null },
          select: { id: true },
        });
        recordId = randomUUID();
        // 与导入通道同样错开 1ms：同一毫秒下按 createdAt 排序的时间线会乱序。
        const createdEventAt = now;
        const submittedEventAt = new Date(now.getTime() + 1);
        const approvedEventAt = new Date(now.getTime() + 2);
        await tx.repairRecord.create({
          data: {
            id: recordId,
            memberProfileId: input.memberProfileId,
            status: "APPROVED",
            createRequestKey: row.fingerprint,
            repairDate: row.repairDate,
            durationMinutes: row.durationMinutes,
            categoryId: category?.id ?? null,
            content: row.content,
            result: row.result,
            remark: row.remark,
            submittedAt: now,
            reviewedAt: now,
            createdAt: now,
          },
        });
        // 参与维修人员：认领行归新成员本人，同样先落一行。
        await insertRepairParticipants(tx, recordId, [input.memberProfileId], now);
        await timeline(
          tx,
          recordId,
          input.actorUserId,
          "CREATED",
          { status: "DRAFT", source: "history_import_claim" },
          createdEventAt,
        );
        await timeline(
          tx,
          recordId,
          input.actorUserId,
          "SUBMITTED",
          { from: "DRAFT", to: "PENDING", source: "history_import_claim" },
          submittedEventAt,
        );
        await timeline(
          tx,
          recordId,
          input.actorUserId,
          "APPROVED",
          { from: "PENDING", to: "APPROVED", source: "history_import_claim" },
          approvedEventAt,
        );
      }
      await tx.repairHistoryPending.update({
        where: { id: row.id },
        data: {
          claimedAt: now,
          claimedByProfileId: input.memberProfileId,
          createdRecordId: recordId,
        },
      });
      pendingIds.push(row.id);
      recordIds.push(recordId);
    }
    await appendAuditLog(tx, {
      actor: input.actor,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      action: "member.history_claimed",
      targetType: "MemberProfile",
      targetId: input.memberProfileId,
      result: "SUCCESS",
      after: {
        source: "history_import_claim",
        count: pendingIds.length,
        pendingIds,
        recordIds,
      },
    });
    return pendingIds.length;
  });
}

/**
 * 注册/建档后的自动补录入口：异常一律吞掉。
 *
 * 补录是注册的**附加**动作 —— 历史暂存行的任何问题都不该让注册失败；
 * 失败时暂存行原样保留，管理员对同一文件重跑 CLI `--apply` 也能补上（双保险）。
 */
export async function claimHistoryForNewMember(input: HistoryClaimInput): Promise<void> {
  try {
    await claimPendingHistoryForProfile(input);
  } catch (error) {
    console.error("[repairs] 注册后补录历史记录失败，暂存行保留待重跑导入", error);
  }
}
