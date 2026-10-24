import { memberExportService } from "@/features/admin/member-export-service";
import { memberListInput } from "@/features/members/member-http";
import { AppError } from "@/lib/api/errors";
import { apiFailure } from "@/lib/api/response";
import { getRequestId } from "@/lib/api/request-id";
import { authenticateRequest } from "@/lib/auth/request";
import { ExportFormat, type ExportFormat as Format } from "@/types/contracts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = getRequestId(request.headers);
  try {
    const { actor } = await authenticateRequest(request, requestId);
    const params = new URL(request.url).searchParams;
    const format = (params.get("format") ?? "CSV").toUpperCase();
    if (!(ExportFormat as readonly string[]).includes(format))
      throw new AppError("EXPORT_FORMAT_INVALID", "导出格式只支持 csv 或 xlsx");
    // 不受列表分页限制，也不导出统计；其余参数复用列表解析与白名单。
    const input = memberListInput(params, 1, 1);
    const result = await memberExportService.export(
      {
        query: input.query,
        status: input.status,
        role: input.role,
        sort: input.sort,
        filters: input.filters,
      },
      format as Format,
      actor,
    );
    return new Response(result.body, {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.fileName}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
        "Content-Length": String(result.body.byteLength),
        "Cache-Control": "private, no-store",
        "X-Export-Row-Count": String(result.rowCount),
      },
    });
  } catch (error) {
    return apiFailure(error, requestId);
  }
}
