import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { authenticateRequest } from "@/lib/auth/request";
import type { AccountMeView } from "@/types/contracts";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const requestId = getRequestId(request.headers);
  try {
    // 用途固定为 session-self：邮箱 / 改密受限的有效会话仍然返回 200 与真实 Session，
    // 由 accountAccess 告诉前端下一步 —— 不能把它报成 401「登录过期」。
    // `returnTo` 是跟随器交上来的**候选**原目标（当前业务页或步骤链条里的目标），
    // 服务端按白名单与当前角色重判；不传、非法或无权时落点回角色默认页。
    const { principal, accountAccess } = await authenticateRequest(
      request,
      requestId,
      "session-self",
      new URL(request.url).searchParams.get("returnTo"),
    );
    const data: AccountMeView = { ...principal, accountAccess };
    // 只读复查不能回写旧令牌，否则迟到响应会覆盖登录 / 改密刚轮换的 Cookie。
    return apiSuccess(data, requestId, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
