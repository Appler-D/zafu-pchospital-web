import { AppError } from "@/lib/api/errors";
import { parseAcademicTermConfig } from "@/lib/academic-term";
import { EMAIL_BUDGET_DAILY_DEFAULT } from "@/lib/security/email-policy";

const REQUIRED_SERVER_ENV = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "INVITE_CODE_PEPPER",
  "PII_AUDIT_PEPPER",
] as const;

export type ServerEnv = Record<(typeof REQUIRED_SERVER_ENV)[number], string> & {
  APP_BASE_URL: string;
  /** 学期口径原始值。空串表示未配置；非法配置在下方校验阶段直接抛错。 */
  ACADEMIC_TERM_START: string;
  ACADEMIC_TERM_END: string;
  /** 邮件功能总开关（issue #146），默认 false：未启用不影响应用启动。 */
  MAIL_ENABLED: boolean;
  /**
   * 以下 SMTP_* / MAIL_FROM / EMAIL_CODE_PEPPER / EMAIL_DAILY_BUDGET 保留原始值：
   * 只在邮件启用并实际需要发信时解析 / 校验（issue #146 返修 F4）—— 关闭邮件时
   * 非法取值不得影响全站配置读取（本函数同时服务于 DB / 认证等公共路径）。
   */
  EMAIL_DAILY_BUDGET: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  MAIL_FROM: string;
  EMAIL_CODE_PEPPER: string;
};

/**
 * 邮件传输配置（issue #146 §5.1）。
 *
 * `enabled: false` 时其余字段一概不要求 —— 构建 / 本地开发 / 未启用邮件的环境
 * 不需要任何真实 SMTP 凭据，应用照常启动；邮件操作在服务层被明确拒绝
 * （`EMAIL_NOT_ENABLED`），不伪装发送成功。
 */
export type MailConfig =
  | { enabled: false }
  | {
      enabled: true;
      smtpHost: string;
      smtpPort: number;
      smtpUser: string;
      smtpPassword: string;
      mailFrom: string;
      codePepper: string;
      dailyBudget: number;
    };

function parsePositiveInteger(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) {
    throw new AppError("INTERNAL_ERROR", `${name} 必须是正整数，当前值无法解析`, { status: 500 });
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError("INTERNAL_ERROR", `${name} 必须是正整数`, { status: 500 });
  }
  return value;
}

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const missing = REQUIRED_SERVER_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new AppError("INTERNAL_ERROR", `缺少服务端环境变量：${missing.join(", ")}`, {
      status: 500,
    });
  }

  // 学期口径启动校验：两项皆空合法；只配一项 / 格式非法 / 区间倒置直接失败。
  const academicTermStart = process.env.ACADEMIC_TERM_START ?? "";
  const academicTermEnd = process.env.ACADEMIC_TERM_END ?? "";
  const termParse = parseAcademicTermConfig(academicTermStart, academicTermEnd);
  if (!termParse.ok) {
    throw new AppError("ACADEMIC_TERM_CONFIG_INVALID", `学期配置无效：${termParse.message}`);
  }

  cached = {
    DATABASE_URL: process.env.DATABASE_URL!,
    AUTH_SECRET: process.env.AUTH_SECRET!,
    INVITE_CODE_PEPPER: process.env.INVITE_CODE_PEPPER!,
    PII_AUDIT_PEPPER: process.env.PII_AUDIT_PEPPER!,
    APP_BASE_URL: process.env.APP_BASE_URL ?? "http://localhost:3000",
    ACADEMIC_TERM_START: academicTermStart.trim(),
    ACADEMIC_TERM_END: academicTermEnd.trim(),
    MAIL_ENABLED: process.env.MAIL_ENABLED === "true",
    EMAIL_DAILY_BUDGET: process.env.EMAIL_DAILY_BUDGET?.trim() ?? "",
    SMTP_HOST: process.env.SMTP_HOST?.trim() ?? "",
    SMTP_PORT: process.env.SMTP_PORT?.trim() ?? "",
    SMTP_USER: process.env.SMTP_USER?.trim() ?? "",
    SMTP_PASSWORD: process.env.SMTP_PASSWORD ?? "",
    MAIL_FROM: process.env.MAIL_FROM?.trim() ?? "",
    EMAIL_CODE_PEPPER: process.env.EMAIL_CODE_PEPPER ?? "",
  };
  return cached;
}

/** 只读取「邮件是否启用」，不校验 SMTP 细节（用给「未启用时拒绝」这一层）。 */
export function isMailEnabled(): boolean {
  return getServerEnv().MAIL_ENABLED;
}

/**
 * 组装邮件传输配置。启用时校验必需项齐全（缺一个就拒绝，不做半配置运行），
 * 端口不在 1–65535 直接失败；**关闭时直接返回 `{ enabled: false }`，不解析
 * 邮件专用取值**（issue #146 返修 F4）。校验在**首次需要发信时**发生，
 * 不影响其它功能启动。
 */
export function getMailConfig(): MailConfig {
  const env = getServerEnv();
  if (!env.MAIL_ENABLED) return { enabled: false };
  const required: Array<[string, string]> = [
    ["SMTP_HOST", env.SMTP_HOST],
    ["SMTP_USER", env.SMTP_USER],
    ["SMTP_PASSWORD", env.SMTP_PASSWORD],
    ["MAIL_FROM", env.MAIL_FROM],
    ["EMAIL_CODE_PEPPER", env.EMAIL_CODE_PEPPER],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      `MAIL_ENABLED=true 但邮件配置不完整：缺少 ${missing.join(", ")}`,
      { status: 500 },
    );
  }
  const smtpPort = parsePositiveInteger("SMTP_PORT", env.SMTP_PORT) ?? 465;
  if (smtpPort < 1 || smtpPort > 65535) {
    throw new AppError("INTERNAL_ERROR", "SMTP_PORT 必须在 1–65535 之间", { status: 500 });
  }
  const dailyBudget =
    parsePositiveInteger("EMAIL_DAILY_BUDGET", env.EMAIL_DAILY_BUDGET) ??
    EMAIL_BUDGET_DAILY_DEFAULT;
  return {
    enabled: true,
    smtpHost: env.SMTP_HOST,
    smtpPort,
    smtpUser: env.SMTP_USER,
    smtpPassword: env.SMTP_PASSWORD,
    mailFrom: env.MAIL_FROM,
    codePepper: env.EMAIL_CODE_PEPPER,
    dailyBudget,
  };
}

export function resetServerEnvForTests(): void {
  cached = undefined;
}
