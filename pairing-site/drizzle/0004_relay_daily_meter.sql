CREATE TABLE `relay_days` (
	`provider` text NOT NULL,
	`scope` text NOT NULL,
	`day` text NOT NULL,
	`egress` integer NOT NULL,
	`ingress` integer NOT NULL,
	`reported` integer NOT NULL,
	`checked` integer NOT NULL,
	PRIMARY KEY(`provider`, `scope`, `day`)
);
