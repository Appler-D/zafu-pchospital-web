import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { getServerEnv } from "@/lib/env";
import { isPasswordLengthValid, passwordLengthMessage } from "@/lib/security/password-policy";
import { normalizeInviteCode } from "@/lib/security/normalization";

const scrypt = promisify(scryptCallback);

export function generateInviteCode(): string {
  return randomBytes(16).toString("hex").toUpperCase();
}

export function digestInviteCode(code: string): Uint8Array<ArrayBuffer> {
  const digest = createHmac("sha256", getServerEnv().INVITE_CODE_PEPPER)
    .update(normalizeInviteCode(code))
    .digest();
  return new Uint8Array(
    digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength),
  );
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestSessionToken(token: string): Uint8Array<ArrayBuffer> {
  return digestSecret(token, getServerEnv().AUTH_SECRET);
}

export function digestLoginThrottleKey(qq: string, ipAddress: string): Uint8Array<ArrayBuffer> {
  return digestSecret(`${qq}:${ipAddress}`, getServerEnv().PII_AUDIT_PEPPER);
}

/**
 * 账号维度节流键：`login_throttles` 的独立命名空间。
 *
 * 前缀 `account:` 与登录键的 `qq:ip` 形式天然不撞键，且互相删除时按 key 精确匹配，
 * 不会把对方清掉 —— 6 位临时密码防换 IP 猜解靠这条键，普通登录的清除不能误伤它。
 */
export function digestAccountThrottleKey(userId: string): Uint8Array<ArrayBuffer> {
  return digestSecret(`account:${userId}`, getServerEnv().PII_AUDIT_PEPPER);
}

function digestSecret(value: string, secret: string): Uint8Array<ArrayBuffer> {
  const digest = createHmac("sha256", secret).update(value).digest();
  return new Uint8Array(
    digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength),
  );
}

export async function hashPassword(password: string): Promise<string> {
  // 长度策略只有一个来源（`password-policy.ts`）：表单、服务端校验、这里三处必须一致。
  if (!isPasswordLengthValid(password)) {
    throw new Error(passwordLengthMessage());
  }
  return hashPasswordCore(password);
}

/**
 * 口令由**系统按规则生成**（初始密码 = QQ 后 6 位，5 位老号就是 5 位）时用这个：
 * 它不套用表单的长度策略 —— 那条规则管的是「用户自己设置口令」，而 5 位的老 QQ 号
 * 生成出来只有 5 位，套上去会直接抛错、账号发不出去。登录只校验密码本身，
 * 首次登录强制改密后用户自己设的口令仍受策略约束。
 */
export async function hashGeneratedPassword(password: string): Promise<string> {
  return hashPasswordCore(password);
}

async function hashPasswordCore(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, saltText, hashText] = stored.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = (await scrypt(
    password,
    Buffer.from(saltText, "base64url"),
    expected.length,
  )) as Buffer;
  return timingSafeEqual(expected, actual);
}
