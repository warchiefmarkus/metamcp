ALTER TABLE "oauth_access_tokens" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "resource" text;