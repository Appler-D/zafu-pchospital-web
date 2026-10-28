export const browserHintCopy = {
  title: "建议使用手机浏览器打开",
  description:
    "当前可能在 {browser} 内打开。建议通过右上角菜单选择「在浏览器中打开」，然后重新登录",
  browsers: { qq: "QQ", wechat: "微信" },
  close: "关闭",
} as const;

export const browserHintDismissedKey = "zafu-pchospital:browser-hint-dismissed:v1";

export const repairWorkflowLink = {
  href: "/handbook/Manual/Workflow.html",
  label: "查看维修流程",
  newTab: "（新标签页打开）",
} as const;
