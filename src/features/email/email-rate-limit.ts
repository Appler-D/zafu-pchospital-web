import type { Prisma } from "@/generated/prisma/client";
import { AppError, type ApiErrorCode } from "@/lib/api/errors";
import { shanghaiDateOf } from "@/lib/shanghai-date";
import {
  PASSWORD_RECOVERY_REQUEST_IP_MAX,
  PASSWORD_RECOVERY_REQUEST_IP_WINDOW_MS,
  PASSWORD_RECOVERY_REQUEST_QQ_COOLDOWN_MS,
  PASSWORD_RECOVERY_REQUEST_QQ_DAILY_MAX,
  EMAIL_BUDGET_MINUTE_MAX,
  EMAIL_BUDGET_MINUTE_WINDOW_MS,
  EMAIL_CODE_BLOCK_MS,
  EMAIL_CODE_FAILURE_WINDOW_MS,
  EMAIL_CODE_MAX_FAILURES,
  EMAIL_DAILY_ACCOUNT_MAX,
  EMAIL_DAILY_IP_MAX,
  EMAIL_DAILY_TARGET_MAX,
  EMAIL_SEND_COOLDOWN_MS,
  EMAIL_VERIFY_IP_MAX,
  EMAIL_VERIFY_IP_WINDOW_MS,
} from "@/lib/security/email-policy";
import { digestEmailBucketKey } from "@/lib/security/email-security";

/**
 * 邮箱专用安全计数：全部持久化在 GreatSQL，跨进程 / 重启生效。
 * 一个进程内存 Map 挡不住多实例，也不该成为「接近预算就放行」的退路 ——
 * 这里没有内存回退，超限只有受控错误一种结果。
 *
 * 桶键是**带用途命名空间的不可逆摘要**（明文键只活在调用栈里）。
 * 窗口两类：滚动窗口锚定首次事件；每日窗口锚定上海自然日（无夏令时，+24h 恒成立）。
 */

/** 计数键构造器。测试清理夹具时也要按同一份键算摘要，因此导出。 */
export const emailBucketKeys = {
  recoveryRequestIp: (ip: string) => `recovery:request:ip:${ip}`,
  recoveryRequestQqCooldown: (qq: string) => `recovery:request:qq:cooldown:${qq}`,
  recoveryRequestQqDaily: (qq: string) => `recovery:request:qq:daily:${qq}`,
  sendCooldownUser: (userId: string) => `send:cooldown:user:${userId}`,
  sendCooldownEmail: (emailNormalized: string) => `send:cooldown:email:${emailNormalized}`,
  sendDailyUser: (userId: string) => `send:daily:user:${userId}`,
  sendDailyEmail: (emailNormalized: string) => `send:daily:email:${emailNormalized}`,
  sendDailyIp: (ipAddress: string) => `send:daily:ip:${ipAddress}`,
  budgetDay: () => "budget:global:day",
  budgetMinute: () => "budget:global:minute",
  verifyFailure: (userId: string, purpose: string) => `verify:fail:${userId}:${purpose}`,
  verifyIp: (ipAddress: string) => `verify:ip:${ipAddress}`,
} as const;

type CounterWindow = { start: Date; end: Date };

function rollingWindow(now: Date, windowMs: number): CounterWindow {
  return { start: now, end: new Date(now.getTime() + windowMs) };
}

/** 上海自然日固定窗口：起点 = 当天 00:00（上海），终点 = 次日 00:00（上海）。 */
function shanghaiDayWindow(now: Date): CounterWindow {
  const start = new Date(`${shanghaiDateOf(now)}T00:00:00+08:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1_000) };
}

export type EmailCounterSpec = {
  key: string;
  /** 窗口构造器：以**等锁后的本次实际决策时刻**构造（补充）。 */
  window: (now: Date) => CounterWindow;
  max: number;
  errorCode: ApiErrorCode;
  message?: string;
};

const defaultMessages: Partial<Record<ApiErrorCode, string>> = {
  EMAIL_RATE_LIMITED: "操作过于频繁，请稍后再试",
  EMAIL_BUDGET_EXHAUSTED: "全站发信额度已用尽，请稍后再试",
};

/** 锁定计数桶行（`FOR UPDATE`）。窗口与过期判定必须以等锁完成后的时间为准（F3 补充）。 */
async function lockEmailCounterBucket(tx: Prisma.TransactionClient, key: string): Promise<void> {
  const keyDigest = digestEmailBucketKey(key);
  await tx.$queryRaw`SELECT bucket_key_digest FROM email_security_counters WHERE bucket_key_digest = ${keyDigest} FOR UPDATE`;
}

/** 在已锁定桶行的前提下，按给定的**锁后时刻**读改写计数并检查上限。语义：
 *  窗口过期或首次建桶 → 计 1 并开新窗口；否则计 +1；`counter > max` 抛受控错误，
 *  让调用方事务整体回滚（「未预占成功不得调用 SMTP」由这一条保证）。 */
async function applyEmailCounter(
  tx: Prisma.TransactionClient,
  spec: EmailCounterSpec,
  now: Date,
): Promise<void> {
  const keyDigest = digestEmailBucketKey(spec.key);
  const current = await tx.emailSecurityCounter.findUnique({
    where: { bucketKeyDigest: keyDigest },
  });
  const expired = !current || current.windowExpiresAt <= now;
  const counter = expired ? 1 : current.counter + 1;
  const window = spec.window(now);
  await tx.emailSecurityCounter.upsert({
    where: { bucketKeyDigest: keyDigest },
    create: {
      bucketKeyDigest: keyDigest,
      counter,
      windowStartedAt: window.start,
      windowExpiresAt: window.end,
      blockedUntil: null,
      updatedAt: now,
    },
    update: {
      counter,
      windowStartedAt: expired ? window.start : current!.windowStartedAt,
      windowExpiresAt: expired ? window.end : current!.windowExpiresAt,
      blockedUntil: expired ? null : current!.blockedUntil,
      updatedAt: now,
    },
  });
  if (counter > spec.max) {
    throw new AppError(spec.errorCode, spec.message ?? defaultMessages[spec.errorCode]!);
  }
}

/**
 * 原子计数一次并检查上限（在调用方事务内执行）。先 `FOR UPDATE` 锁桶行，
 * **等锁完成之后**才取当前服务端时间（补充）：锁等待期间跨过
 * 窗口 / 冷却截止时刻时，按解除等待后的时刻判定过期并重建窗口，不沿用等锁前快照。
 *
 * 并发正确性：serializable 事务里先锁再读改写；两笔请求同时首次建桶时，
 * 后到者要么排队看到前一行的最新值，要么被序列化冲突重试（`inSerializableTransaction`
 * 最多 3 次）—— 与登录节流 `recordFailure` 同一形状，不在单进程锁上取巧。
 */
export async function consumeEmailCounter(
  tx: Prisma.TransactionClient,
  spec: EmailCounterSpec,
  now: () => Date,
): Promise<void> {
  await lockEmailCounterBucket(tx, spec.key);
  await applyEmailCounter(tx, spec, now());
}

/**
 * 发信前的原子预占：冷却（账号 / 目标各 ≥60 秒）+ 每日上限（账号 / 目标 / IP）
 * + 全站预算（日 / 分钟）。按**固定顺序**先锁齐本次需要的全部桶（并发请求以同一
 * 顺序进入就不会环等），等锁全部结束后再取一次当前服务端时间并完成判定 ——
 * 任一桶超限抛错即整体回滚，不消耗任何额度。
 *
 * 返回**本次实际预占时刻**（锁后取时， 补充）：调用方的
 * 挑战 `createdAt` / `expiresAt` 等应以此为准，不再复用预占前的旧快照；窗口与
 * 冷却也全部由该时刻构造，等待期间跨过截止时刻按锁后时间判定。
 */
export async function preoccupyEmailSendQuota(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    emailNormalized: string;
    ipAddress: string | null;
    now: () => Date;
    dailyBudget: number;
  },
): Promise<Date> {
  const ip = input.ipAddress && input.ipAddress.trim() ? input.ipAddress.trim() : "unknown";
  const specs: EmailCounterSpec[] = [
    {
      key: emailBucketKeys.sendCooldownUser(input.userId),
      window: (now) => rollingWindow(now, EMAIL_SEND_COOLDOWN_MS),
      max: 1,
      errorCode: "EMAIL_RATE_LIMITED",
      message: "验证码邮件刚发送过，请 60 秒后再试",
    },
    {
      key: emailBucketKeys.sendCooldownEmail(input.emailNormalized),
      window: (now) => rollingWindow(now, EMAIL_SEND_COOLDOWN_MS),
      max: 1,
      errorCode: "EMAIL_RATE_LIMITED",
      message: "该邮箱刚收到过验证码邮件，请 60 秒后再试",
    },
    {
      key: emailBucketKeys.sendDailyUser(input.userId),
      window: shanghaiDayWindow,
      max: EMAIL_DAILY_ACCOUNT_MAX,
      errorCode: "EMAIL_RATE_LIMITED",
      message: "今日邮件发送次数已达上限，请明天再试",
    },
    {
      key: emailBucketKeys.sendDailyEmail(input.emailNormalized),
      window: shanghaiDayWindow,
      max: EMAIL_DAILY_TARGET_MAX,
      errorCode: "EMAIL_RATE_LIMITED",
      message: "该邮箱今日接收验证码次数已达上限，请明天再试",
    },
    {
      key: emailBucketKeys.sendDailyIp(ip),
      window: shanghaiDayWindow,
      max: EMAIL_DAILY_IP_MAX,
      errorCode: "EMAIL_RATE_LIMITED",
      message: "当前网络今日邮件发送次数已达上限，请明天再试",
    },
    ...globalEmailBudgetSpecs(input.dailyBudget),
  ];
  // 固定取锁顺序：不同请求的桶集合有交集时，排序后按同一顺序进入不会形成等待环。
  specs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const spec of specs) await lockEmailCounterBucket(tx, spec.key);
  // 锁齐之后再取时：等锁期间的真实经过时间必须体现在判定与窗口上（F3 补充）。
  const decisionNow = input.now();
  for (const spec of specs) await applyEmailCounter(tx, spec, decisionNow);
  return decisionNow;
}

/**
 * 验证失败计数（同一账号 + 用途，15 分钟窗口 5 次失败 → 阻断 15 分钟）。
 * 达到上限时设置 / 刷新 `blockedUntil`；重发、换目标、换 IP 都不会清零本桶 ——
 * 键里只有（用户, 用途）。必须在**独立提交的事务**里调用：失败计数要持久化后
 * 才能向调用者返回失败，不能跟着业务事务一起回滚。
 */
export async function recordEmailVerificationFailure(
  tx: Prisma.TransactionClient,
  input: { userId: string; purpose: string },
  now: Date,
): Promise<{ blockedUntil: Date | null }> {
  const keyDigest = digestEmailBucketKey(
    emailBucketKeys.verifyFailure(input.userId, input.purpose),
  );
  await tx.$queryRaw`SELECT bucket_key_digest FROM email_security_counters WHERE bucket_key_digest = ${keyDigest} FOR UPDATE`;
  const current = await tx.emailSecurityCounter.findUnique({
    where: { bucketKeyDigest: keyDigest },
  });
  const expired = !current || current.windowExpiresAt <= now;
  const counter = expired ? 1 : current.counter + 1;
  const blockedUntil =
    counter >= EMAIL_CODE_MAX_FAILURES
      ? new Date(now.getTime() + EMAIL_CODE_BLOCK_MS)
      : expired
        ? null
        : current!.blockedUntil;
  await tx.emailSecurityCounter.upsert({
    where: { bucketKeyDigest: keyDigest },
    create: {
      bucketKeyDigest: keyDigest,
      counter,
      windowStartedAt: expired ? now : current!.windowStartedAt,
      windowExpiresAt: expired
        ? new Date(now.getTime() + EMAIL_CODE_FAILURE_WINDOW_MS)
        : current!.windowExpiresAt,
      blockedUntil,
      updatedAt: now,
    },
    update: {
      counter,
      windowStartedAt: expired ? now : current!.windowStartedAt,
      windowExpiresAt: expired
        ? new Date(now.getTime() + EMAIL_CODE_FAILURE_WINDOW_MS)
        : current!.windowExpiresAt,
      blockedUntil,
      updatedAt: now,
    },
  });
  return { blockedUntil };
}

/**
 * 锁定（账号, 用途）失败桶行：验码决策的事务串行化点。
 *
 * 同一账号的并发验码在这里排成先后，「检查阻断 → 判定验证码 / 状态 → 记失败」
 * 作为一个整体串行执行 —— 5 次失败上限不会被并发穿透。桶不存在时同样先取
 * gap 锁，首个失败的 INSERT 与并发者由可串行化重试兜底（与计数原语同一形状）。
 */
export async function lockEmailVerificationFailureBucket(
  tx: Prisma.TransactionClient,
  input: { userId: string; purpose: string },
): Promise<void> {
  const keyDigest = digestEmailBucketKey(
    emailBucketKeys.verifyFailure(input.userId, input.purpose),
  );
  await tx.$queryRaw`SELECT bucket_key_digest FROM email_security_counters WHERE bucket_key_digest = ${keyDigest} FOR UPDATE`;
}

/** 进入验证前的阻断检查（需在 {@link lockEmailVerificationFailureBucket} 之后、
 *  同一事务内调用）；返回未失效的阻断截止时刻（无阻断为 `null`）。 */
export async function readEmailVerificationBlock(
  tx: Prisma.TransactionClient,
  input: { userId: string; purpose: string },
  now: Date,
): Promise<Date | null> {
  const row = await tx.emailSecurityCounter.findUnique({
    where: {
      bucketKeyDigest: digestEmailBucketKey(
        emailBucketKeys.verifyFailure(input.userId, input.purpose),
      ),
    },
  });
  if (!row || !row.blockedUntil || row.blockedUntil <= now) return null;
  return row.blockedUntil;
}

/** 校验请求的 IP 桶：同一 IP 15 分钟最多 30 次校验请求（与账号失败桶共同生效）。
 *  `now` 传时间提供者：锁等待完成后才取时（F3 补充），不沿用等锁前快照。 */
export async function consumeEmailVerifyIpQuota(
  tx: Prisma.TransactionClient,
  ipAddress: string | null,
  now: () => Date,
): Promise<void> {
  const ip = ipAddress && ipAddress.trim() ? ipAddress.trim() : "unknown";
  await consumeEmailCounter(
    tx,
    {
      key: emailBucketKeys.verifyIp(ip),
      window: (counterNow) => rollingWindow(counterNow, EMAIL_VERIFY_IP_WINDOW_MS),
      max: EMAIL_VERIFY_IP_MAX,
      errorCode: "EMAIL_RATE_LIMITED",
      message: "验证尝试过于频繁，请稍后再试",
    },
    now,
  );
}

/** 匿名账号查询之前独立提交：未知 / 不合格 QQ 同样计数，不随后续结果回滚。 */
export async function preoccupyPasswordRecoveryRequestQuota(
  tx: Prisma.TransactionClient,
  input: { qq: string; ipAddress?: string; now: () => Date },
): Promise<Date> {
  const specs: EmailCounterSpec[] = [
    {
      key: emailBucketKeys.recoveryRequestIp(input.ipAddress?.trim() || "unknown"),
      window: (now) => rollingWindow(now, PASSWORD_RECOVERY_REQUEST_IP_WINDOW_MS),
      max: PASSWORD_RECOVERY_REQUEST_IP_MAX,
      errorCode: "EMAIL_RATE_LIMITED",
    },
    {
      key: emailBucketKeys.recoveryRequestQqCooldown(input.qq),
      window: (now) => rollingWindow(now, PASSWORD_RECOVERY_REQUEST_QQ_COOLDOWN_MS),
      max: 1,
      errorCode: "EMAIL_RATE_LIMITED",
    },
    {
      key: emailBucketKeys.recoveryRequestQqDaily(input.qq),
      window: shanghaiDayWindow,
      max: PASSWORD_RECOVERY_REQUEST_QQ_DAILY_MAX,
      errorCode: "EMAIL_RATE_LIMITED",
    },
  ];
  specs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const spec of specs) await lockEmailCounterBucket(tx, spec.key);
  const at = input.now();
  for (const spec of specs) await applyEmailCounter(tx, spec, at);
  return at;
}

function globalEmailBudgetSpecs(dailyBudget: number): EmailCounterSpec[] {
  return [
    {
      key: emailBucketKeys.budgetDay(),
      window: shanghaiDayWindow,
      max: dailyBudget,
      errorCode: "EMAIL_BUDGET_EXHAUSTED",
    },
    {
      key: emailBucketKeys.budgetMinute(),
      window: (at) => rollingWindow(at, EMAIL_BUDGET_MINUTE_WINDOW_MS),
      max: EMAIL_BUDGET_MINUTE_MAX,
      errorCode: "EMAIL_BUDGET_EXHAUSTED",
    },
  ];
}

/** 通知只预占原全站桶，不伪造请求 IP，也不占用户验证码冷却。锁齐后取时。 */
export async function preoccupyGlobalEmailBudget(
  tx: Prisma.TransactionClient,
  input: { dailyBudget: number; now: () => Date },
): Promise<{ at: Date; nextAt: Date | null }> {
  const specs = globalEmailBudgetSpecs(input.dailyBudget).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  for (const spec of specs) await lockEmailCounterBucket(tx, spec.key);
  const at = input.now();
  let nextAt: Date | null = null;
  for (const spec of specs) {
    const row = await tx.emailSecurityCounter.findUnique({
      where: { bucketKeyDigest: digestEmailBucketKey(spec.key) },
    });
    if (
      row &&
      row.windowExpiresAt > at &&
      row.counter >= spec.max &&
      (!nextAt || row.windowExpiresAt > nextAt)
    )
      nextAt = row.windowExpiresAt;
  }
  if (!nextAt) for (const spec of specs) await applyEmailCounter(tx, spec, at);
  return { at, nextAt };
}
