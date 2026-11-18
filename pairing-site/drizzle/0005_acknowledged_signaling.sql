ALTER TABLE `messages` ADD `served` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_pending` ON `messages` (`room`,`sender`,`seq`) WHERE size > 0;