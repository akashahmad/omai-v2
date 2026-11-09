CREATE TABLE "model_usage" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text,
	"status" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"bytes" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_model" (
	"provider_id" text,
	"model_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_model_pkey" PRIMARY KEY("provider_id","model_id")
);
--> statement-breakpoint
CREATE INDEX "model_usage_user_idx" ON "model_usage" ("user_id","at");--> statement-breakpoint
CREATE INDEX "model_usage_project_idx" ON "model_usage" ("project_id");