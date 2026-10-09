CREATE TABLE "link_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phones" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "link_codes_code_hash_index" ON "link_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "link_codes_user_id_index" ON "link_codes" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "phones" ADD CONSTRAINT "phones_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phones_session_id_index" ON "phones" USING btree ("session_id");--> statement-breakpoint
-- Session tokens are stored as their SHA-256 (hex), as the server now looks them up (apps/server/src/auth.ts,
-- hashSessionTokens). Clients keep the token they have, so nobody is signed out. better-auth tokens are 32
-- characters; a 64-character token is already a hash.
UPDATE "session" SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex') WHERE length("token") <> 64;
