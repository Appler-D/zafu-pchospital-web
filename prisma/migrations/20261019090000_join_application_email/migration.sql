-- Notification address only; historical applications remain NULL.
ALTER TABLE `join_applications` ADD COLUMN `email` VARCHAR(191) NULL;
