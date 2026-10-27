import { repairActivityService } from "@/features/repair-activities/repair-activity-service";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  try {
    const data = await repairActivityService.getPublicQueue((await params).id);
    return apiSuccess(data, requestId, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
