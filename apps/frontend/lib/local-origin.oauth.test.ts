import { describe, expect, it } from "vitest";
import { resolveBrowserAppUrl } from "./local-origin";

describe("public OAuth browser origin", () => {
  const local = "http://localhost:12008";
  const external = "https://luckylion.run.place";

  it("retains local loopback behavior without public OAuth", () => {
    expect(resolveBrowserAppUrl(local, "http://127.0.0.1:12008")).toBe(
      "http://127.0.0.1:12008",
    );
  });

  it("uses only the explicitly authorized external HTTPS origin", () => {
    expect(resolveBrowserAppUrl(local, external, external)).toBe(external);
    expect(
      resolveBrowserAppUrl(local, "https://evil.example", external),
    ).toBe(local);
  });

  it("does not accept an insecure or path-bearing public override", () => {
    expect(resolveBrowserAppUrl(local, "http://evil.example", "http://evil.example")).toBe(local);
    expect(resolveBrowserAppUrl(local, external, external + "/metamcp")).toBe(local);
  });

  it("does not redirect an already configured public service", () => {
    expect(resolveBrowserAppUrl("https://example.net", external, external)).toBe("https://example.net");
  });
});
