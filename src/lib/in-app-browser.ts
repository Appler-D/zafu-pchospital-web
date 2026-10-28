export type InAppBrowser = "qq" | "wechat" | null;

/** 仅识别移动设备的明确应用标记；MQQBrowser / QQBrowser / TBS 本身不表示 QQ 内置浏览器。 */
export function detectInAppBrowser(userAgent: string): InAppBrowser {
  if (
    !/(?:Android|iPhone|iPad|iPod)/i.test(userAgent) ||
    /(?:Windows NT|Macintosh|X11)/i.test(userAgent)
  )
    return null;
  if (/(?:^|[\s;(])MicroMessenger\//i.test(userAgent)) return "wechat";
  if (/(?:^|[\s;(])QQ\/\d+(?:\.\d+)*(?=$|[\s;)])/i.test(userAgent)) return "qq";
  return null;
}
