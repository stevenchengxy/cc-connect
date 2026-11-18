CREATE TABLE `relay_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`room` text NOT NULL,
	`role` text NOT NULL,
	`account` text NOT NULL,
	`key_id` text NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	`state` text NOT NULL,
	`username` text,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `relay_leases_room` ON `relay_leases` (`room`,`role`,`expires`);--> statement-breakpoint
CREATE INDEX `relay_leases_owner` ON `relay_leases` (`account`,`expires`);--> statement-breakpoint
CREATE INDEX `relay_leases_time` ON `relay_leases` (`created`);--> statement-breakpoint
CREATE INDEX `relay_leases_expiry` ON `relay_leases` (`expires`);--> statement-breakpoint
CREATE TABLE `relay_meters` (
	`scope` text NOT NULL,
	`period_start` text NOT NULL,
	`checked` integer NOT NULL,
	`high_egress` integer NOT NULL,
	`ever_reported` integer NOT NULL,
	PRIMARY KEY(`scope`, `period_start`)
);
--> statement-breakpoint
CREATE TABLE `relay_quotas` (
	`scope` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'off' NOT NULL,
	`limit_bytes` integer DEFAULT 0 NOT NULL,
	`max_concurrent` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
