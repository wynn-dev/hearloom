-- Notifications are no longer held: anything still waiting would never be sent.
UPDATE "notifications" SET "status" = 'suppressed', "status_reason" = 'expired' WHERE "status" = 'held' OR ("status" = 'pending' AND "created_at" < now() - interval '1 hour');--> statement-breakpoint
-- Snooze was removed (it never did anything).
UPDATE "notifications" SET "feedback" = NULL WHERE "feedback" = 'snoozed';--> statement-breakpoint
DROP INDEX "notifications_status_scheduled_for_index";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "thread_id";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "deliver_when";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "scheduled_for";