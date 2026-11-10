CREATE TABLE "shared_session" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text NOT NULL,
	"title" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shared_session_project_session_idx" ON "shared_session" ("project_id","session_id");--> statement-breakpoint
ALTER TABLE "shared_session" ADD CONSTRAINT "shared_session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "shared_session" ADD CONSTRAINT "shared_session_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");