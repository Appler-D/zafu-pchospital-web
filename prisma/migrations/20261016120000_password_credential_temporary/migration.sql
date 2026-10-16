-- 管理员临时密码恢复（issue #113）：password_credentials 三列。
-- 历史兼容：三列都可空 / 默认 0，迁移前不区分临时凭据，保持 NULL 与 0，不批量回填；
-- 应用层以 temporary_expires_at 非空判定临时凭据，历史初始密码（QQ 后六位）不受影响。
-- credential_version 用于「验密 → 建 Session」之间的代次复核，防止并发重置后
-- 旧校验结果给新一代凭据建立有效会话。
-- 仅加列，不改动既有列，不建索引 / 唯一约束。

ALTER TABLE `password_credentials`
  ADD COLUMN `temporary_expires_at` DATETIME(3) NULL,
  ADD COLUMN `temporary_consumed_at` DATETIME(3) NULL,
  ADD COLUMN `credential_version` INT NOT NULL DEFAULT 0;
