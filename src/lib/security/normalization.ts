import { AppError } from "@/lib/api/errors";

export function normalizeQq(value: string): string {
  const normalized = value.replace(/\D/g, "");
  if (!/^\d{5,11}$/.test(normalized)) {
    throw new AppError("VALIDATION_FAILED", "QQ 号格式不正确", {
      fieldErrors: { qq: ["请输入 5–11 位数字"] },
    });
  }
  return normalized;
}

/**
 * 大陆手机号规则（剔除非数字后的 11 位）。
 *
 * 维修记录的机主电话（`ownerPhone`）复用这一份正则：两边各写一份，
 * 迟早会出现「报名能填、记录不能填」这类只在一侧生效的格式漂移。
 */
export const CN_MOBILE_PATTERN = /^1[3-9]\d{9}$/;

export function normalizePhone(value: string): string {
  const normalized = value.replace(/\D/g, "");
  if (!CN_MOBILE_PATTERN.test(normalized)) {
    throw new AppError("VALIDATION_FAILED", "手机号格式不正确", {
      fieldErrors: { phone: ["请输入 11 位中国大陆手机号"] },
    });
  }
  return normalized;
}

/**
 * 账号发放的初始密码规则（issue #93）：**QQ 号后 6 位**，不足 6 位的老号取整串（5 位）。
 *
 * 规则公开、可由 QQ 号推算 —— 这是刻意换来的「管理员不用转达随机口令」，
 * 安全上的补偿是首次登录强制改密（`setInitialPassword` 写 `mustChangePassword: true`）
 * 与登录节流（同 QQ + IP 15 分钟失败 5 次锁定）。
 */
export function initialPasswordFromQq(qq: string): string {
  const normalized = qq.replace(/\D/g, "");
  return normalized.length > 6 ? normalized.slice(-6) : normalized;
}

export function normalizeInviteCode(value: string): string {
  const normalized = value.trim().replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{16,64}$/.test(normalized)) {
    throw new AppError("INVITE_CODE_INVALID", "邀请码无效");
  }
  return normalized;
}

/* ------------------------------------------------- 学号 / 班级（issue #147） */

/**
 * 学号与班级的共同约束来源：邀请码注册、公开招募两个入口的表单、HTTP 边界与
 * Feature Service 都取这里的常量与函数，不在各处各写一份。
 *
 * 学号只是**自由字符串**：trim 后 1–32 字符，保留前导零，不要求纯数字、不要求固定长度，
 * 也不做唯一性校验（学号不是身份，不进 `user_identities`；同号不同人是合法情况）。
 * 班级同理，仅约定 1–80 字符，不引入命名规则。上限与 `member_profiles` /
 * `join_applications` 的列宽（`VarChar(32)` / `VarChar(80)`）对齐。
 */
export const STUDENT_ID_MAX_LENGTH = 32;
export const CLASS_NAME_MAX_LENGTH = 80;
export const STUDENT_ID_LENGTH_MESSAGE = `学号长度应为 1–${STUDENT_ID_MAX_LENGTH} 个字符`;
export const CLASS_NAME_LENGTH_MESSAGE = `班级长度应为 1–${CLASS_NAME_MAX_LENGTH} 个字符`;

/**
 * 「必填自由文本」的通用校验：只接受字符串 —— 对象 / 数字**不做强制转换**，
 * 一律视为不合格，避免 `String({})` 这类强转把垃圾值变成合法输入。
 * trim 后长度须在 1–`maxLength`，合格返回规范化值，否则返回 `null`。
 *
 * 不直接抛错是为了让调用方能二选一：单字段入口（邀请码注册）抛自己的 fieldError；
 * 聚合入口（公开招募的 `validateSubmission`）收集进同一个 `fieldErrors` 一起报。
 */
export function trimRequiredTextField(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) return null;
  return normalized;
}

/** 校验并规范化学号；参数取 `unknown`：HTTP 边界上非字符串值必须拒绝而不是转换。 */
export function normalizeStudentId(value: unknown): string {
  const normalized = trimRequiredTextField(value, STUDENT_ID_MAX_LENGTH);
  if (normalized === null) {
    throw new AppError("VALIDATION_FAILED", "学号格式不正确", {
      fieldErrors: { studentId: [STUDENT_ID_LENGTH_MESSAGE] },
    });
  }
  return normalized;
}

/** 校验并规范化班级；与 {@link normalizeStudentId} 同一语义。 */
export function normalizeClassName(value: unknown): string {
  const normalized = trimRequiredTextField(value, CLASS_NAME_MAX_LENGTH);
  if (normalized === null) {
    throw new AppError("VALIDATION_FAILED", "班级格式不正确", {
      fieldErrors: { className: [CLASS_NAME_LENGTH_MESSAGE] },
    });
  }
  return normalized;
}

/* ------------------------------------------------- 姓名（issue #147 返修） */

/**
 * 姓名约束（邀请码注册与公开招募共用）：**只去首尾空白**，trim 后 2–64 字符，
 * 内部字符与空格原样保留 —— 不引入「只能中文 / 不能有空格」等格式规则。
 * 与成员建档（`member_profiles.real_name`）的 2–64 口径一致。
 */
export const PERSON_NAME_MIN_LENGTH = 2;
export const PERSON_NAME_MAX_LENGTH = 64;
export const PERSON_NAME_LENGTH_MESSAGE = `姓名长度应为 ${PERSON_NAME_MIN_LENGTH}–${PERSON_NAME_MAX_LENGTH} 个字符`;

/**
 * 姓名规范化：trim 后长度须在 `PERSON_NAME_MIN_LENGTH`–`PERSON_NAME_MAX_LENGTH`，
 * 合格返回规范化值，否则返回 `null`。与 {@link trimRequiredTextField} 同一形状，
 * 差别只在最小长度；`trim` 天然保证内部空格不被改动。
 */
export function trimPersonName(value: string): string | null {
  const normalized = value.trim();
  if (normalized.length < PERSON_NAME_MIN_LENGTH || normalized.length > PERSON_NAME_MAX_LENGTH) {
    return null;
  }
  return normalized;
}
