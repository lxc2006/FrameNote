CREATE TABLE `conversation_message_details` (
	`message_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`reasoning_content` text,
	`reasoning_duration_seconds` integer,
	`web_sources_json` text,
	`stopped` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
