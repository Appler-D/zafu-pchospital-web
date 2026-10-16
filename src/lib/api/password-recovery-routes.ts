import { passwordRecoveryService } from "@/features/email/password-recovery-service";
import { AppError } from "@/lib/api/errors";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, requestContext, sessionCookie } from "@/lib/auth/request";
import { PASSWORD_MAX_LENGTH } from "@/lib/security/password-policy";
import type {
  PasswordRecoveryServiceContract,
  PasswordRecoveryVerifyResult,
} from "@/types/contracts";

export const PASSWORD_RESET_COOKIE_NAME = "pc_hospital_password_reset";
const PATH = "/api/v1/auth/password-reset";
const PRIVATE = { "Cache-Control": "private, no-store" };
export function passwordResetCookie(token: string, expiresAt: string) {
  return {
    name: PASSWORD_RESET_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: PATH,
    expires: new Date(expiresAt),
  };
}
function readResetCookie(request: Request) {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${PASSWORD_RESET_COOKIE_NAME}=`))
      ?.slice(PASSWORD_RESET_COOKIE_NAME.length + 1) ?? ""
  );
}
function bodyObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new AppError("VALIDATION_FAILED", "请求字段无效");
  return value as Record<string, unknown>;
}
function field(body: Record<string, unknown>, name: string, max: number) {
  const value = body[name];
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new AppError("VALIDATION_FAILED", "请求字段类型或长度无效");
  return value;
}
export async function passwordRecoveryRoute(
  request: Request,
  action: "request" | "verify" | "confirm",
  service: PasswordRecoveryServiceContract = passwordRecoveryService,
) {
  const requestId = getRequestId(request.headers);
  let sameOrigin = false;
  let response;
  try {
    assertSameOrigin(request);
    sameOrigin = true;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("VALIDATION_FAILED", "请求格式无效");
    }
    const context = requestContext(request, requestId);
    if (action === "request") {
      const b = bodyObject(body, ["qq"]);
      response = apiSuccess(await service.request({ qq: field(b, "qq", 32) }, context), requestId, {
        headers: PRIVATE,
      });
    } else if (action === "verify") {
      const b = bodyObject(body, ["challengeId", "code"]);
      const challengeId = field(b, "challengeId", 36),
        code = field(b, "code", 6);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challengeId) ||
        !/^\d{6}$/.test(code)
      )
        throw new AppError("VALIDATION_FAILED", "请输入有效验证码");
      const authorized = await service.verify({ challengeId, code }, context);
      response = apiSuccess<PasswordRecoveryVerifyResult>(
        { authorized: true, expiresAt: authorized.expiresAt },
        requestId,
        {
          headers: PRIVATE,
        },
      );
      response.cookies.set(passwordResetCookie(authorized.token, authorized.expiresAt));
    } else {
      const b = bodyObject(body, ["newPassword", "newPasswordConfirmation"]);
      const result = await service.confirm(
        readResetCookie(request),
        {
          newPassword: field(b, "newPassword", PASSWORD_MAX_LENGTH),
          newPasswordConfirmation: field(b, "newPasswordConfirmation", PASSWORD_MAX_LENGTH),
        },
        context,
      );
      response = apiSuccess(result, requestId, { headers: PRIVATE });
      response.cookies.set({ ...passwordResetCookie("", new Date(0).toISOString()), maxAge: 0 });
      response.cookies.set({ ...sessionCookie("", new Date(0).toISOString()), maxAge: 0 });
    }
  } catch (error) {
    response = apiFailure(error, requestId);
    if (
      sameOrigin &&
      action === "confirm" &&
      error instanceof AppError &&
      error.code === "EMAIL_RESET_AUTHORIZATION_INVALID"
    )
      response.cookies.set({ ...passwordResetCookie("", new Date(0).toISOString()), maxAge: 0 });
  }
  if (sameOrigin && (action === "request" || (action === "verify" && response.status !== 200)))
    response.cookies.set({ ...passwordResetCookie("", new Date(0).toISOString()), maxAge: 0 });
  return response;
}
