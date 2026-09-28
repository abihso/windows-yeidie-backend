CREATE TABLE "message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_body_check";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_url" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_mime" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_size" integer;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_reactions_message" ON "message_reactions" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_content_check" CHECK (length(trim("messages"."body")) > 0 or "messages"."attachment_url" is not null);