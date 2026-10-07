CREATE TABLE "voice_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"stream_id" uuid,
	"spoken_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"wake_name" text NOT NULL,
	"heard_as" text NOT NULL,
	"name_score" real NOT NULL,
	"transcript" text NOT NULL,
	"command" text NOT NULL,
	"lang" text,
	"speaker_score" real,
	"status" text NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"http_status" integer,
	"sent_at" timestamp with time zone,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_samples" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"phrase" text,
	"text" text NOT NULL,
	"heard_as" text,
	"name_score" real NOT NULL,
	"speaker_score" real,
	"seconds" real NOT NULL,
	"voiceprint_id" uuid,
	"command_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_commands" ADD CONSTRAINT "voice_commands_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_commands" ADD CONSTRAINT "voice_commands_stream_id_capture_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."capture_streams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_voiceprint_id_voiceprints_id_fk" FOREIGN KEY ("voiceprint_id") REFERENCES "public"."voiceprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_command_id_voice_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."voice_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_commands_user_id_spoken_at_index" ON "voice_commands" USING btree ("user_id","spoken_at");--> statement-breakpoint
CREATE INDEX "voice_samples_user_id_created_at_index" ON "voice_samples" USING btree ("user_id","created_at");