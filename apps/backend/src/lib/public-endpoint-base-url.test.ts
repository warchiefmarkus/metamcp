import { describe, expect, it } from "vitest";

import { buildPublicEndpointBaseUrl } from "./public-endpoint-base-url";

describe("public endpoint URL routing", () => {
  it.each([
    ["/metamcp", "https://luckylion.run.place/metamcp"],
    ["/metamcppct", "https://luckylion.run.place/metamcppct"],
    ["/metamcpthp", "https://luckylion.run.place/metamcpthp"],
    ["/metamcpyoga", "https://luckylion.run.place/metamcpyoga"],
  ])("uses host mapping %s", (path, expected) => {
    expect(buildPublicEndpointBaseUrl("https://luckylion.run.place/", path)).toBe(expected);
  });

  it("uses the legacy route without a Windows Host", () => {
    expect(buildPublicEndpointBaseUrl("https://luckylion.run.place")).toBe(
      "https://luckylion.run.place/metamcp",
    );
  });

  it("avoids duplicate prefixes and replaces a previous machine mapping", () => {
    expect(buildPublicEndpointBaseUrl(
      "https://luckylion.run.place/metamcp",
      "/metamcpthp",
    )).toBe("https://luckylion.run.place/metamcpthp");
    expect(buildPublicEndpointBaseUrl(
      "https://luckylion.run.place/metamcpthp",
      "/metamcpthp",
    )).toBe("https://luckylion.run.place/metamcpthp");
  });

  it("preserves upstream hosting subpaths", () => {
    expect(buildPublicEndpointBaseUrl(
      "https://example.org/proxy",
      "/metamcpthp",
    )).toBe("https://example.org/proxy/metamcpthp");
  });

  it("rejects unsafe mapping prefixes and falls back to the local default", () => {
    expect(buildPublicEndpointBaseUrl(
      "https://example.org",
      "//example.com/evil",
    )).toBe("https://example.org/metamcp");
  });

  it("rejects malformed public base URLs", () => {
    expect(() => buildPublicEndpointBaseUrl("https://example.org/?secret=1")).toThrow();
    expect(() => buildPublicEndpointBaseUrl("javascript:alert(1)")).toThrow();
  });
});
