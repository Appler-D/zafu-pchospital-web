/**
 * 邮箱验证码与重置授权的**集中参数**（任务书 §3.2）。
 *
 * 这些是产品口径常量：调参必须先改任务书 / 契约文档，不允许散落在各调用点。
 * 本文件刻意不 import 任何模块（env 与摘要函数都会引用它，避免循环依赖）。
 */

export const EMAIL_CODE_LENGTH = 6;
/** 验证码有效期 10 分钟；过期即失效（`now >= expiresAt`）。 */
export const EMAIL_CHALLENGE_TTL_MS = 10 * 60 * 1_000;
/** 同一账号 + 用途：15 分钟窗口最多 5 次失败，达到后阻断 15 分钟。 */
export const EMAIL_CODE_FAILURE_WINDOW_MS = 15 * 60 * 1_000;
export const EMAIL_CODE_MAX_FAILURES = 5;
export const EMAIL_CODE_BLOCK_MS = 15 * 60 * 1_000;
/** 同一 IP：15 分钟最多 30 次验证码校验请求。 */
export const EMAIL_VERIFY_IP_WINDOW_MS = 15 * 60 * 1_000;
export const EMAIL_VERIFY_IP_MAX = 30;
/** 发信冷却：同一账号、同一目标邮箱分别至少间隔 60 秒（跨用途合并计数）。 */
export const EMAIL_SEND_COOLDOWN_MS = 60 * 1_000;
/** 每日发信：同一账号 10 封、同一目标 10 封、同一 IP 100 封（跨用途合并，上海自然日）。 */
export const EMAIL_DAILY_ACCOUNT_MAX = 10;
export const EMAIL_DAILY_TARGET_MAX = 10;
export const EMAIL_DAILY_IP_MAX = 100;
/** 全站预算：默认 150 封 / 日（`EMAIL_DAILY_BUDGET` 可配），另设 10 封 / 分钟。 */
export const EMAIL_BUDGET_DAILY_DEFAULT = 150;
export const EMAIL_BUDGET_MINUTE_MAX = 10;
export const EMAIL_BUDGET_MINUTE_WINDOW_MS = 60 * 1_000;
/** 重置授权：32 字节随机令牌、10 分钟、一次性、只允许用户自设密码。 */
export const PASSWORD_RESET_AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
/** 已终结 / 过期挑战与授权保留 7 天后可清理。 */
export const EMAIL_SECURITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** 匿名找回查询前限制；与真实发送桶及登录桶隔离。 */
export const PASSWORD_RECOVERY_REQUEST_IP_MAX = 30;
export const PASSWORD_RECOVERY_REQUEST_IP_WINDOW_MS = 15 * 60_000;
export const PASSWORD_RECOVERY_REQUEST_QQ_COOLDOWN_MS = 60_000;
export const PASSWORD_RECOVERY_REQUEST_QQ_DAILY_MAX = 10;
