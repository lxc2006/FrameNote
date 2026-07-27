CREATE TABLE `conversation_transcripts` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`transcript_json` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
