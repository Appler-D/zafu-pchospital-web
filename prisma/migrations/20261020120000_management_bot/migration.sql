-- Additive only: preserve existing activities, sessions, registrations and audit history.
ALTER TABLE `repair_activities` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;

CREATE TABLE `bot_operations` (
  `principal_id` VARCHAR(64) NOT NULL,
  `operation_id` CHAR(36) NOT NULL,
  `request_digest` CHAR(64) NOT NULL,
  `result` JSON NOT NULL,
  `request_id` VARCHAR(80) NOT NULL,
  `requested_by` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`principal_id`, `operation_id`),
  INDEX `bot_operations_created_idx` (`created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
