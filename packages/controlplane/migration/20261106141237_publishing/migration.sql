CREATE TABLE "published_domain" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"hostname" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"cf_id" text,
	"status" text NOT NULL,
	"ssl" text NOT NULL,
	"verification" text,
	"error" text,
	"checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_site" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "published_domain_live_hostname_idx" ON "published_domain" ("hostname") WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX "published_domain_project_idx" ON "published_domain" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "published_site_live_name_idx" ON "published_site" ("name") WHERE "deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "published_site_live_project_idx" ON "published_site" ("project_id") WHERE "deleted_at" is null;--> statement-breakpoint
ALTER TABLE "published_domain" ADD CONSTRAINT "published_domain_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "published_site" ADD CONSTRAINT "published_site_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "published_site" ADD CONSTRAINT "published_site_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");