CREATE TABLE `messages` (
	`room` text NOT NULL,
	`sender` text NOT NULL,
	`seq` integer NOT NULL,
	`bytes` blob NOT NULL,
	`size` integer NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`room`, `sender`, `seq`),
	FOREIGN KEY (`room`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`enrollment` text NOT NULL,
	`viewer` text,
	`source` text NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	`closed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rooms_expiry` ON `rooms` (`expires`);--> statement-breakpoint
CREATE INDEX `rooms_source` ON `rooms` (`source`,`created`);