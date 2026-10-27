import { memberService } from "@/features/members/member-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";
export const runtime = "nodejs";
/** 响应携带一次性明文临时密码：禁止任何共享缓存。 */
const PRIVATE = { "Cache-Control": "private, no-store" } as const;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const { actor } = await authenticateRequest(request, requestId);
    return apiSuccess(await memberService.resetPassword((await params).id, actor), requestId, {
      headers: PRIVATE,
    });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
