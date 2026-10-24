CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`item_id` text,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`meta` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_project_idx` ON `activity` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_item_idx` ON `activity` (`item_id`);--> statement-breakpoint
CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text,
	`focus` text NOT NULL,
	`guidance` text DEFAULT '' NOT NULL,
	`count` integer NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`strengths` text DEFAULT '[]' NOT NULL,
	`risks` text DEFAULT '[]' NOT NULL,
	`health` text,
	`suggestion_count` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`effort` text,
	`impact` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`acceptance_criteria` text DEFAULT '[]' NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`rationale` text,
	`affected_files` text DEFAULT '[]' NOT NULL,
	`analysis_id` text,
	`plan` text,
	`position` real DEFAULT 0 NOT NULL,
	`snoozed_until` text,
	`due_date` text,
	`decision_reason` text,
	`branch` text,
	`worktree_path` text,
	`last_run_id` text,
	`session_id` text,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`pr_number` integer,
	`pr_url` text,
	`pr_state` text,
	`pr_is_draft` integer,
	`pr_review_decision` text,
	`pr_checks` text,
	`pr_additions` integer,
	`pr_deletions` integer,
	`pr_changed_files` integer,
	`pr_merged_at` text,
	`pr_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `items_project_status_idx` ON `items` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `items_project_number_idx` ON `items` (`project_id`,`number`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`key_prefix` text NOT NULL,
	`path` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`color` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`stack` text NOT NULL,
	`git` text NOT NULL,
	`settings` text NOT NULL,
	`health` text,
	`next_item_number` integer DEFAULT 1 NOT NULL,
	`last_analyzed_at` text,
	`last_scanned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`data` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_run_idx` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`item_id` text,
	`analysis_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`session_id` text,
	`cwd` text NOT NULL,
	`branch` text,
	`summary` text,
	`error` text,
	`cost_usd` real,
	`duration_ms` integer,
	`num_turns` integer,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_item_idx` ON `runs` (`item_id`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
