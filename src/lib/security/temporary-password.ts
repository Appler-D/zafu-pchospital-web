import { randomInt } from "node:crypto";

/**
 * 管理员手动重置签发的临时密码。
 *
 * 与「QQ 后六位初始密码」（`initialPasswordFromQq`）是两套规则，刻意不复用：
 * 初始密码公开可推导，靠首次登录强制改密兜底；临时密码是**安全随机数字**，
 * 靠 1 小时有效期、首次登录原子消费与账号级限流兜底。
 *
 * 三个参数是产品口径（任务书 §4），调参必须先与产品对齐；节流参数在
 * `auth-service.ts`（`THROTTLE_*`），与普通登录共用同一套窗口 / 阻断值。
 */
export const TEMPORARY_PASSWORD_LENGTH = 6;
export const TEMPORARY_PASSWORD_TTL_MS = 60 * 60 * 1_000;
export const TEMPORARY_SESSION_MAX_MS = 10 * 60 * 1_000;

/**
 * 生成 6 位安全随机数字，保留前导零（`042917` 也是合法密码）。
 * 注入 `random` 只为单测覆盖前导零与边界，生产必须走默认的 `randomInt`。
 */
export function generateTemporaryPassword(
  random: (maxExclusive: number) => number = randomInt,
): string {
  return String(random(1_000_000)).padStart(TEMPORARY_PASSWORD_LENGTH, "0");
}
