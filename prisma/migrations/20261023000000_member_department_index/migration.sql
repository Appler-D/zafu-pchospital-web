-- 成员列表按部门列筛选（issue #210）：为 member_profiles.department 补索引，
-- 避免列级筛选在该列上做全表扫描。
CREATE INDEX `member_profiles_department_idx` ON `member_profiles`(`department`);
