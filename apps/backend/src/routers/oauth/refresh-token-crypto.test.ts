import { describe, expect, it } from "vitest";
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, makeRefreshToken, hashRefreshToken, validRefreshTokenFormat } from "./refresh-token-crypto";

describe("OAuth rotating refresh token crypto", () => {
  it("mints high-entropy opaque tokens with a fixed format", () => {
    const one = makeRefreshToken();
    const two = makeRefreshToken();
    expect(one).not.toBe(two);
    expect(validRefreshTokenFormat(one)).toBe(true);
    expect(validRefreshTokenFormat(two)).toBe(true);
    expect(one).toHaveLength("mcp_refresh_".length + 64);
    expect(one).not.toContain("=");
  });
  it("stores only a deterministic irreversible sha256 digest", () => {
    const token = makeRefreshToken();
    const hash = hashRefreshToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashRefreshToken(token)).toBe(hash);
    expect(hashRefreshToken(makeRefreshToken())).not.toBe(hash);
  });
  it("rejects malformed strings and alternate token forms", () => {
    for(const value of [null, 1, "", "mcp_token_" + "x".repeat(64), "mcp_refresh_admin", "mcp_refresh_" + "a".repeat(32), "mcp_refresh_" + "Z".repeat(63)+"=", "mcp_refresh_" + "x".repeat(64)+"extra"])
      expect(validRefreshTokenFormat(value)).toBe(false);
  });
  it("bounds access and refresh lifetimes", () => {
    expect(ACCESS_TTL_SECONDS).toBe(3600);
    expect(REFRESH_TTL_SECONDS).toBe(30*24*3600);
  });
});
