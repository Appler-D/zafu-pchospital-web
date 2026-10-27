/** 反向代理须覆写 X-Real-IP / X-Forwarded-For；无代理时不信任请求自行携带的地址。 */
export function clientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get("x-forwarded-for");
  const last = forwarded?.split(",").pop()?.trim();
  return last || "unknown";
}
