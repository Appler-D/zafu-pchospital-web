import { repairActivityStaffService } from "@/features/repair-activities/repair-activity-staff-service";
import { AppError } from "@/lib/api/errors";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { authenticateRequest } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  try {
    const { actor } = await authenticateRequest(request, requestId);
    const id = (await params).id;
    if (!id) throw new AppError("VALIDATION_FAILED", "活动 ID 无效");
    const view = new URL(request.url).searchParams.get("view") ?? "full";
    const data = await (() => {
      switch (view) {
        case "full":
          return repairActivityStaffService.getBoard(id, actor);
        case "live":
          return repairActivityStaffService.getLiveBoard(id, actor);
        case "served":
          return repairActivityStaffService.getServedBoard(id, actor);
        case "attendance":
          return repairActivityStaffService.getAttendanceBoard(id, actor);
        default:
          throw new AppError("VALIDATION_FAILED", "看板视图无效");
      }
    })();
    return apiSuccess(data, requestId, {
      headers: PRIVATE,
    });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
