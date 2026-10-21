import { AppError } from "@/lib/api/errors";
import { apiFailure } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { assertSameOrigin, authenticateRequest } from "@/lib/auth/request";

/** 旧客户端的统一退役响应；不读取目标、正文或历史评论。 */
export async function retiredCommentsResponse(request: Request, write = false) {
  const requestId = getRequestId(request.headers);
  try {
    if (write) assertSameOrigin(request);
    await authenticateRequest(request, requestId);
    throw new AppError("RESOURCE_NOT_FOUND", "该资源不存在");
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
