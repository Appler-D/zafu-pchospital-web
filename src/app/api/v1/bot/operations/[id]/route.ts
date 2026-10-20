import { managementService } from "@/features/management/management-service";
import { requireUuid } from "@/features/management/management-input";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { authenticateMachine } from "@/lib/auth/machine";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  try {
    const actor = authenticateMachine(request, requestId, "activity:read");
    return apiSuccess(
      await managementService.operation(requireUuid((await context.params).id), actor),
      requestId,
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
