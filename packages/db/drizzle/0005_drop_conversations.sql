ALTER TABLE "utterances" DROP CONSTRAINT "utterances_conversation_id_conversations_id_fk";--> statement-breakpoint
DROP INDEX "utterances_conversation_id_index";--> statement-breakpoint
ALTER TABLE "utterances" DROP COLUMN "conversation_id";--> statement-breakpoint
DROP TABLE "conversations";--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;
