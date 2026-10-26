import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredOAuthPublicOrigin } from "./oauth-public-origin";

afterEach(() => vi.unstubAllEnvs());

describe("OAuth public origin configuration", () => {
  it("leaves current APP_URL behavior intact when not configured", () => {
    vi.stubEnv("APP_URL", "http://localhost:12008");
    vi.stubEnv("OAUTH_PUBLIC_BASE_URL", "");
    expect(configuredOAuthPublicOrigin()).toBeUndefined();
  });

  it("normalizes the external HTTPS issuer", () => {
    vi.stubEnv("OAUTH_PUBLIC_BASE_URL", "https://luckylion.run.place/");
    expect(configuredOAuthPublicOrigin()).toBe("https://luckylion.run.place");
  });

  it.each([
    "http://luckylion.run.place",
    "https://luckylion.run.place/metamcp",
    "https://luckylion.run.place/?api_key=secret",
    "https://user:pass@luckylion.run.place",
  ])("rejects unsafe public origin: %s", (value) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OAUTH_PUBLIC_BASE_URL", value);
    expect(() => configuredOAuthPublicOrigin()).toThrow("OAUTH_PUBLIC_BASE_URL");
  });

  it("permits loopback HTTP only in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OAUTH_PUBLIC_BASE_URL", "http://localhost:12008");
    expect(configuredOAuthPublicOrigin()).toBe("http://localhost:12008");
  });

  it("rejects invalid absolute URL syntax", () => {
    vi.stubEnv("OAUTH_PUBLIC_BASE_URL", "not a URL");
    expect(() => configuredOAuthPublicOrigin()).toThrow("OAUTH_PUBLIC_BASE_URL");
  });
});
