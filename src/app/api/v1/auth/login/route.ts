import { authService } from "@/features/auth/auth-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { AppError } from "@/lib/api/errors";
import { resolveAccountAccess } from "@/lib/auth/account-access";
import { assertSameOrigin, requestContext, sessionCookie } from "@/lib/auth/request";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.rememberMe !== undefined && typeof body.rememberMe !== "boolean")
      throw new AppError("VALIDATION_FAILED", "rememberMe 必须为布尔值");
    const result = await authService.login(
      {
        qq: String(body.qq ?? ""),
        password: String(body.password ?? ""),
        rememberMe: body.rememberMe,
      },
      requestContext(request, requestId),
    );
    // 落点由服务端按**当次**状态给出（改密 → 邮箱 → 原目标 / 角色默认页），
    // 前端不再按角色自行跳转；`returnTo` 只作候选，非法或无权目标回默认页。
    const accountAccess = await resolveAccountAccess({
      principal: result,
      returnTo: typeof body.returnTo === "string" ? body.returnTo : undefined,
    });
    const response = apiSuccess(
      {
        userId: result.userId,
        displayName: result.displayName,
        roles: result.roles,
        permissions: result.permissions,
        mustChangePassword: result.mustChangePassword,
        expiresAt: result.expiresAt,
        accountAccess,
        destination: accountAccess.destination,
      },
      requestId,
    );
    response.cookies.set(sessionCookie(result.token, result.expiresAt));
    return response;
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
