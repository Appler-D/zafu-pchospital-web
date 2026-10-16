-- 邮箱验证码与重置授权基础设施（issue #146）：有效邮箱唯一键 + 挑战 / 计数 / 授权三表。
-- 全部纯增量：加列带 NULL、新表不带数据；不回填假邮箱、不批量标记已验证，
-- 历史身份（QQ / PHONE）与凭据不受影响。

-- 有效邮箱唯一键：仅 type=EMAIL 且生效（未软删除）的行填 `email:{userId}`，撤销时清空；
-- 其它类型与全部历史行保持 NULL（唯一索引允许多个 NULL，不阻塞存量数据）。
-- 配合既有 `(type, identifier_normalized)` 全局唯一，构成「一人一有效邮箱」与
-- 「一邮箱全局只归属一人」两条数据库不变量 —— 应用层「先查再插」挡不住并发。
-- CHECK 约束保证该键只可能出现在 EMAIL 行上（Prisma Schema 无法表达 CHECK，手工维护）。
ALTER TABLE `user_identities`
  ADD COLUMN `active_email_key` VARCHAR(80) NULL;

CREATE UNIQUE INDEX `user_identities_active_email_uq` ON `user_identities`(`active_email_key`);

ALTER TABLE `user_identities`
  ADD CONSTRAINT `user_identities_active_email_key_chk`
  CHECK (`active_email_key` IS NULL OR `type` = 'EMAIL');

-- 验证码挑战：只存 HMAC 摘要（明文只在进程内存里存在过）；待验证地址只放这里，
-- 不写 user_identities（只有验证成功才能写入有效身份）。
CREATE TABLE `email_challenges` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `purpose` VARCHAR(32) NOT NULL,
  `target_email_normalized` VARCHAR(191) NOT NULL,
  `email_identity_id` CHAR(36) NULL,
  `credential_version` INTEGER NULL,
  `code_digest` BINARY(32) NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `finished_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `email_challenges_user_purpose_status_idx`(`user_id`, `purpose`, `status`),
  INDEX `email_challenges_status_expires_idx`(`status`, `expires_at`),
  INDEX `email_challenges_finished_idx`(`finished_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- 邮箱安全计数 / 预算桶：账号 / 目标 / IP 的发信冷却与每日上限、验证失败与阻断、
-- IP 校验请求、全站每日与每分钟预算共表，靠带命名空间的不可逆键摘要区分。
CREATE TABLE `email_security_counters` (
  `bucket_key_digest` BINARY(32) NOT NULL,
  `counter` INTEGER NOT NULL DEFAULT 0,
  `window_started_at` DATETIME(3) NOT NULL,
  `window_expires_at` DATETIME(3) NOT NULL,
  `blocked_until` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `email_security_counters_window_blocked_idx`(`window_expires_at`, `blocked_until`),
  PRIMARY KEY (`bucket_key_digest`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- 一次性重置授权：只存令牌摘要；签发时快照账号与邮件身份资格（含凭据代次），
-- 兑换时逐项复核 —— 管理员重置推进代次后旧授权自动失效。
CREATE TABLE `password_reset_authorizations` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `email_identity_id` CHAR(36) NOT NULL,
  `email_normalized` VARCHAR(191) NOT NULL,
  `credential_version` INTEGER NULL,
  `token_digest` BINARY(32) NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `finished_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `password_reset_authorizations_token_uq`(`token_digest`),
  INDEX `pwd_reset_auth_user_status_idx`(`user_id`, `status`),
  INDEX `pwd_reset_auth_status_expires_idx`(`status`, `expires_at`),
  INDEX `pwd_reset_auth_finished_idx`(`finished_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- AddForeignKey
ALTER TABLE `email_challenges`
  ADD CONSTRAINT `email_challenges_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_challenges`
  ADD CONSTRAINT `email_challenges_email_identity_id_fkey`
  FOREIGN KEY (`email_identity_id`) REFERENCES `user_identities`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `password_reset_authorizations`
  ADD CONSTRAINT `password_reset_authorizations_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `password_reset_authorizations`
  ADD CONSTRAINT `password_reset_authorizations_email_identity_id_fkey`
  FOREIGN KEY (`email_identity_id`) REFERENCES `user_identities`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
