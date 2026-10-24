import {
  assertValidIssueType,
  mapIssueTypeToCategoryCode,
  shanghaiCalendarDay,
} from "@/features/repair-activities/repair-activity-validation";
import { AppError } from "@/lib/api/errors";
import { CN_MOBILE_PATTERN } from "@/lib/security/normalization";
import { parseRepairDate, validateSubmission } from "./repair-validation";

/** 时间线 / 审计里标注这次处置的来源，便于事后筛选。 */
export const DRAFT_RETIREMENT_AUDIT_SOURCE = "draft-retire";
export const DRAFT_RETIREMENT_VOID_REASON = "草稿下线（#223）：不满足补提条件，作废";

export type DraftRetirementSource = "activity" | "legacy-activity" | "manual";
export type DraftRetirementWithdrawnMode = "void" | "submit";
export type DraftRetirementAction = "submit" | "void" | "withdrawn-pending";

export type DraftRetirementRegistration = {
  id: string;
  name: string;
  phone: string;
  deviceModel: string | null;
  issueType: string;
  activityAt: Date;
};

export type DraftRetirementRecord = {
  id: string;
  version: number;
  createRequestKey: string;
  result: string | null;
  repairDate: Date | null;
  durationMinutes: number | null;
  categoryId: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  deviceModel: string | null;
  content: string | null;
  submittedAt: Date | null;
  registration: DraftRetirementRegistration | null;
};

/** 只含「启用且未删除」的分类；`activeIdByCode` 供报名故障类型映射使用。 */
export type DraftRetirementCategoryLookup = {
  activeIds: ReadonlySet<string>;
  activeIdByCode: ReadonlyMap<string, string>;
};

export type DraftRetirementPatch = {
  ownerName?: string;
  ownerPhone?: string;
  deviceModel?: string;
  repairDate?: Date;
  categoryId?: string;
};

export type DraftRetirementVoidReason =
  | "result-not-completed"
  | "duration-missing-or-invalid"
  | "owner-name-missing"
  | "owner-phone-missing-or-invalid"
  | "device-model-missing"
  | "repair-date-missing-or-invalid"
  | "category-missing-or-invalid"
  | "content-too-long"
  | "submission-incomplete"
  | "withdrawn-policy-void";

export type DraftRetirementPlanItem = {
  recordId: string;
  version: number;
  source: DraftRetirementSource;
  withdrawn: boolean;
  previousSubmittedAt: string | null;
  action: DraftRetirementAction;
  eligibleToSubmit: boolean;
  patch: DraftRetirementPatch;
  changedFields: string[];
  categoryRemapped: { from: string | null; toCode: string } | null;
  missingBefore: string[];
  fieldErrors: Record<string, string[]>;
  voidReasons: DraftRetirementVoidReason[];
  registrationId: string | null;
};

export type DraftRetirementReport = {
  total: number;
  byAction: Record<DraftRetirementAction, number>;
  bySource: Record<DraftRetirementSource, Record<DraftRetirementAction, number>>;
  byMissingField: Record<string, number>;
  byBackfilledField: Record<string, number>;
  byVoidReason: Partial<Record<DraftRetirementVoidReason, number>>;
  withdrawn: {
    total: number;
    eligibleToSubmit: number;
    ineligible: number;
    mode: DraftRetirementWithdrawnMode | null;
  };
  items: DraftRetirementPlanItem[];
};

const BACKFILL_FIELDS = [
  "ownerName",
  "ownerPhone",
  "deviceModel",
  "repairDate",
  "categoryId",
] as const;

/**
 * 盘点并规划每条存量草稿的处置；不读写数据库，dry-run / apply 共用同一份判断。
 *
 * - 只从关联报名的姓名 / 电话 / 机型 / 活动日期与故障类型映射补全，不猜数据；
 * - 电话已有但格式不合法时，允许用报名电话纠正；分类失效时允许按故障类型重映射；
 * - 结果不是「已完成」、时长缺失或补全后仍过不了提交校验的，转入作废；
 * - 已撤回草稿（`submittedAt` 非空）单独标记：未指定策略时只报告，不擅自处置。
 */
export function planDraftRetirement(
  records: readonly DraftRetirementRecord[],
  categories: DraftRetirementCategoryLookup,
  options: { withdrawnMode: DraftRetirementWithdrawnMode | null },
): DraftRetirementPlanItem[] {
  return records.map((record) => planRecord(record, categories, options.withdrawnMode));
}

function planRecord(
  record: DraftRetirementRecord,
  categories: DraftRetirementCategoryLookup,
  withdrawnMode: DraftRetirementWithdrawnMode | null,
): DraftRetirementPlanItem {
  const registration = record.registration;
  const patch: DraftRetirementPatch = {};
  let categoryRemapped: DraftRetirementPlanItem["categoryRemapped"] = null;

  if (!hasText(record.ownerName) && registration) patch.ownerName = registration.name;
  if (!hasValidPhone(record.ownerPhone) && registration && hasValidPhone(registration.phone))
    patch.ownerPhone = registration.phone;
  if (!hasText(record.deviceModel) && registration?.deviceModel)
    patch.deviceModel = registration.deviceModel;
  if (!record.repairDate && registration) {
    const repairDate = parseRepairDate(shanghaiCalendarDay(registration.activityAt));
    if (repairDate) patch.repairDate = repairDate;
  }
  if (!record.categoryId || !categories.activeIds.has(record.categoryId)) {
    const code = mappedCategoryCode(registration?.issueType);
    const mappedId = code ? categories.activeIdByCode.get(code) : undefined;
    if (mappedId) {
      patch.categoryId = mappedId;
      categoryRemapped = { from: record.categoryId, toCode: code! };
    }
  }

  const candidate = {
    repairDate: patch.repairDate ?? record.repairDate,
    durationMinutes: record.durationMinutes,
    categoryId: patch.categoryId ?? record.categoryId,
    ownerName: patch.ownerName ?? record.ownerName,
    ownerPhone: patch.ownerPhone ?? record.ownerPhone,
    deviceModel: patch.deviceModel ?? record.deviceModel,
    content: record.content,
    result: record.result,
  };
  const fieldErrors = submissionErrors(candidate, categories);
  const eligibleToSubmit = record.result === "COMPLETED" && Object.keys(fieldErrors).length === 0;
  const withdrawn = record.submittedAt !== null;
  const action = decideAction(withdrawn, eligibleToSubmit, withdrawnMode);
  const voidReasons = collectVoidReasons(record, fieldErrors, action);

  return {
    recordId: record.id,
    version: record.version,
    source: record.registration
      ? "activity"
      : record.createRequestKey.startsWith("activity-serve:")
        ? "legacy-activity"
        : "manual",
    withdrawn,
    previousSubmittedAt: record.submittedAt?.toISOString() ?? null,
    action,
    eligibleToSubmit,
    patch,
    changedFields: BACKFILL_FIELDS.filter((field) => patch[field] !== undefined),
    categoryRemapped,
    missingBefore: missingFields(record),
    fieldErrors,
    voidReasons,
    registrationId: registration?.id ?? null,
  };
}

function decideAction(
  withdrawn: boolean,
  eligibleToSubmit: boolean,
  mode: DraftRetirementWithdrawnMode | null,
): DraftRetirementAction {
  if (!withdrawn) return eligibleToSubmit ? "submit" : "void";
  if (mode === null) return "withdrawn-pending";
  return mode === "submit" && eligibleToSubmit ? "submit" : "void";
}

function collectVoidReasons(
  record: DraftRetirementRecord,
  fieldErrors: Record<string, string[]>,
  action: DraftRetirementAction,
): DraftRetirementVoidReason[] {
  const reasons = new Set<DraftRetirementVoidReason>();
  if (record.result !== "COMPLETED") reasons.add("result-not-completed");
  for (const field of Object.keys(fieldErrors)) reasons.add(voidReasonForField(field));
  if (action === "void" && record.submittedAt !== null) reasons.add("withdrawn-policy-void");
  return [...reasons];
}

function submissionErrors(
  candidate: {
    repairDate: Date | null;
    durationMinutes: number | null;
    categoryId: string | null;
    ownerName: string | null;
    ownerPhone: string | null;
    deviceModel: string | null;
    content: string | null;
    result: string | null;
  },
  categories: DraftRetirementCategoryLookup,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  try {
    // 传变量而不是字面量：未来提交校验新增字段时，这里不需要跟着改形参。
    validateSubmission(candidate);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    Object.assign(errors, error.fieldErrors ?? {});
  }
  if (!candidate.categoryId || !categories.activeIds.has(candidate.categoryId))
    errors.categoryId = ["请选择有效的故障分类"];
  return errors;
}

function voidReasonForField(field: string): DraftRetirementVoidReason {
  switch (field) {
    case "repairDate":
      return "repair-date-missing-or-invalid";
    case "durationMinutes":
      return "duration-missing-or-invalid";
    case "categoryId":
      return "category-missing-or-invalid";
    case "ownerName":
      return "owner-name-missing";
    case "ownerPhone":
      return "owner-phone-missing-or-invalid";
    case "deviceModel":
      return "device-model-missing";
    case "content":
      return "content-too-long";
    case "result":
      return "result-not-completed";
    default:
      return "submission-incomplete";
  }
}

function mappedCategoryCode(issueType: string | undefined): string | null {
  if (!issueType) return null;
  try {
    return mapIssueTypeToCategoryCode(assertValidIssueType(issueType));
  } catch {
    return null;
  }
}

function missingFields(record: DraftRetirementRecord): string[] {
  const missing: string[] = [];
  if (!hasText(record.ownerName)) missing.push("ownerName");
  if (!hasText(record.ownerPhone)) missing.push("ownerPhone");
  if (!hasText(record.deviceModel)) missing.push("deviceModel");
  if (!record.repairDate) missing.push("repairDate");
  if (!record.categoryId) missing.push("categoryId");
  return missing;
}

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function hasValidPhone(value: string | null | undefined): boolean {
  return Boolean(value && CN_MOBILE_PATTERN.test(value));
}

export function summarizeDraftRetirement(
  items: readonly DraftRetirementPlanItem[],
  mode: DraftRetirementWithdrawnMode | null,
): DraftRetirementReport {
  const emptyActions = (): Record<DraftRetirementAction, number> => ({
    submit: 0,
    void: 0,
    "withdrawn-pending": 0,
  });
  const byAction = emptyActions();
  const bySource: DraftRetirementReport["bySource"] = {
    activity: emptyActions(),
    "legacy-activity": emptyActions(),
    manual: emptyActions(),
  };
  const byMissingField: Record<string, number> = {};
  const byBackfilledField: Record<string, number> = {};
  const byVoidReason: DraftRetirementReport["byVoidReason"] = {};
  const withdrawn = { total: 0, eligibleToSubmit: 0, ineligible: 0, mode };

  for (const item of items) {
    byAction[item.action] += 1;
    bySource[item.source][item.action] += 1;
    for (const field of item.missingBefore)
      byMissingField[field] = (byMissingField[field] ?? 0) + 1;
    for (const field of item.changedFields)
      byBackfilledField[field] = (byBackfilledField[field] ?? 0) + 1;
    for (const reason of item.voidReasons) byVoidReason[reason] = (byVoidReason[reason] ?? 0) + 1;
    if (item.withdrawn) {
      withdrawn.total += 1;
      if (item.eligibleToSubmit) withdrawn.eligibleToSubmit += 1;
      else withdrawn.ineligible += 1;
    }
  }

  return {
    total: items.length,
    byAction,
    bySource,
    byMissingField,
    byBackfilledField,
    byVoidReason,
    withdrawn,
    items: [...items],
  };
}
