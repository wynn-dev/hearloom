ALTER TABLE "voice_commands" ADD COLUMN "reply_status" text;--> statement-breakpoint
ALTER TABLE "voice_commands" ADD COLUMN "reply_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_commands" ADD COLUMN "reply_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_commands" ADD COLUMN "replied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_commands" ADD COLUMN "reply_outcome" text;