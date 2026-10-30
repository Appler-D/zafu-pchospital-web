import { createHmac, timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/env";

/**
 * 本设备的报名凭证（issue #304）：报名成功后下发签名 cookie，
 * 用来在**服务端**拒绝同一设备的第二次填写，并在刷新后显示「已提交」面板。
 *
 * 只是"同一设备不重复填"的产品约束，不是身份凭证：
 * 清 cookie / 无痕 / 换浏览器都可绕过，真正的兜底是 (活动, 手机号) 唯一与限流。
 * 因此 payload 只放 ID 与过期时间，不放姓名、电话等 PII。
 */

const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 设备凭证的最长存活时间；实际下发时还会被活动结束时间收紧。 */
export const REGISTRATION_DEVICE_TTL_MS = DEVICE_TOKEN_TTL_MS;
const COOKIE_PREFIX = "ra_reg_";

type DeviceTokenPayload = {
  activityId: string;
  registrationId: string;
  exp: number;
};

export function registrationDeviceCookieName(activityId: string): string {
  return `${COOKIE_PREFIX}${activityId}`;
}

export function registrationDeviceCookieOptions(expiresAt: Date, now = new Date()) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    // 设备状态接口在 /api/v1 下，cookie 不能只挂 /repair-activities。
    path: "/",
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
    expires: expiresAt,
  };
}

/** 从 Cookie 头里取本设备的报名凭证；没有就返回空串。 */
export function readRegistrationDeviceCookie(header: string | null, activityId: string): string {
  if (!header) return "";
  const name = `${registrationDeviceCookieName(activityId)}=`;
  return (
    header
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(name))
      ?.slice(name.length) ?? ""
  );
}

/**
 * `expiresAt` 是活动自然日结束时间：凭证最晚到活动结束（仍受 30 天上限约束）。
 * 活动结束后再提交本来也会被 ACTIVITY_ENDED 拦下，收紧只是让 cookie 不白白多活。
 */
export function issueRegistrationDeviceToken(
  activityId: string,
  registrationId: string,
  now = new Date(),
  expiresAt?: Date,
): string {
  const payload: DeviceTokenPayload = {
    activityId,
    registrationId,
    exp: Math.min(
      now.getTime() + DEVICE_TOKEN_TTL_MS,
      expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
    ),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * 校验并解出 registrationId。签名不符、过期、活动不匹配一律返回 null ——
 * 对调用方来说等价于"没有这张凭证"，不能把 403 暴露给报名者。
 */
export function readRegistrationDeviceToken(
  token: string,
  expected: { activityId: string },
  now = new Date(),
): { registrationId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: DeviceTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DeviceTokenPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.activityId !== "string" ||
    typeof payload.registrationId !== "string" ||
    typeof payload.exp !== "number" ||
    payload.activityId !== expected.activityId ||
    now.getTime() > payload.exp
  ) {
    return null;
  }
  return { registrationId: payload.registrationId };
}

function sign(body: string): string {
  return createHmac("sha256", getServerEnv().AUTH_SECRET).update(body).digest("base64url");
}
