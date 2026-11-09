CREATE TABLE "project_thumbnail" (
	"project_id" text PRIMARY KEY,
	"hash" text NOT NULL,
	"data" bytea NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_thumbnail" ADD CONSTRAINT "project_thumbnail_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");