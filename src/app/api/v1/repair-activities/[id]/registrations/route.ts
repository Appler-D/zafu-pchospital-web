import {
  repairActivityIpRateLimitKey,
  repairActivityPhoneRateLimitKey,
} from "@/features/repair-activities/repair-activity-rate-limit";
import {
  issueRegistrationDeviceToken,
  readRegistrationDeviceCookie,
  readRegistrationDeviceToken,
  registrationDeviceCookieName,
  registrationDeviceCookieOptions,
} from "@/features/repair-activities/registration-device-token";
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
    // phone 限流：规范化成功后再按号限；格式错由 service 抛 VALIDATION。
    try {
      const phone = normalizePhone(phoneRaw);
      enforceRateLimit(repairActivityPhoneRateLimitKey(phone), 5, 60_000);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "VALIDATION_FAILED") throw error;
    }
    activityId = (await params).id;
    if (!activityId) throw new AppError("VALIDATION_FAILED", "活动 ID 无效");
    const cookieToken = readRegistrationDeviceCookie(request.headers.get("cookie"), activityId);
    const device = cookieToken ? readRegistrationDeviceToken(cookieToken, { activityId }) : null;
    const result = await repairActivityService.register(
      activityId,
      {
        name: String(body.name ?? ""),
        phone: phoneRaw,
        issueType: body.issueType,
        // 机型选填：不是字符串时由 service 按 VALIDATION_FAILED 拒绝。
        deviceModel: body.deviceModel,
        // 免责声明同意标记：只认布尔 true，缺失或其它值都算没同意。
        consentAccepted: body.consentAccepted === true,
      },
      context,
      device,
    );
    logActivityRouteResult("signup", { requestId, activityId, result: "SUCCESS" });
    const response = apiSuccess(result, requestId, { status: 201 });
    // 下发设备凭证：服务端据此拒绝同一设备的重复填写，前端据此显示「已提交」面板。
    response.cookies.set({
      name: registrationDeviceCookieName(activityId),
      value: issueRegistrationDeviceToken(activityId, result.id),
      ...registrationDeviceCookieOptions(),
    });
    return response;
  } catch (error) {
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    logActivityRouteResult("signup", { requestId, activityId, result: code });
    return apiFailure(error, requestId);
  }
}
