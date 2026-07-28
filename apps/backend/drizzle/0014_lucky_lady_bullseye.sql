CREATE TYPE "public"."mcp_connection_mode" AS ENUM('SESSION', 'PERSISTENT');--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "connection_mode" "mcp_connection_mode" DEFAULT 'SESSION' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "idle_timeout_ms" integer DEFAULT 1800000 NOT NULL;--> statement-breakpoint
UPDATE "mcp_servers"
SET "connection_mode" = 'PERSISTENT',
    "idle_timeout_ms" = 1800000
WHERE lower("name") = 'playwright'
  AND "type" = 'STDIO';