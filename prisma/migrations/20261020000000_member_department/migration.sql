-- 存量成员统一归入维修部；历史报名未记录录取部门，保持 NULL。
ALTER TABLE `member_profiles`
  ADD COLUMN `department` VARCHAR(32) NOT NULL DEFAULT 'REPAIR',
  ADD CONSTRAINT `member_profiles_department_check`
    CHECK (`department` IN ('REPAIR', 'PUBLICITY', 'OFFICE'));

ALTER TABLE `join_applications`
  ADD COLUMN `admitted_department` VARCHAR(32) NULL,
  ADD CONSTRAINT `join_applications_admitted_department_check`
    CHECK (`admitted_department` IS NULL OR `admitted_department` IN ('REPAIR', 'PUBLICITY', 'OFFICE'));
