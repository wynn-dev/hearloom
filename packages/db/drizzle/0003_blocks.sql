CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"chain_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "utterances" ADD COLUMN "block_id" uuid;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_user_id_started_at_index" ON "blocks" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "blocks_chain_id_index" ON "blocks" USING btree ("chain_id");--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "utterances_block_id_index" ON "utterances" USING btree ("block_id");--> statement-breakpoint
-- Every existing conversation becomes one block of its own chain, with the same id: its utterances
-- keep their speaker keys, and refine jobs queued by conversation id still find their block.
INSERT INTO "blocks" ("id", "user_id", "chain_id", "started_at", "ended_at", "status", "created_at", "updated_at")
SELECT "id", "user_id", "id", "started_at", "ended_at", "status", "created_at", "updated_at" FROM "conversations";--> statement-breakpoint
UPDATE "utterances" SET "block_id" = "conversation_id" WHERE "conversation_id" IS NOT NULL;
