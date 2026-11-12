PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`reason` text NOT NULL,
	`amount_refunded` integer NOT NULL,
	`refunded_at` text NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
DROP TABLE `refunds`;--> statement-breakpoint
ALTER TABLE `__new_refunds` RENAME TO `refunds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `refunds_purchase_idx` ON `refunds` (`purchase_id`);--> statement-breakpoint
ALTER TABLE `coupons` ADD `refund_id` integer REFERENCES refunds(id);