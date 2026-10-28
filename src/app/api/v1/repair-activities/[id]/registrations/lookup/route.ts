import {
  repairActivityIpRateLimitKey,
  repairActivityPhoneRateLimitKey,
} from "@/features/repair-activities/repair-activity-rate-limit";
import { repairActivityService } from "@/features/repair-activities/repair-activity-service";
import { AppError } from "@/lib/api/errors";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { apiFailure, apiSuccess } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { logActivityRouteResult } from "@/lib/api/route-log";
import { assertSameOrigin, requestContext } from "@/lib/auth/request";
import { normalizePhone } from "@/lib/security/normalization";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request.headers);
  const context = requestContext(request, requestId);
  let activityId = "unknown";
  try {
    assertSameOrigin(request);
    const ip = context.ipAddress ?? "unknown";
    // IP 只是防刷兜底，主力是手机号（5 次/分钟 + 同场唯一）；30 次/分钟让校园网 NAT 后的正常用户不被误伤。
    enforceRateLimit(repairActivityIpRateLimitKey(ip), 30, 60_000);
    const body = (await request.json()) as Record<string, unknown>;
    const phoneRaw = String(body.phone ?? "");
    try {
      const phone = normalizePhone(phoneRaw);
      enforceRateLimit(repairActivityPhoneRateLimitKey(phone), 5, 60_000);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "VALIDATION_FAILED") throw error;
    }
    activityId = (await params).id;
    if (!activityId) throw new AppError("VALIDATION_FAILED", "活动 ID 无效");
    const result = await repairActivityService.lookup(activityId, phoneRaw, context);
    logActivityRouteResult("lookup", { requestId, activityId, result: "SUCCESS" });
    return apiSuccess(result, requestId);
  } catch (error) {
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    logActivityRouteResult("lookup", { requestId, activityId, result: code });
    return apiFailure(error, requestId);
  }
}
