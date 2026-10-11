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
    content: input.content === undefined ? undefined : clean(input.content),
    result: input.result,
    remark: input.remark === undefined ? undefined : clean(input.remark),
  };
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
    blank(input.content) &&
    blank(input.result) &&
    blank(input.remark)
  );
}

export function validateDraftFields(input: RepairDraftFields): void {
  const errors: Record<string, string[]> = {};
  if (input.repairDate != null && !isDate(input.repairDate)) {
    errors.repairDate = ["维修日期格式无效"];
  } else if (input.repairDate) {
    // 日期范围在草稿阶段就拦：等到提交才报错，用户早就离开了这一页（issue #62 后端3）。
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
  // 草稿允许不填电话（与日期 / 时长同思路）；填了就必须是合法的 11 位手机号。
  if (input.ownerPhone != null && !CN_MOBILE_PATTERN.test(input.ownerPhone))
    errors.ownerPhone = ["机主电话须为 11 位中国大陆手机号"];
  if (input.content != null && input.content.length > repairFieldLimits.contentMaxLength)
    errors.content = [`维修内容不能超过 ${repairFieldLimits.contentMaxLength} 字`];
  if (input.remark != null && input.remark.length > repairFieldLimits.remarkMaxLength)
    errors.remark = [`备注不能超过 ${repairFieldLimits.remarkMaxLength} 字`];
  if (input.result != null && !isRepairResult(input.result)) errors.result = ["维修结果无效"];
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
  // 维修时长提交必填（issue #72）：统计口径依赖它，缺了就只能「待补充」。
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
  // 机主姓名 / 电话改为提交必填（issue #79 第 6 项）：旧字段「维修内容」与照片不再是提交门槛。
  if (!record.ownerName) errors.ownerName = ["请填写机主姓名"];
  if (!record.ownerPhone) errors.ownerPhone = ["请填写机主电话"];
  else if (!CN_MOBILE_PATTERN.test(record.ownerPhone))
    errors.ownerPhone = ["机主电话须为 11 位中国大陆手机号"];
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
