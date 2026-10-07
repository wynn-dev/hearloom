-- Agent tokens are all full access now (read + episode edits): existing read-only tokens included.
ALTER TABLE "api_tokens" DROP COLUMN "scopes";--> statement-breakpoint
-- Only agent notifications used these (rationale, Useful / Not useful, replies, responses for changes_since).
ALTER TABLE "notifications" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "feedback";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "reply_text";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "responded_at";