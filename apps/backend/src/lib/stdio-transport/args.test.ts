import { describe, expect, it } from "vitest";

import { parseStdioArgs } from "./args";

describe("parseStdioArgs", () => {
  it("preserves backslashes in legacy Windows paths", () => {
    const raw = String.raw`C:\DEV\LLM\DebugMCP\dist\debugmcp.js serve --stdio`;

    expect(parseStdioArgs(undefined, raw, "win32")).toEqual([
      String.raw`C:\DEV\LLM\DebugMCP\dist\debugmcp.js`,
      "serve",
      "--stdio",
    ]);
  });

  it("preserves exact argument boundaries through argsJson", () => {
    const args = [
      String.raw`C:\Program Files\DebugMCP\debugmcp.js`,
      "serve",
      "--stdio",
    ];

    expect(parseStdioArgs(JSON.stringify(args), "ignored", "win32")).toEqual(
      args,
    );
  });

  it("rejects malformed argsJson instead of silently falling back", () => {
    expect(() =>
      parseStdioArgs(JSON.stringify({ path: "debugmcp.js" }), "", "win32"),
    ).toThrow("Invalid argsJson");
  });

  it("keeps legacy POSIX shell parsing behavior", () => {
    expect(
      parseStdioArgs(undefined, '"/opt/debug mcp/server.js" --stdio', "linux"),
    ).toEqual(["/opt/debug mcp/server.js", "--stdio"]);
  });
});
