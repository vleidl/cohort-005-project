-- Coupons become Seats and the team admin becomes the Team Sponsor (see GLOSSARY.md).
-- Renamed in place so existing rows survive.
ALTER TABLE `coupons` RENAME TO `seats`;--> statement-breakpoint
ALTER TABLE `seats` RENAME COLUMN `redeemed_by_user_id` TO `claimed_by_user_id`;--> statement-breakpoint
ALTER TABLE `seats` RENAME COLUMN `redeemed_at` TO `claimed_at`;--> statement-breakpoint
DROP INDEX `coupons_code_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `seats_code_unique` ON `seats` (`code`);--> statement-breakpoint
UPDATE `team_members` SET `role` = 'sponsor' WHERE `role` = 'admin';
