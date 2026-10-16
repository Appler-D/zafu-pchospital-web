-- 学号 / 班级（issue #147）：邀请码注册与公开招募两处新增两个必填字段。
-- 字段名与长度和成员档案（member_profiles.student_id / class_name）一致；
-- 两列都可空：迁移前的历史报名没有该信息，保持 NULL、不批量回填，新版应用层保证必填。
-- 仅加列，不改动既有列；不建索引 / 唯一约束（学号不是身份，不做唯一性校验）。

ALTER TABLE `join_applications`
  ADD COLUMN `class_name` VARCHAR(80) NULL,
  ADD COLUMN `student_id` VARCHAR(32) NULL;
