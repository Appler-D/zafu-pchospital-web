import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/env";
import { EMAIL_CODE_LENGTH } from "@/lib/security/email-policy";

/**
 * 邮箱验证码与重置授权的密码学原语。
 * 集中参数（有效期 / 限流窗口 / 预算）在 `email-policy.ts`；本文件只放生成与摘要。
 */

/* ------------------------------------------------------------ 验证码生成 */

/**
 * 生成 6 位安全随机数字，保留前导零（`042917` 也是合法验证码）。
 * 注入 `random` 只为单测覆盖前导零与边界，生产必须走默认的 `randomInt`。
 */
export function generateEmailCode(random: (maxExclusive: number) => number = randomInt): string {
  return String(random(1_000_000)).padStart(EMAIL_CODE_LENGTH, "0");
}

/* ------------------------------------------------------------- 摘要函数 */

function hmacSha256(pepper: string, value: string): Uint8Array<ArrayBuffer> {
  const digest = createHmac("sha256", pepper).update(value).digest();
  return new Uint8Array(
    digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength),
  );
}

/**
 * 验证码摘要：`HMAC(EMAIL_CODE_PEPPER, 挑战ID:用户:用途:规范化邮箱:验证码)`。
 *
 * 上下文绑定是安全设计的一部分（任务书 §4.1）：摘要不能跨挑战、跨用户、跨用途、
 * 跨目标邮箱复用 —— 只拿到一行摘要也无法把它「搬」到另一条挑战上比对。
 * 独立密钥（`EMAIL_CODE_PEPPER`）与其它 pepper 分离：6 位数字空间小，
 * 摘要必须靠专用密钥外加限流与阻断才扛得住离线比对。
 */
export function digestEmailCode(input: {
  challengeId: string;
  userId: string;
  purpose: string;
  emailNormalized: string;
  code: string;
}): Uint8Array<ArrayBuffer> {
  const material = [
    input.challengeId,
    input.userId,
    input.purpose,
    input.emailNormalized,
    input.code,
  ].join(":");
  return hmacSha256(getServerEnv().EMAIL_CODE_PEPPER, material);
}

/** 恒定时间比较摘要（长度不同直接 false，不泄漏前缀信息）。 */
export function emailCodeDigestMatches(expected: Uint8Array, actual: Uint8Array): boolean {
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 32 字节安全随机重置令牌，明文只在成功签发时返回内部调用方。 */
export function generatePasswordResetToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 重置令牌摘要：授权表只存摘要（`password-reset:` 命名空间与验证码摘要区分开）。
 * 复用 `EMAIL_CODE_PEPPER`：同一个独立密钥同时保护验证码与重置令牌，
 * 两者都是「只经邮件送达的一次性凭据」。
 */
export function digestPasswordResetToken(token: string): Uint8Array<ArrayBuffer> {
  return hmacSha256(getServerEnv().EMAIL_CODE_PEPPER, `password-reset:${token}`);
}

/**
 * 计数 / 预算桶的不可逆键摘要（`email:` 命名空间，复用 PII_AUDIT_PEPPER，
 * 与登录节流同一处理）。明文键只用于构造摘要，不落库。
 */
export function digestEmailBucketKey(key: string): Uint8Array<ArrayBuffer> {
  return hmacSha256(getServerEnv().PII_AUDIT_PEPPER, `email:${key}`);
}
