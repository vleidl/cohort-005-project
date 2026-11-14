ALTER TABLE `coupons` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `decline_reason` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `refund_state` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `refund_state_changed_at` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `discretionary` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `refunds` ADD `raised_by_user_id` integer REFERENCES users(id);