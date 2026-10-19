import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { accountNotificationCopy as copy } from "../../src/config/account-notification";
import { createSmtpEmailSender } from "../../src/lib/email/mailer";
import type { AccountNotificationView } from "../../src/types/contracts";

const mail = {
  enabled: true as const,
  smtpHost: "unused.test",
  smtpPort: 465,
  smtpUser: "fake",
  smtpPassword: "fake",
  mailFrom: "fake@test",
  dailyBudget: 150,
  codePepper: "fake-pepper",
};
test("通知 Sender 保留 Message-ID、只重试明确暂时拒绝且兼容旧验证码 outcome", async (t) => {
  t.mock.method(console, "error", () => {});
  const message = { to: "fake@example.com", subject: "fake", text: "fake" };
  for (const [error, expected] of [
    [
      { code: "EENVELOPE", responseCode: 450 },
      { status: "FAILED", retryable: true },
    ],
    [{ code: "EENVELOPE", responseCode: 550 }, { status: "FAILED" }],
    [{ code: "ETIMEDOUT" }, { status: "UNCERTAIN" }],
  ] as const) {
    const sender = createSmtpEmailSender(mail, () => ({
      async sendMail() {
        throw error;
      },
    }));
    assert.deepEqual(await sender.send(message), expected);
  }
  const accepted = createSmtpEmailSender(mail, () => ({
    async sendMail() {
      return { messageId: "<fake@test>", response: "must-not-return" };
    },
  }));
  assert.deepEqual(await accepted.send(message), { status: "ACCEPTED", messageId: "<fake@test>" });
  const legacy = createSmtpEmailSender(mail, () => ({
    async sendMail() {
      return {};
    },
  }));
  assert.deepEqual(await legacy.send(message), { status: "ACCEPTED" });
});
test("详情通知状态仅 FAILED 显示重试，处理中禁用；未提供邮箱及未知不误称送达", () => {
  (globalThis as unknown as { React: typeof React }).React = React;
  const { AccountNotificationStatusPanel } = createRequire(import.meta.url)(
    "../../src/components/admin/AccountNotificationStatusPanel",
  ) as typeof import("../../src/components/admin/AccountNotificationStatusPanel");
  const base: AccountNotificationView = {
    status: "FAILED",
    attemptCount: 4,
    roundAttemptCount: 4,
    nextAttemptAt: null,
    lastErrorCode: "SMTP_REJECTED",
    acceptedAt: null,
    messageId: null,
    canRetry: true,
  };
  const props = {
    applicationId: "test",
    hasEmail: true,
    provisionStatus: "SUCCEEDED",
    busy: false,
    async onChanged() {},
    onProblem() {},
    onScheduled() {},
  };
  const render = (notification: AccountNotificationView | null, extra = {}) =>
    renderToStaticMarkup(
      React.createElement(AccountNotificationStatusPanel, { ...props, notification, ...extra }),
    );
  assert.match(render(base), new RegExp(copy.retry));
  assert.match(render(base, { busy: true }), /disabled=""/);
  assert.match(render(null, { hasEmail: false }), new RegExp(copy.noEmail));
  const unknown = render({ ...base, status: "UNCERTAIN", canRetry: false });
  assert.match(unknown, new RegExp(copy.uncertain));
  assert.doesNotMatch(unknown, /<button/);
  const accepted = render({ ...base, status: "ACCEPTED", canRetry: false });
  assert.match(accepted, /已提交发信服务/);
  assert.doesNotMatch(accepted, /已送达|<button/);
});
