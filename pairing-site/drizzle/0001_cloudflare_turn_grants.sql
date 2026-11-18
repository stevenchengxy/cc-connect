CREATE TABLE `turn_grants` (
	`room` text NOT NULL,
	`role` text NOT NULL,
	`lease` text NOT NULL,
	`retry_at` integer NOT NULL,
	`expires` integer DEFAULT 0 NOT NULL,
	`payload` text,
	PRIMARY KEY(`room`, `role`),
	FOREIGN KEY (`room`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
