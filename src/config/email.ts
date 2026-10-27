import type { EmailChallengePurpose } from "@/types/contracts";
import { EMAIL_CHALLENGE_TTL_MS } from "@/lib/security/email-policy";

/**
 * 验证码邮件的固定文案。邮件只发送品牌、安全用途、验证码、
 * 期限与「非本人操作请忽略」的必要文本：**没有**客户端可控的 from / subject /
 * 模板或任意 HTML，也不发密码、重置授权令牌。
 */

export const emailBrandName = "浙江农林大学电脑医院";

const purposeLabels: Record<EmailChallengePurpose, string> = {
  EMAIL_BIND: "绑定邮箱",
  EMAIL_CHANGE_OLD: "更换邮箱（验证原邮箱）",
  EMAIL_CHANGE_NEW: "更换邮箱（验证新邮箱）",
  PASSWORD_RESET: "找回密码",
};

export function emailChallengePurposeLabel(purpose: EmailChallengePurpose): string {
  return purposeLabels[purpose];
}

/** 验证码邮件正文（纯文本、固定模板）。`code` 只在这一处被拼进文本。 */
export function buildEmailChallengeMessage(input: {
  purpose: EmailChallengePurpose;
  code: string;
  expiresInMinutes: number;
}): { subject: string; text: string } {
  const label = emailChallengePurposeLabel(input.purpose);
  return {
    subject: `【${emailBrandName}】${label}验证码`,
    text: [
      `你正在办理${emailBrandName}的「${label}」。`,
      "",
      `验证码：${input.code}`,
      `有效期：${input.expiresInMinutes} 分钟，请勿向任何人泄露。`,
      "",
      "如果这不是你本人的操作，请忽略本邮件。",
      "本邮件由系统自动发送，请勿直接回复。",
    ].join("\n"),
  };
}

export const emailChallengeExpiresInMinutes = Math.round(EMAIL_CHALLENGE_TTL_MS / 60_000);
