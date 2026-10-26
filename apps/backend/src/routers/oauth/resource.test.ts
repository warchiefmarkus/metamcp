import { describe, expect, it } from "vitest";
import { canonicalMcpResource, isAllowedChatGptRedirect, resourceForEndpoint, resourceMetadataUrl } from "./resource";

const base = "https://luckylion.run.place";

describe("ChatGPT OAuth redirect allowlist", () => {
  it("accepts ChatGPT platform stable and callback-specific URIs", () => {
    expect(isAllowedChatGptRedirect("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(isAllowedChatGptRedirect("https://chatgpt.com/connector/oauth/1234567890abcdef")).toBe(true);
  });
  it.each([
    "https://evil.example/connector/oauth/1234567890abcdef",
    "https://chatgpt.com.evil.example/connector/oauth/1234567890abcdef",
    "http://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/1234567890abcdef?next=evil",
    "https://chatgpt.com/other",
  ])("rejects untrusted callback %s", url => {
    expect(isAllowedChatGptRedirect(url)).toBe(false);
  });
});

describe("MCP OAuth resource indicators", () => {
  const valid = base + "/metamcp/Public/mcp";
  it("accepts an exact endpoint identifier", () => {
    expect(canonicalMcpResource(valid, base)).toBe(valid);
    expect(resourceForEndpoint(base, "Public")).toBe(valid);
    expect(resourceMetadataUrl(base, "Public")).toBe(
      base + "/.well-known/oauth-protected-resource/metamcp/Public/mcp",
    );
  });
  it.each([
    undefined, "", "not-a-url", base + "/metamcp/Public/mcp?api_key=secret",
    base + "/metamcp/Public/mcp#fragment", "http://luckylion.run.place/metamcp/Public/mcp",
    base + "/metamcp/Other/sse", base + "/metamcp/Public/mcp/",
    "https://other.example/metamcp/Public/mcp", base + "/metamcp/%2e%2e/mcp",
  ])("rejects malformed or off-origin resources: %s", resource => {
    expect(canonicalMcpResource(resource, base)).toBeNull();
  });
  it("does not allow endpoint traversal", () => {
    expect(() => resourceForEndpoint(base, "../Public")).toThrow();
  });
});
