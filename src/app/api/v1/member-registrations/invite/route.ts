import { authService } from "@/features/auth/auth-service";
import { inviteCodeService } from "@/features/invitations/invite-code-service";
import { AppError } from "@/lib/api/errors";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { resolveAccountAccess } from "@/lib/auth/account-access";
import { assertSameOrigin, requestContext, sessionCookie } from "@/lib/auth/request";
import { normalizeClassName, normalizeStudentId } from "@/lib/security/normalization";
import type { InviteRegistrationResponse } from "@/types/contracts";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as Record<string, unknown>;
    const context = requestContext(request, requestId);
    enforceRateLimit(`invite-registration:${context.ipAddress ?? "unknown"}`, 10, 15 * 60_000);
    if (String(body.password ?? "") !== String(body.passwordConfirmation ?? "")) {
      throw new AppError("PASSWORD_CONFIRMATION_MISMATCH", "两次输入的密码不一致");
    }
    const input = {
      code: String(body.code ?? ""),
      idempotencyKey: String(body.idempotencyKey ?? ""),
      realName: String(body.realName ?? ""),
      qq: String(body.qq ?? ""),
      phone: String(body.phone ?? ""),
      // 学号 / 班级必填：非字符串值在这里直接按字段错误拒绝，不做 String() 强转。
      studentId: normalizeStudentId(body.studentId),
      className: normalizeClassName(body.className),
      password: String(body.password ?? ""),
    };
    const registration = await inviteCodeService.redeem(input, context);
    const login = await authService.login({ qq: input.qq, password: input.password }, context);
    // 注册不新增邮箱字段：先完成注册与建会话，再由服务端统一状态决定下一步
    // （开启门禁且尚未验证邮箱时进邮箱步骤，否则进角色默认页）。
    // `returnTo` 与登录接口同源：只作候选，由 `resolveAccountAccess` 按白名单 + 当次角色校验。
    const accountAccess = await resolveAccountAccess({
      principal: login,
      returnTo: typeof body.returnTo === "string" ? body.returnTo : undefined,
    });
    const data: InviteRegistrationResponse = {
      ...registration,
      accountAccess,
      destination: accountAccess.destination,
    };
    const response = apiSuccess(data, requestId, { status: 201 });
    response.cookies.set(sessionCookie(login.token, login.expiresAt));
    return response;
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
