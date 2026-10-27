import type { EmailMessage } from "@/lib/email/mailer";

export const ACCOUNT_NOTIFICATION_KIND = "APPLICATION_ACCOUNT";
export const ACCOUNT_NOTIFICATION_MAX_ATTEMPTS = 4;
export const ACCOUNT_NOTIFICATION_RETRY_MS = [60_000, 300_000, 1_800_000] as const;
export const ACCOUNT_NOTIFICATION_LEASE_MS = 120_000;
export const accountNotificationCopy = {
  title: "账号通知",
  noEmail: "未提供邮箱",
  notQueued: "未安排通知",
  afterProvision: "建档成功后安排通知",
  retry: "重试通知",
  scheduled: "通知已安排重试",
  retryHint: "请先处理失败原因。重试只发送通知，不重新审核或建档；每轮最多尝试 4 次",
  uncertain: "发送结果无法确认，请先核查；系统不会自动重发",
  status: {
    PENDING: "待发送",
    SENDING: "发送中",
    ACCEPTED: "已提交发信服务",
    FAILED: "失败",
    UNCERTAIN: "结果未知",
  },
  attempts: "本轮 {round} 次，累计 {count} 次",
  errors: {
    ACCOUNT_UNAVAILABLE: "账号当前不可用",
    QQ_IDENTITY_CHANGED: "QQ 身份已变化",
    INVALID_RECIPIENT: "通知邮箱无效",
    SMTP_REJECTED: "发信服务明确拒绝",
    SMTP_TEMPORARY_REJECTED: "暂时拒绝，等待下一次尝试",
    SMTP_TEMPORARY_EXHAUSTED: "暂时失败，尝试次数已耗尽",
    SMTP_UNCERTAIN: "发送结果无法确认",
    LEASE_EXPIRED: "发送进程中断，结果无法确认",
    BUDGET_DEFERRED: "等待发信额度",
  },
} as const;

export function buildAccountNotificationMessage(input: {
  to: string;
  qq: string;
  initialPassword?: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: "浙江农林大学电脑医院 · 账号通知",
    text: [
      "你的电脑医院成员账号已准备好",
      "官网：https://pczafu.cn",
      "登录：https://pczafu.cn/login",
      `QQ 登录账号：${input.qq}`,
      ...(input.initialPassword
        ? [
            `初始密码：${input.initialPassword}`,
            "首次登录须修改初始密码",
            "使用步骤：登录 → 修改初始密码 → 验证邮箱 → 进入工作区",
          ]
        : [
            "请使用当前密码登录；忘记密码或无法登录时请联系管理员",
            "使用步骤：登录 → 按页面提示完成验证 → 进入工作区",
          ]),
      "报名通知邮箱尚不代表已绑定邮箱，请在登录后按提示验证",
    ].join("\n"),
  };
}
