import { accountNotificationService } from "@/features/email/account-notification-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";
import { requirePermission } from "@/lib/auth/permissions";
export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  try {
    assertSameOrigin(request);
    const { actor } = await authenticateRequest(request, requestId);
    requirePermission(actor, "join:review");
    const result = await accountNotificationService.retry((await params).id, actor);
    return apiSuccess(result, requestId, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
