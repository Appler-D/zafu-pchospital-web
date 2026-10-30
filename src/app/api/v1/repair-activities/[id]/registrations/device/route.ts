import {
  readRegistrationDeviceCookie,
  readRegistrationDeviceToken,
} from "@/features/repair-activities/registration-device-token";
import { repairActivityService } from "@/features/repair-activities/repair-activity-service";
import { AppError } from "@/lib/api/errors";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { logActivityRouteResult } from "@/lib/api/route-log";

export const runtime = "nodejs";

/**
 * 本设备的报名状态（issue #304）：只认签名 cookie，不接收姓名 / 手机号参数。
 * 没有 cookie、签名不符、记录已删除一律返回 submitted=false（自动解锁）。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  let activityId = "unknown";
  try {
    activityId = (await params).id;
    if (!activityId) throw new AppError("VALIDATION_FAILED", "活动 ID 无效");
    const cookieToken = readRegistrationDeviceCookie(request.headers.get("cookie"), activityId);
    const device = cookieToken ? readRegistrationDeviceToken(cookieToken, { activityId }) : null;
    const registration = device
      ? await repairActivityService.deviceRegistration(activityId, device.registrationId)
      : null;
    logActivityRouteResult("device", {
      requestId,
      activityId,
      result: registration ? "SUBMITTED" : "NONE",
    });
    return apiSuccess({ submitted: registration !== null, registration }, requestId, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    logActivityRouteResult("device", { requestId, activityId, result: code });
    return apiFailure(error, requestId);
  }
}
