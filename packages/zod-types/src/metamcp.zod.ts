import { z } from "zod";

import {
  DEFAULT_MCP_IDLE_TIMEOUT_MS,
  McpConnectionModeEnum,
  McpServerTypeEnum,
} from "./mcp-servers.zod";
import { OAuthTokensSchema } from "./oauth.zod";

export const IOTypeSchema = z.enum(["overlapped", "pipe", "ignore", "inherit"]);

export const ServerParametersSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  description: z.string(),
  type: McpServerTypeEnum.optional().default(McpServerTypeEnum.Enum.STDIO),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).nullable().optional(),
  env: z.record(z.string()).nullable().optional(),
  stderr: IOTypeSchema.optional().default(IOTypeSchema.Enum.ignore),
  url: z.string().nullable().optional(),
  created_at: z.string(),
  status: z.string(),
  error_status: z.string().optional(),
  oauth_tokens: OAuthTokensSchema.nullable().optional(),
  bearerToken: z.string().nullable().optional(),
  headers: z.record(z.string()).nullable().optional(),
  connectionMode: McpConnectionModeEnum.default(
    McpConnectionModeEnum.Enum.SESSION,
  ),
  idleTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .default(DEFAULT_MCP_IDLE_TIMEOUT_MS),
});

export type ServerParameters = z.infer<typeof ServerParametersSchema>;
