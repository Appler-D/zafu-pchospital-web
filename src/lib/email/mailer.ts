import nodemailer from "nodemailer";

import { getMailConfig, type MailConfig } from "@/lib/env";

/**
 * SMTP 发信适配。复用成熟实现（nodemailer），不手写协议；
 * 单次直发即可：不启连接池、不自动重试、不挂队列 —— 发送顺序与结果记录由
 * 服务层按「先预占额度 → 事务外发送 → 短事务记录结果」编排。
 *
 * 失败分类是**受控两档**（与预算消耗口径无关，两者都保留已预占额度）：
 * - `FAILED`：服务商明确拒绝（认证失败 / 收件人拒收 / 5xx），没有送达可能；
 * - `UNCERTAIN`：连接 / 超时 / 其它传输异常 —— 保守按「可能已送达」处理。
 */

export type EmailDeliveryOutcome =
  | { status: "ACCEPTED"; messageId?: string }
  | { status: "FAILED"; retryable?: boolean }
  | { status: "UNCERTAIN" };

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailDeliveryOutcome>;
}

/** 连接 / 问候 / socket 超时统一 10 秒上限：失败要及时返回，不拖住请求线程。 */
export const SMTP_TIMEOUT_MS = 10_000;

/** nodemailer 错误码 → 受控分类。不做穷举采样，未识别的一律保守归 `UNCERTAIN`。 */
export function classifySmtpFailure(error: unknown): "FAILED" | "UNCERTAIN" {
  const record = error as { code?: unknown; responseCode?: unknown } | null;
  const code = record && typeof record.code === "string" ? record.code : null;
  // EAUTH：认证 / 授权失败；EENVELOPE：收件人等在信封阶段被拒；EMESSAGE：报文被拒。
  if (code === "EAUTH" || code === "EENVELOPE" || code === "EMESSAGE") return "FAILED";
  const responseCode = record && typeof record.responseCode === "number" ? record.responseCode : 0;
  if (responseCode >= 500) return "FAILED";
  return "UNCERTAIN";
}

type TransportFactory = (options: Parameters<typeof nodemailer.createTransport>[0]) => {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  close?: () => void;
};

/**
 * DirectMail（阿里云邮件推送）直发 Sender：`smtpdm.aliyun.com:465`、隐式 TLS。
 * 465 用 `secure: true`（参考 Nodemailer SMTP 官方说明）；证书校验保持默认开启，
 * 不做 `rejectUnauthorized: false` 一类弱化。关闭协议 debug / 原始 SMTP 日志。
 * 收件人只取调用方给的规范化地址（固定单收件人）；from / subject / 正文都来自服务端。
 */
export function createSmtpEmailSender(
  config: Extract<MailConfig, { enabled: true }>,
  createTransport: TransportFactory = nodemailer.createTransport as TransportFactory,
): EmailSender {
  return {
    async send(message: EmailMessage): Promise<EmailDeliveryOutcome> {
      const transport = createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: { user: config.smtpUser, pass: config.smtpPassword },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
        pool: false,
        debug: false,
        logger: false,
      });
      try {
        const info = await transport.sendMail({
          from: config.mailFrom,
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
        const messageId = (info as { messageId?: unknown } | null)?.messageId;
        return {
          status: "ACCEPTED",
          ...(typeof messageId === "string" && /^[\x21-\x7e]{1,191}$/.test(messageId)
            ? { messageId }
            : {}),
        };
      } catch (error) {
        const record = error as { code?: unknown; responseCode?: unknown } | null;
        // 仅已知 SMTP 拒绝阶段的 4xx 才可证明未接受；超时 / socket 等保持未知。
        const retryable =
          !!record &&
          ["EAUTH", "EENVELOPE", "EMESSAGE"].includes(String(record.code)) &&
          typeof record.responseCode === "number" &&
          record.responseCode >= 400 &&
          record.responseCode < 500;
        const classification = retryable ? "FAILED" : classifySmtpFailure(error);
        // 只记录受控分类，不序列化原始 Error / 收件地址 / 服务商报文。
        console.error("[email] 邮件发送未成功", { classification });
        return classification === "FAILED"
          ? { status: "FAILED", ...(retryable ? { retryable: true } : {}) }
          : { status: "UNCERTAIN" };
      } finally {
        transport.close?.();
      }
    },
  };
}

/**
 * 默认 Sender 工厂：服务层每个请求按需组装一次（单次直发，本就不建池）。
 * `MAIL_ENABLED` 未开启 / 配置不完整时抛错 —— 调用方在此之前已先拒绝邮件操作。
 */
export function getDefaultEmailSender(): EmailSender {
  const config = getMailConfig();
  if (!config.enabled) {
    throw new Error("邮件功能未启用（MAIL_ENABLED=false）");
  }
  return createSmtpEmailSender(config);
}
