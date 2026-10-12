-- 维修记录参与人（issue #114）：一条记录可有多名参与成员。
-- 时长不分人：记录上的 duration_minutes 对全部参与者生效，本表不存时长。
-- 回填：存量记录各补一行（创建人本人、sort_order = 0）——统计口径与改造前完全一致，
-- 且此后「每条记录必有 ≥1 参与行」成为不变量（含软删除记录，一并回填）。
-- 建表 + INSERT..SELECT 均为一次性前向操作；不删改任何既有列。

CREATE TABLE `repair_record_participants` (
  `id` CHAR(36) NOT NULL,
  `repair_record_id` CHAR(36) NOT NULL,
  `member_profile_id` CHAR(36) NOT NULL,
  `sort_order` INTEGER NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `repair_record_participants_record_member_uq`(`repair_record_id`, `member_profile_id`),
  INDEX `repair_record_participants_member_record_idx`(`member_profile_id`, `repair_record_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

ALTER TABLE `repair_record_participants` ADD CONSTRAINT `repair_record_participants_repair_record_id_fkey` FOREIGN KEY (`repair_record_id`) REFERENCES `repair_records`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `repair_record_participants` ADD CONSTRAINT `repair_record_participants_member_profile_id_fkey` FOREIGN KEY (`member_profile_id`) REFERENCES `member_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO `repair_record_participants` (`id`, `repair_record_id`, `member_profile_id`, `sort_order`, `created_at`)
SELECT UUID(), `id`, `member_profile_id`, 0, `created_at` FROM `repair_records`;
