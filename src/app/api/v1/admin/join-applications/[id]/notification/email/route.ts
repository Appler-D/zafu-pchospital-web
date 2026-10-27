import { joinApplicationService } from "@/features/recruitment/join-application-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";
import { requirePermission } from "@/lib/auth/permissions";
export const runtime = "nodejs";
/**
 * 更正报名通知邮箱。
 *
 * 只改「发通知用的地址」，不触碰账号邮箱（账号侧走登录后的验证绑定）。
 * 状态规则在 Service 里：发送中 409；已交发信服务 / 结果未知只更新报名记录。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const { actor } = await authenticateRequest(request, requestId);
    requirePermission(actor, "join:review");
    const body = (await request.json()) as Record<string, unknown>;
    const result = await joinApplicationService.correctNotificationEmail(
      (await params).id,
      { email: typeof body.email === "string" ? body.email : "" },
      actor,
    );
    return apiSuccess(result, requestId, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
