CREATE TABLE `account_sessions` (
	`digest` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`account`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_sessions_owner` ON `account_sessions` (`account`,`expires`);--> statement-breakpoint
CREATE INDEX `account_sessions_expiry` ON `account_sessions` (`expires`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_scheme` text NOT NULL,
	`invite` text,
	`created` integer NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_username_unique` ON `accounts` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_single_invite` ON `accounts` (`invite`);--> statement-breakpoint
CREATE TABLE `admin_setup` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`admin` text NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`admin`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `auth_rate` (
	`bucket` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_rate_expiry` ON `auth_rate` (`expires`);--> statement-breakpoint
CREATE TABLE `account_invites` (
	`digest` text PRIMARY KEY NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_invites_expiry` ON `account_invites` (`expires`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `host_account` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `host_session` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `viewer_account` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `viewer_session` text;--> statement-breakpoint
CREATE INDEX `rooms_host_account` ON `rooms` (`host_account`);--> statement-breakpoint
CREATE INDEX `rooms_viewer_account` ON `rooms` (`viewer_account`);