import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/audit-service";
import { AppError } from "@/lib/api/errors";
import { getDb } from "@/lib/db/client";
import { inSerializableTransaction } from "@/lib/db/transaction";
import type { PublicRequestContext } from "@/types/contracts";
import {
  DRAFT_RETIREMENT_AUDIT_SOURCE,
  DRAFT_RETIREMENT_VOID_REASON,
  planDraftRetirement,
  summarizeDraftRetirement,
  type DraftRetirementCategoryLookup,
  type DraftRetirementPlanItem,
  type DraftRetirementRecord,
  type DraftRetirementReport,
  type DraftRetirementWithdrawnMode,
} from "./repair-draft-retirement";
import { timeline } from "./repair-service";

const snapshotInclude = {
  memberProfile: { select: { id: true, realName: true } },
  category: true,
  activityRegistration: { include: { activity: true } },
  participants: true,
  timeline: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  photos: true,
  reviews: true,
  comments: true,
  favorites: true,
  notifications: true,
} satisfies Prisma.RepairRecordInclude;

/** 只统计未删除的登记行：软删除登记不参与悬挂判定（存量历史数据不阻断本次执行）。 */
const danglingRegistrationWhere = {
  deletedAt: null,
  repairRecordId: { not: null },
  repairRecord: { is: { deletedAt: { not: null } } },
} satisfies Prisma.RepairActivityRegistrationWhereInput;

export type DraftRetirementSnapshot = {
  exportedAt: string;
  database: string;
  records: Prisma.RepairRecordGetPayload<{ include: typeof snapshotInclude }>[];
};

export type DraftRetirementPostCheck = {
  /** 仍处于可编辑状态的 DRAFT 数量，apply 后必须为 0。 */
  activeDraftCount: number;
  submittedPendingCount: number;
  voidedCount: number;
  clearedRegistrationCount: number;
  /** 执行前已存在的悬挂（未删除登记行仍指向已软删除记录），只作 baseline。 */
  baselineDanglingRegistrationCount: number;
  /** 执行后仍未删除的悬挂数量；软删除登记行不参与统计。 */
  danglingRegistrationCount: number;
  /** 本次执行净新增的悬挂，必须为 0。 */
  newDanglingRegistrationCount: number;
  /** 待补建接待数量（含执行前已存在；信息项，不参与通过判定）。 */
  servedWithoutRecordCount: number;
};

export type DraftRetirementApplyResult = {
  runId: string;
  backupPath: string;
  submittedRecordIds: string[];
  voidedRecordIds: string[];
  clearedRegistrationIds: string[];
  failures: { recordId: string; message: string }[];
  postCheck: DraftRetirementPostCheck;
  postCheckPassed: boolean;
};

export type RetireRepairDraftsOptions = {
  apply: boolean;
  withdrawnMode: DraftRetirementWithdrawnMode | null;
  /** apply 前写出完整快照并返回备份文件路径；没有它不允许写库。 */
  backupWriter?: (
    snapshot: DraftRetirementSnapshot,
    report: DraftRetirementReport,
    meta: { runId: string; startedAt: string },
  ) => Promise<string>;
  now?: Date;
  runId?: string;
};

export type RetireRepairDraftsResult = {
  report: DraftRetirementReport;
  applied?: DraftRetirementApplyResult;
};

/**
 * 盘点 / 处置存量维修草稿。
 *
 * 与迁移脚本不同，这里不引入新状态：可补提的转 `PENDING`，其余软删除并清空接待关联。
 * 每条记录单独事务、以 `version` 做乐观锁；失败项会留在报告里，重跑只处理剩余草稿。
 */
export async function retireRepairDrafts(
  options: RetireRepairDraftsOptions,
): Promise<RetireRepairDraftsResult> {
  const snapshot = await loadSnapshot();
  const categories = await loadCategories();
  const records = snapshot.records.map(toPlanningRecord);
  const items = planDraftRetirement(records, categories, {
    withdrawnMode: options.withdrawnMode,
  });
  const report = summarizeDraftRetirement(items, options.withdrawnMode);
  if (!options.apply) return { report };

  if (report.withdrawn.total > 0 && options.withdrawnMode === null)
    throw new Error("存在已撤回草稿：请用 --submitted=void|submit 明确处置口径后重试。");
  if (!options.backupWriter) throw new Error("apply 必须先写出备份，拒绝继续。");
  const baselineDanglingRegistrationCount = await countDanglingRegistrations();
  const now = options.now ?? new Date();
  const runId = options.runId ?? createRunId(now);
  const backupPath = await options.backupWriter(snapshot, report, {
    runId,
    startedAt: now.toISOString(),
  });

  const context: PublicRequestContext = { requestId: runId };
  const submittedRecordIds: string[] = [];
  const voidedRecordIds: string[] = [];
  const clearedRegistrationIds: string[] = [];
  const failures: DraftRetirementApplyResult["failures"] = [];

  for (const item of items) {
    if (item.action === "withdrawn-pending")
      throw new Error(`记录 ${item.recordId} 的已撤回处置口径未确定，拒绝继续。`);
    try {
      if (item.action === "submit") {
        await applySubmit(item, { now, runId, context });
        submittedRecordIds.push(item.recordId);
      } else {
        await applyVoid(item, { now, runId, context });
        voidedRecordIds.push(item.recordId);
        if (item.registrationId) clearedRegistrationIds.push(item.registrationId);
      }
    } catch (error) {
      failures.push({
        recordId: item.recordId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const postCheck = await inspectPostConditions({
    submittedRecordIds,
    voidedRecordIds,
    clearedRegistrationIds,
    baselineDanglingRegistrationCount,
  });
  const postCheckPassed =
    failures.length === 0 &&
    postCheck.activeDraftCount === 0 &&
    postCheck.submittedPendingCount === submittedRecordIds.length &&
    postCheck.voidedCount === voidedRecordIds.length &&
    postCheck.clearedRegistrationCount === clearedRegistrationIds.length &&
    postCheck.newDanglingRegistrationCount === 0;

  return {
    report,
    applied: {
      runId,
      backupPath,
      submittedRecordIds,
      voidedRecordIds,
      clearedRegistrationIds,
      failures,
      postCheck,
      postCheckPassed,
    },
  };
}

async function loadSnapshot(): Promise<DraftRetirementSnapshot> {
  const records = await getDb().repairRecord.findMany({
    where: { status: "DRAFT", deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: snapshotInclude,
  });
  return {
    exportedAt: new Date().toISOString(),
    database: databaseLabel(),
    records,
  };
}

async function loadCategories(): Promise<DraftRetirementCategoryLookup> {
  const rows = await getDb().repairCategory.findMany({
    where: { deletedAt: null, isActive: true },
    select: { id: true, code: true },
  });
  return {
    activeIds: new Set(rows.map((row) => row.id)),
    activeIdByCode: new Map(rows.map((row) => [row.code, row.id])),
  };
}

type SnapshotRecord = DraftRetirementSnapshot["records"][number];

function toPlanningRecord(row: SnapshotRecord): DraftRetirementRecord {
  const registration = row.activityRegistration;
  return {
    id: row.id,
    version: row.version,
    createRequestKey: row.createRequestKey,
    result: row.result,
    repairDate: row.repairDate,
    durationMinutes: row.durationMinutes,
    categoryId: row.categoryId,
    ownerName: row.ownerName,
    ownerPhone: row.ownerPhone,
    deviceModel: row.deviceModel,
    content: row.content,
    submittedAt: row.submittedAt,
    registration: registration
      ? {
          id: registration.id,
          name: registration.name,
          phone: registration.phone,
          deviceModel: registration.deviceModel,
          issueType: registration.issueType,
          activityAt: registration.activity.activityAt,
        }
      : null,
  };
}

type ApplyContext = {
  now: Date;
  runId: string;
  context: PublicRequestContext;
};

async function applySubmit(item: DraftRetirementPlanItem, ctx: ApplyContext): Promise<void> {
  await inSerializableTransaction(async (tx) => {
    const updated = await tx.repairRecord.updateMany({
      where: {
        id: item.recordId,
        status: "DRAFT",
        deletedAt: null,
        version: item.version,
      },
      data: {
        ...item.patch,
        status: "PENDING",
        submittedAt: ctx.now,
        reviewedAt: null,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new AppError("REPAIR_VERSION_CONFLICT", "草稿已被修改，请重新盘点后重试");
    await timeline(
      tx,
      item.recordId,
      undefined,
      "SUBMITTED",
      {
        from: "DRAFT",
        to: "PENDING",
        source: DRAFT_RETIREMENT_AUDIT_SOURCE,
        runId: ctx.runId,
        backfilled: item.changedFields,
        ...(item.categoryRemapped ? { categoryRemapped: item.categoryRemapped } : {}),
        ...(item.previousSubmittedAt ? { previouslySubmittedAt: item.previousSubmittedAt } : {}),
      },
      ctx.now,
    );
    await appendAuditLog(tx, {
      actor: ctx.context,
      actorType: "SYSTEM",
      action: "repair.draft_retired_submitted",
      targetType: "RepairRecord",
      targetId: item.recordId,
      result: "SUCCESS",
      before: { status: "DRAFT", submittedAt: item.previousSubmittedAt },
      after: {
        status: "PENDING",
        source: DRAFT_RETIREMENT_AUDIT_SOURCE,
        backfilled: item.changedFields,
        ...(item.categoryRemapped ? { categoryRemapped: item.categoryRemapped } : {}),
        submittedAt: ctx.now.toISOString(),
      },
    });
  });
}

async function applyVoid(item: DraftRetirementPlanItem, ctx: ApplyContext): Promise<void> {
  await inSerializableTransaction(async (tx) => {
    const updated = await tx.repairRecord.updateMany({
      where: {
        id: item.recordId,
        status: "DRAFT",
        deletedAt: null,
        version: item.version,
      },
      data: { deletedAt: ctx.now, version: { increment: 1 } },
    });
    if (updated.count !== 1)
      throw new AppError("REPAIR_VERSION_CONFLICT", "草稿已被修改，请重新盘点后重试");
    if (item.registrationId) {
      const cleared = await tx.repairActivityRegistration.updateMany({
        where: { id: item.registrationId, repairRecordId: item.recordId },
        data: { repairRecordId: null },
      });
      if (cleared.count !== 1)
        throw new AppError("REPAIR_STATE_CONFLICT", "接待关联已被其他操作修改，请重新盘点后重试");
    }
    await timeline(
      tx,
      item.recordId,
      undefined,
      "DELETED",
      {
        reason: DRAFT_RETIREMENT_VOID_REASON,
        source: DRAFT_RETIREMENT_AUDIT_SOURCE,
        runId: ctx.runId,
        voidReasons: item.voidReasons,
        ...(item.registrationId ? { registrationId: item.registrationId } : {}),
      },
      ctx.now,
    );
    await appendAuditLog(tx, {
      actor: ctx.context,
      actorType: "SYSTEM",
      action: "repair.draft_retired_voided",
      targetType: "RepairRecord",
      targetId: item.recordId,
      result: "SUCCESS",
      before: { status: "DRAFT", submittedAt: item.previousSubmittedAt },
      after: {
        status: "DRAFT",
        deletedAt: ctx.now.toISOString(),
        source: DRAFT_RETIREMENT_AUDIT_SOURCE,
        voidReasons: item.voidReasons,
        registrationId: item.registrationId,
      },
    });
  });
}

async function inspectPostConditions(input: {
  submittedRecordIds: string[];
  voidedRecordIds: string[];
  clearedRegistrationIds: string[];
  baselineDanglingRegistrationCount: number;
}): Promise<DraftRetirementPostCheck> {
  const db = getDb();
  const activeDraftCount = await db.repairRecord.count({
    where: { status: "DRAFT", deletedAt: null },
  });
  const submittedPendingCount = input.submittedRecordIds.length
    ? await db.repairRecord.count({
        where: {
          id: { in: input.submittedRecordIds },
          status: "PENDING",
          submittedAt: { not: null },
          deletedAt: null,
        },
      })
    : 0;
  const voidedCount = input.voidedRecordIds.length
    ? await db.repairRecord.count({
        where: { id: { in: input.voidedRecordIds }, deletedAt: { not: null } },
      })
    : 0;
  const clearedRegistrationCount = input.clearedRegistrationIds.length
    ? await db.repairActivityRegistration.count({
        where: { id: { in: input.clearedRegistrationIds }, repairRecordId: null },
      })
    : 0;
  const danglingRegistrationCount = await countDanglingRegistrations();
  const servedWithoutRecordCount = await db.repairActivityRegistration.count({
    where: { status: "SERVED", repairRecordId: null, deletedAt: null },
  });
  return {
    activeDraftCount,
    submittedPendingCount,
    voidedCount,
    clearedRegistrationCount,
    baselineDanglingRegistrationCount: input.baselineDanglingRegistrationCount,
    danglingRegistrationCount,
    newDanglingRegistrationCount: Math.max(
      0,
      danglingRegistrationCount - input.baselineDanglingRegistrationCount,
    ),
    servedWithoutRecordCount,
  };
}

async function countDanglingRegistrations(): Promise<number> {
  return getDb().repairActivityRegistration.count({ where: danglingRegistrationWhere });
}

function createRunId(now: Date): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `draft-retire-${stamp}-${randomUUID().slice(0, 8)}`;
}

/** 只用于输出 / 备份标识，不包含账号密码。 */
export function databaseLabel(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "(未设置 DATABASE_URL)";
  const url = new URL(raw);
  return `${url.hostname}:${url.port || "3306"}${url.pathname}`;
}
