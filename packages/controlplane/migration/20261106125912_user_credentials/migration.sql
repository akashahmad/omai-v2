CREATE TABLE "user_credential" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"label" text NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "user_credential_user_idx" ON "user_credential" ("user_id");--> statement-breakpoint
ALTER TABLE "user_credential" ADD CONSTRAINT "user_credential_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");