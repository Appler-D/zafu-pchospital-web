/**
 * 内部「当前路径」Header 的名字。
 *
 * 单独成模块：Edge 中间件只需要这个常量，不能连带引入 `next/headers`、Prisma
 * 或发信能力（任务书：不在 Edge 查库 / SMTP）。
 */
export const INTERNAL_PATHNAME_HEADER = "x-internal-pathname";
