CREATE TABLE "user_model" (
	"user_id" text,
	"provider_id" text,
	"model_id" text,
	"visible" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_model_pkey" PRIMARY KEY("user_id","provider_id","model_id")
);
--> statement-breakpoint
ALTER TABLE "user_model" ADD CONSTRAINT "user_model_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");