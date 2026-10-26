/**
 * Dynamic Client Registration may request refresh_token by default even when
 * this AS only supports authorization_code. RFC 7591 returns the approved
 * registration metadata, not an unsupported grant claim.
 */
export function permittedDcrGrantTypes(value: unknown): string[] | null {
  if (value === undefined) return ["authorization_code"];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    return null;
  // Reject unsupported authentication grants instead of silently ignoring them.
  if (value.some((v) => v !== "authorization_code" && v !== "refresh_token"))
    return null;
  if (!value.includes("authorization_code")) return null;
  // No refresh_token grant is advertised until the token endpoint actually
  // supports issuing and rotating refresh tokens.
  return ["authorization_code"];
}
