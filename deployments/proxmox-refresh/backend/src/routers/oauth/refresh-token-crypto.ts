import { createHash, randomBytes } from "node:crypto";

export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const ACCESS_TTL_SECONDS = 3600;

export function makeRefreshToken(): string {
  return "mcp_refresh_" + randomBytes(48).toString("base64url");
}
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
export function validRefreshTokenFormat(token: unknown): token is string {
  return typeof token === "string" && /^mcp_refresh_[A-Za-z0-9_-]{64}$/.test(token);
}
