import { memberService } from "@/features/members/member-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";

export const runtime = "nodejs";

/** 响应携带一次性明文临时密码：禁止任何共享缓存。 */
const PRIVATE = { "Cache-Control": "private, no-store" } as const;

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    // 恢复工具入口之一：只豁免邮箱门禁（任务 6 §6），自重置禁止与目标资格仍由 Service 拦。
    const { actor } = await authenticateRequest(request, requestId, "account-recovery");
    return apiSuccess(
      await memberService.resetAccountPassword((await params).userId, actor),
      requestId,
      { headers: PRIVATE },
    );
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
