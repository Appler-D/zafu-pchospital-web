import { authService } from "@/features/auth/auth-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { loginDestination } from "@/lib/auth/login-destination";
import {
  assertSameOrigin,
  readSessionToken,
  requestContext,
  sessionCookie,
} from "@/lib/auth/request";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as Record<string, unknown>;
    const result = await authService.changePassword(
      readSessionToken(request),
      {
        currentPassword: String(body.currentPassword ?? ""),
        newPassword: String(body.newPassword ?? ""),
        newPasswordConfirmation: String(body.newPasswordConfirmation ?? ""),
      },
      requestContext(request, requestId),
    );
    const response = apiSuccess(
      {
        changed: true,
        mustChangePassword: false,
        // 改密后的落点复用登录页同一份规则（issue #113 返修）：恢复流程完成后，
        // 「只当管理员、没有成员档案」的账号必须回 /admin，而不是被固定推去 /member。
        destination: loginDestination(result),
      },
      requestId,
    );
    response.cookies.set(sessionCookie(result.token, result.expiresAt));
    return response;
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
