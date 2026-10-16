import { NextResponse, type NextRequest } from "next/server";

import { INTERNAL_PATHNAME_HEADER } from "@/lib/auth/internal-pathname";

/**
 * 唯一的中间件职责：把**规范化的当前 pathname** 交给服务端页面守卫。
 *
 * 用 `request.nextUrl.pathname`（Next 解析出来的路径，不含查询串与片段）无条件
 * `set`，客户端伪造的同名 Header 会被覆盖掉；这里不查数据库、不发邮件、不做
 * 任何门禁判定（Edge 不碰 Prisma / SMTP，判定一律在 `src/lib/auth/account-access.ts`）。
 */
export const config = {
  matcher: ["/member/:path*", "/admin/:path*", "/account/:path*"],
};

export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_PATHNAME_HEADER, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}
