CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"refresh_hash" text NOT NULL UNIQUE,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"vm_state" text NOT NULL,
	"vm_id" text,
	"vm_host" text,
	"vm_home" text,
	"vm_error" text,
	"project_token_hash" text NOT NULL,
	"last_session_title" text,
	"last_session_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"username" text NOT NULL UNIQUE,
	"email" text NOT NULL UNIQUE,
	"password_hash" text NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"permissions" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_live_name_idx" ON "project" ("user_id",lower("name")) WHERE "deleted_at" is null;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");