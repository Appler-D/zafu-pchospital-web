import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../../src/lib/api/errors";
import {
  getEmailGateMode,
  getMailConfig,
  getServerEnv,
  resetServerEnvForTests,
} from "../../src/lib/env";
import { classifySmtpFailure } from "../../src/lib/email/mailer";
import {
  digestEmailBucketKey,
  digestEmailCode,
  digestPasswordResetToken,
  emailCodeDigestMatches,
  generateEmailCode,
  generatePasswordResetToken,
} from "../../src/lib/security/email-security";
import { EmailChallengeService } from "../../src/features/email/email-challenge-service";

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "mysql://unused",
  AUTH_SECRET: "unit-test-auth-secret-at-least-32-bytes",
  INVITE_CODE_PEPPER: "unit-test-invite-pepper-at-least-32-bytes",
  PII_AUDIT_PEPPER: "unit-test-audit-pepper-at-least-32-bytes",
  EMAIL_CODE_PEPPER: "unit-test-email-code-pepper-at-least-32b",
};

const MANAGED_ENV = [
  ...Object.keys(BASE_ENV),
  "MAIL_ENABLED",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "MAIL_FROM",
  "EMAIL_DAILY_BUDGET",
  "EMAIL_GATE_MODE",
];

/** 临时覆盖环境变量并返回恢复函数（含 resetServerEnvForTests）。 */
function applyEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(BASE_ENV)) process.env[name] = value;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetServerEnvForTests();
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetServerEnvForTests();
  };
}

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const restore = applyEnv(overrides);
  try {
    run();
  } finally {
    restore();
  }
}

async function withEnvAsync(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const restore = applyEnv(overrides);
  try {
    await run();
  } finally {
    restore();
  }
}

test("验证码生成：6 位随机数字、保留前导零（注入 random 覆盖边界）", () => {
  assert.equal(
    generateEmailCode(() => 0),
    "000000",
  );
  assert.equal(
    generateEmailCode(() => 999_999),
    "999999",
  );
  assert.equal(
    generateEmailCode(() => 42),
    "000042",
  );
  // 默认生成只含数字且固定 6 位。
  assert.match(generateEmailCode(), /^\d{6}$/);
});

test("验证码摘要：绑定挑战 / 用户 / 用途 / 目标邮箱 / 验证码，上下文不可交叉复用", () => {
  withEnv({}, () => {
    const base = {
      challengeId: "c-1",
      userId: "u-1",
      purpose: "PASSWORD_RESET",
      emailNormalized: "a@example.com",
      code: "123456",
    };
    const digest = digestEmailCode(base);
    assert.equal(digest.byteLength, 32);
    assert.ok(emailCodeDigestMatches(digest, digestEmailCode({ ...base })));
    for (const changed of [
      { challengeId: "c-2" },
      { userId: "u-2" },
      { purpose: "EMAIL_BIND" },
      { emailNormalized: "b@example.com" },
      { code: "123457" },
    ]) {
      assert.equal(
        emailCodeDigestMatches(digest, digestEmailCode({ ...base, ...changed })),
        false,
        `上下文变更 ${JSON.stringify(changed)} 后摘要必须不同`,
      );
    }
    // 长度不同直接 false（恒定时间比较不因长度差异抛错）。
    assert.equal(emailCodeDigestMatches(digest, new Uint8Array(16)), false);
  });
});

test("重置令牌：32 字节安全随机、只以摘要入库、与验证码摘要命名空间隔离", () => {
  withEnv({}, () => {
    const token = generatePasswordResetToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/); // 32 字节 base64url
    assert.notEqual(token, generatePasswordResetToken());
    const digest = digestPasswordResetToken(token);
    assert.equal(digest.byteLength, 32);
    assert.notEqual(
      Buffer.from(digest).toString("hex"),
      Buffer.from(generatePasswordResetToken()).toString("hex"),
    );
  });
});

test("计数桶键摘要：不可逆、带 email 命名空间前缀", () => {
  withEnv({}, () => {
    const first = digestEmailBucketKey("send:daily:user:u-1");
    assert.equal(first.byteLength, 32);
    assert.equal(Buffer.from(first).toString("utf8").includes("send:daily"), false);
    assert.ok(Buffer.from(first).equals(Buffer.from(digestEmailBucketKey("send:daily:user:u-1"))));
    assert.equal(
      Buffer.from(first).equals(Buffer.from(digestEmailBucketKey("send:daily:user:u-2"))),
      false,
    );
  });
});

test("SMTP 失败分类是受控两档：明确拒绝→FAILED，其余一律保守 UNCERTAIN", () => {
  assert.equal(classifySmtpFailure({ code: "EAUTH" }), "FAILED");
  assert.equal(classifySmtpFailure({ code: "EENVELOPE" }), "FAILED");
  assert.equal(classifySmtpFailure({ code: "EMESSAGE" }), "FAILED");
  assert.equal(classifySmtpFailure({ responseCode: 550 }), "FAILED");
  assert.equal(classifySmtpFailure({ code: "ETIMEDOUT" }), "UNCERTAIN");
  assert.equal(classifySmtpFailure({ code: "ESOCKET" }), "UNCERTAIN");
  assert.equal(classifySmtpFailure({ responseCode: 421 }), "UNCERTAIN");
  assert.equal(classifySmtpFailure(new Error("boom")), "UNCERTAIN");
  assert.equal(classifySmtpFailure(null), "UNCERTAIN");
});

test("配置关闭兼容：未启用邮件时应用可启动，邮件操作被明确拒绝且不伪装成功", async () => {
  // 不设置 MAIL_ENABLED / SMTP_* / EMAIL_CODE_PEPPER 也不得影响启动。
  withEnv({ MAIL_ENABLED: undefined, SMTP_HOST: undefined, EMAIL_CODE_PEPPER: undefined }, () => {
    assert.equal(getServerEnv().MAIL_ENABLED, false);
    assert.deepEqual(getMailConfig(), { enabled: false });
  });
  let rejection: unknown;
  try {
    await withEnvAsync({ MAIL_ENABLED: undefined }, async () => {
      await new EmailChallengeService().requestEmailChallenge(
        { userId: "u-1", purpose: "PASSWORD_RESET" },
        { requestId: "req_test" },
      );
    });
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection instanceof AppError);
  assert.equal(rejection.code, "EMAIL_NOT_ENABLED");
});

test("门禁档位：缺省 off，只认三个值，非法值不静默按关闭运行", () => {
  withEnv({ EMAIL_GATE_MODE: undefined }, () => {
    assert.equal(getServerEnv().EMAIL_GATE_MODE, "off");
  });
  for (const [raw, expected] of [
    ["", "off"],
    ["off", "off"],
    ["admin", "admin"],
    ["all", "all"],
    ["  all  ", "all"],
  ] as const)
    withEnv({ EMAIL_GATE_MODE: raw }, () => {
      assert.equal(getEmailGateMode(), expected, `原始值 ${JSON.stringify(raw)}`);
    });
  // 大小写 / 近似值 / 空意外值都算部署错误：报错而不是退回关闭继续跑。
  for (const raw of ["ALL", "Admin", "true", "1", "enable", "on", "off1"])
    withEnv({ EMAIL_GATE_MODE: raw }, () => {
      assert.throws(
        () => getEmailGateMode(),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "EMAIL_GATE_MODE_INVALID" &&
          error.status === 500,
        `非法档位 ${JSON.stringify(raw)} 必须拒绝`,
      );
    });
  // 档位与 SMTP 解耦：未启用邮件也能开启门禁，读取档位不会去校验发信配置。
  withEnv(
    { EMAIL_GATE_MODE: "all", MAIL_ENABLED: undefined, SMTP_HOST: undefined, SMTP_PORT: undefined },
    () => {
      assert.equal(getEmailGateMode(), "all");
      assert.deepEqual(getMailConfig(), { enabled: false });
    },
  );
});

test("启用邮件时配置校验：缺一项即拒绝，端口 / 预算必须在启用时才校验", () => {
  withEnv({ MAIL_ENABLED: "true", SMTP_HOST: "smtpdm.aliyun.com" }, () => {
    assert.throws(
      () => getMailConfig(),
      (error: unknown) => error instanceof AppError && error.code === "INTERNAL_ERROR",
    );
  });
  withEnv(
    {
      MAIL_ENABLED: "true",
      SMTP_HOST: "smtpdm.aliyun.com",
      SMTP_USER: "noreply@pczafu.cn",
      SMTP_PASSWORD: "secret",
      MAIL_FROM: "noreply@pczafu.cn",
      // BASE_ENV 会统一补上 EMAIL_CODE_PEPPER，这里必须显式移除才能测「缺 pepper」。
      EMAIL_CODE_PEPPER: undefined,
    },
    () => {
      assert.throws(
        () => getMailConfig(),
        (error: unknown) =>
          error instanceof AppError && error.message.includes("EMAIL_CODE_PEPPER"),
      );
    },
  );

  const fullConfig: Record<string, string> = {
    MAIL_ENABLED: "true",
    SMTP_HOST: "smtpdm.aliyun.com",
    SMTP_USER: "noreply@pczafu.cn",
    SMTP_PASSWORD: "secret",
    MAIL_FROM: "noreply@pczafu.cn",
  };
  // 关闭邮件时（F4 返修）：邮件专用取值非法不得拒绝全站配置读取，
  // 也不能连带影响 DB / 认证等共用同一配置入口的路径。
  withEnv({ SMTP_PORT: "not-a-port", EMAIL_DAILY_BUDGET: "abc" }, () => {
    assert.equal(getServerEnv().MAIL_ENABLED, false);
    assert.deepEqual(getMailConfig(), { enabled: false });
  });
  // 启用后非法端口 / 预算仍必须拒绝。
  withEnv({ ...fullConfig, SMTP_PORT: "not-a-port" }, () => {
    assert.throws(
      () => getMailConfig(),
      (error: unknown) => error instanceof AppError && error.code === "INTERNAL_ERROR",
    );
  });
  withEnv({ ...fullConfig, SMTP_PORT: "70000" }, () => {
    assert.throws(
      () => getMailConfig(),
      (error: unknown) => error instanceof AppError && error.message.includes("SMTP_PORT"),
    );
  });
  withEnv({ ...fullConfig, EMAIL_DAILY_BUDGET: "abc" }, () => {
    assert.throws(
      () => getMailConfig(),
      (error: unknown) => error instanceof AppError && error.code === "INTERNAL_ERROR",
    );
  });
  withEnv({ ...fullConfig, EMAIL_DAILY_BUDGET: "0" }, () => {
    assert.throws(
      () => getMailConfig(),
      (error: unknown) => error instanceof AppError && error.code === "INTERNAL_ERROR",
    );
  });
  // 合法预算在启用时解析进邮件配置。
  withEnv({ ...fullConfig, EMAIL_DAILY_BUDGET: "80" }, () => {
    const config = getMailConfig();
    assert.equal(config.enabled, true);
    if (config.enabled) assert.equal(config.dailyBudget, 80);
  });
});
