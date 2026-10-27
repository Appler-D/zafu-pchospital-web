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
 * 账号发放的初始密码规则：**QQ 号后 6 位**，不足 6 位的老号取整串（5 位）。
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

/* ------------------------------------------------- 邮箱 */

/**
 * 邮箱规范化：整个系统里**唯一**的邮箱比较与存储口径。
 *
 * 规则（任务书 §3.1，产品口径）：
 * 1. 先 trim 并拒绝非 ASCII 输入 —— 顺序很关键：先查 ASCII 再转小写，
 *    否则某些 Unicode 字符经小写映射会「洗白」成合法字符（本地部分出现
 *    Unicode 小写变体），把原本不支持的输入变成可接受输入；
 * 2. 整个地址统一转小写（本产品的账号比较规则，不区分大小写）；
 * 3. local-part 为 dot-atom：允许的字符集取自 RFC 5321，最长 64 字符，
 *    不以点开头 / 结尾、不含连续点；**保留 `+tag` 与 local-part 中的点**
 *    （不做 Gmail 式去点、去加号、别名归并 —— 归并会造成不同用户邮箱互相撞键）；
 * 4. 域名是合法 DNS 标签（字母数字与连字符、不以连字符开头 / 结尾）且含域名分隔点；
 * 5. 整个规范化地址最长 {@link EMAIL_MAX_LENGTH} 字符，与身份列宽度一致。
 *
 * 拒绝：内部空白、控制字符、显示名 / 多地址（超过一个 `@`）、带引号的 local-part、
 * 域字面量（`[127.0.0.1]`）与 Unicode 邮箱；本期不做 SMTPUTF8 / 国际化邮箱支持，
 * 也不做 DNS / MX 查询（那是投递环节的事，不是表单校验）。
 */
export const EMAIL_MAX_LENGTH = 191;
export const EMAIL_LOCAL_MAX_LENGTH = 64;

const EMAIL_LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const ASCII_PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** 规范化失败时统一的 fieldErrors（返回 `null`，由调用方决定抛错文案）。 */
function tryNormalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ASCII_PRINTABLE_NO_SPACE.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  if (lower.length > EMAIL_MAX_LENGTH) return null;
  const at = lower.indexOf("@");
  if (at <= 0 || at !== lower.lastIndexOf("@")) return null;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (local.length > EMAIL_LOCAL_MAX_LENGTH) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!local.split(".").every((atom) => EMAIL_LOCAL_ATOM.test(atom))) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => label.length <= 63 && DNS_LABEL.test(label))) return null;
  return lower;
}

/** 校验并规范化邮箱；参数取 `unknown`：HTTP 边界上非字符串值必须拒绝而不是转换。 */
export function normalizeEmail(value: unknown): string {
  const normalized = tryNormalizeEmail(value);
  if (normalized === null) {
    throw new AppError("VALIDATION_FAILED", "邮箱格式不正确", {
      fieldErrors: { email: ["请输入有效的邮箱地址（仅支持普通 ASCII 邮箱）"] },
    });
  }
  return normalized;
}

/* ------------------------------------------------- 学号 / 班级 */

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

/* ------------------------------------------------- 姓名 */

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
