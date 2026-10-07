CREATE TABLE "chains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_samples" (
	"user_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"windows" integer NOT NULL,
	"scores" jsonb NOT NULL,
	CONSTRAINT "context_samples_user_id_at_pk" PRIMARY KEY("user_id","at")
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"kind" text DEFAULT 'unknown' NOT NULL,
	"kind_source" text DEFAULT 'rule' NOT NULL,
	"boundary_source" text DEFAULT 'rule' NOT NULL,
	"title" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chains" ADD CONSTRAINT "chains_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_samples" ADD CONSTRAINT "context_samples_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chains_user_id_started_at_index" ON "chains" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "episodes_user_id_started_at_index" ON "episodes" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "episodes_user_id_updated_at_index" ON "episodes" USING btree ("user_id","updated_at");--> statement-breakpoint
-- Conversations become chains (internal) and episodes (what users see), with the same ids. Their
-- kind is unknown: they were never classified.
INSERT INTO "chains" ("id", "user_id", "started_at", "ended_at", "status", "created_at", "updated_at")
SELECT "id", "user_id", "started_at", "ended_at", CASE WHEN "status" = 'refining' THEN 'closed' ELSE "status" END, "created_at", "updated_at" FROM "conversations";--> statement-breakpoint
INSERT INTO "episodes" ("id", "user_id", "started_at", "ended_at", "title", "created_at", "updated_at")
SELECT "id", "user_id", "started_at", "ended_at", "title", "created_at", "updated_at" FROM "conversations";
