/**
 * 公开活动报名 / 查询的结果码日志。
 *
 * 只记录请求编号、活动与结果码；不记录请求正文、姓名或完整手机号。
 */
export function logActivityRouteResult(
  action: "signup" | "lookup",
  input: { requestId: string; activityId: string; result: string },
): void {
  console.info(JSON.stringify({ event: `repair_activity.${action}`, ...input }));
}
