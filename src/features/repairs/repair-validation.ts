import { repairFieldLimits } from "@/config/repairs";
import { AppError } from "@/lib/api/errors";
import { CN_MOBILE_PATTERN } from "@/lib/security/normalization";
import { shanghaiToday } from "@/lib/shanghai-date";
import type { RepairDraftFields, RepairResult } from "@/types/contracts";

export function normalizeDraftFields(input: RepairDraftFields): RepairDraftFields {
  return {
    repairDate: input.repairDate === undefined ? undefined : input.repairDate || null,
    durationMinutes: input.durationMinutes,
    categoryId: input.categoryId === undefined ? undefined : input.categoryId || null,
    ownerName: input.ownerName === undefined ? undefined : clean(input.ownerName),
    ownerPhone: input.ownerPhone === undefined ? undefined : cleanOwnerPhone(input.ownerPhone),
    deviceModel: input.deviceModel === undefined ? undefined : clean(input.deviceModel),
    content: input.content === undefined ? undefined : clean(input.content),
    result: input.result,
    remark: input.remark === undefined ? undefined : clean(input.remark),
    participantIds:
      input.participantIds === undefined
        ? undefined
        : normalizeParticipantIds(input.participantIds),
  };
}

/**
 * 参与人员（不含创建人本人）的归一：去空白、统一小写、去重、保持提交顺序。
 *
 * 不做数量截断 —— 超限由 `validateDraftFields` 报错，静默丢弃会让用户以为「加上了」。
 * 创建人本人若混在数组里由调用方（service）剔除：纯函数不知道「我是谁」。
 */
function normalizeParticipantIds(value: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string")
      throw new AppError("VALIDATION_FAILED", "participantIds 含非字符串元素");
    const id = raw.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 建档请求是否完全空白（新建页的 `POST {}`）：空请求可以复用成员已有的空白草稿。 */
export function isBlankDraftFields(input: RepairDraftFields): boolean {
  const blank = (value: unknown) => value === undefined || value === null || value === "";
  return (
    blank(input.repairDate) &&
    blank(input.durationMinutes) &&
    blank(input.categoryId) &&
    blank(input.ownerName) &&
    blank(input.ownerPhone) &&
    blank(input.deviceModel) &&
    blank(input.content) &&
    blank(input.result) &&
    blank(input.remark) &&
    // 加了人就不再是「空白请求」：不能拿它去复用一条连人都没有的旧草稿。
    (input.participantIds?.length ?? 0) === 0
  );
}

export function validateDraftFields(input: RepairDraftFields): void {
  const errors: Record<string, string[]> = {};
  if (input.repairDate != null && !isDate(input.repairDate)) {
    errors.repairDate = ["维修日期格式无效"];
  } else if (input.repairDate) {
    // 日期范围在草稿阶段就拦：等到提交才报错，用户早就离开了这一页。
    if (input.repairDate < repairFieldLimits.repairDateMin)
      errors.repairDate = [`维修日期不得早于 ${repairFieldLimits.repairDateMin}`];
    else if (input.repairDate > shanghaiToday()) errors.repairDate = ["维修日期不能晚于今天"];
  }
  if (
    input.durationMinutes != null &&
    (!Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < repairFieldLimits.durationMinutesMin ||
      input.durationMinutes > repairFieldLimits.durationMinutesMax)
  )
    errors.durationMinutes = [
      `维修时长须为 ${repairFieldLimits.durationMinutesMin}–${repairFieldLimits.durationMinutesMax} 分钟的整数`,
    ];
  if (input.ownerName != null && input.ownerName.length > repairFieldLimits.ownerNameMaxLength)
    errors.ownerName = [`机主姓名不能超过 ${repairFieldLimits.ownerNameMaxLength} 字`];
  // 草稿允许为空（活动落单可能还没带出来自报名的机型）；填了就必须在上限内。
  if (
    input.deviceModel != null &&
    input.deviceModel.length > repairFieldLimits.deviceModelMaxLength
  )
    errors.deviceModel = [`机型不能超过 ${repairFieldLimits.deviceModelMaxLength} 字`];
  // 草稿允许不填电话（与日期 / 时长同思路）；填了就必须是合法的 11 位手机号。
  if (input.ownerPhone != null && !CN_MOBILE_PATTERN.test(input.ownerPhone))
    errors.ownerPhone = ["机主电话须为 11 位中国大陆手机号"];
  if (input.content != null && input.content.length > repairFieldLimits.contentMaxLength)
    errors.content = [`维修内容不能超过 ${repairFieldLimits.contentMaxLength} 字`];
  if (input.remark != null && input.remark.length > repairFieldLimits.remarkMaxLength)
    errors.remark = [`备注不能超过 ${repairFieldLimits.remarkMaxLength} 字`];
  if (input.result != null && !isRepairResult(input.result)) errors.result = ["维修结果无效"];
  // 参与人数上限（含创建人本人）：数组里只有额外成员，所以上限比总数少 1。
  if (
    input.participantIds != null &&
    input.participantIds.length > repairFieldLimits.participantMaxCount - 1
  )
    errors.participantIds = [
      `参与维修人员最多 ${repairFieldLimits.participantMaxCount} 人（含创建人本人）`,
    ];
  if (Object.keys(errors).length)
    throw new AppError("VALIDATION_FAILED", Object.values(errors).flat().join("；"), {
      fieldErrors: errors,
    });
}

export function validateSubmission(record: {
  repairDate: Date | null;
  durationMinutes: number | null;
  categoryId: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  deviceModel: string | null;
  content: string | null;
  result: string | null;
}): void {
  const errors: Record<string, string[]> = {};
  if (!record.repairDate) errors.repairDate = ["请填写维修日期"];
  else {
    const repairDate = formatShanghaiDate(record.repairDate);
    if (repairDate > shanghaiToday()) errors.repairDate = ["维修日期不能晚于今天"];
    else if (repairDate < repairFieldLimits.repairDateMin)
      errors.repairDate = [`维修日期不得早于 ${repairFieldLimits.repairDateMin}`];
  }
  // 维修时长提交必填：统计口径依赖它，缺了就只能「待补充」。
  if (record.durationMinutes == null) errors.durationMinutes = ["请填写维修时长"];
  else if (
    !Number.isInteger(record.durationMinutes) ||
    record.durationMinutes < repairFieldLimits.durationMinutesMin ||
    record.durationMinutes > repairFieldLimits.durationMinutesMax
  )
    errors.durationMinutes = [
      `维修时长须为 ${repairFieldLimits.durationMinutesMin}–${repairFieldLimits.durationMinutesMax} 分钟的整数`,
    ];
  if (!record.categoryId) errors.categoryId = ["请选择故障分类"];
  // 机主姓名 / 电话为提交必填：旧字段「维修内容」与照片不再是提交门槛。
  if (!record.ownerName) errors.ownerName = ["请填写机主姓名"];
  if (!record.ownerPhone) errors.ownerPhone = ["请填写机主电话"];
  else if (!CN_MOBILE_PATTERN.test(record.ownerPhone))
    errors.ownerPhone = ["机主电话须为 11 位中国大陆手机号"];
  // 机型为提交必填：历史记录不回填，只在提交审核（含退回后重提）时要求。
  if (!record.deviceModel) errors.deviceModel = ["请填写机型"];
  else if (record.deviceModel.length > repairFieldLimits.deviceModelMaxLength)
    errors.deviceModel = [`机型不能超过 ${repairFieldLimits.deviceModelMaxLength} 字`];
  // `content` 不再是提交必填（旧记录仍可能带着历史正文），但上限校验保留。
  if (record.content != null && record.content.length > repairFieldLimits.contentMaxLength)
    errors.content = [`维修内容不能超过 ${repairFieldLimits.contentMaxLength} 字`];
  if (!isRepairResult(record.result)) errors.result = ["维修结果缺失"];
  if (Object.keys(errors).length)
    throw new AppError("REPAIR_SUBMISSION_INCOMPLETE", Object.values(errors).flat().join("；"), {
      fieldErrors: errors,
    });
}

export function parseRepairDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!isDate(value)) throw new AppError("VALIDATION_FAILED", "维修日期格式无效");
  return new Date(`${value}T00:00:00.000Z`);
}

function clean(value: string | null): string | null {
  const result = value?.trim() ?? "";
  return result || null;
}
/** 电话按存储口径归一：剥掉空格 / 连字符等非数字字符，空串落 null（与 `normalizePhone` 一致）。 */
function cleanOwnerPhone(value: string | null): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits || null;
}
function isDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).valueOf())
  );
}
function isRepairResult(value: unknown): value is RepairResult {
  return value === "COMPLETED" || value === "NOT_COMPLETED";
}
function formatShanghaiDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
