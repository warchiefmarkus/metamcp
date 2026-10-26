import { parse as shellParseArgs } from "shell-quote";

export function parseStdioArgs(
  argsJson: unknown,
  legacyArgs: unknown,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (typeof argsJson === "string" && argsJson.length > 0) {
    const parsed: unknown = JSON.parse(argsJson);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((arg) => typeof arg === "string")
    ) {
      throw new Error("Invalid argsJson: expected a JSON array of strings");
    }
    return parsed;
  }

  const rawLegacyArgs = typeof legacyArgs === "string" ? legacyArgs : "";
  const shellArgs =
    platform === "win32"
      ? rawLegacyArgs.replace(/\\/g, "\\\\")
      : rawLegacyArgs;

  return shellParseArgs(shellArgs) as string[];
}
