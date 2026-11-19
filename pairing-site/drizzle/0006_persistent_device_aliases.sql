CREATE TABLE `device_aliases` (
	`alias` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`manager_digest` text NOT NULL,
	`room` text,
	`room_created` integer DEFAULT 0 NOT NULL,
	`envelope` text,
	`retired` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_aliases_room` ON `device_aliases` (`room`);