import { authService } from "@/features/auth/auth-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { resolveAccountAccess } from "@/lib/auth/account-access";
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
    // 改密后的下一步与登录 / 邮箱确认同一编排：
    // 「只当管理员、没有成员档案」的账号回 /admin；开启门禁且尚未验证邮箱的账号
    // 回邮箱步骤，`returnTo` 沿链条继续传递并由服务端按当前角色复查。
    const accountAccess = await resolveAccountAccess({
      principal: result,
      returnTo: typeof body.returnTo === "string" ? body.returnTo : undefined,
    });
    const response = apiSuccess(
      {
        changed: true,
        mustChangePassword: false,
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
