/**
 * RFC 8707 canonical MCP resource for the local endpoint reverse-proxied under
 * https://luckylion.run.place/metamcp/{name}/mcp.
 * Never derive an OAuth audience from an untrusted Host/Forwarded header.
 */

/**
 * Production pilot allows only ChatGPT-managed OAuth redirect destinations.
 * DCR must not turn a private MetaMCP instance into an open redirect/token mint.
 * An exact callback-id URI is provided by the ChatGPT plugin management UI.
 */
export function isAllowedChatGptRedirect(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" ||
        url.port || url.username || url.password || url.search || url.hash) return false;
    return url.pathname === "/connector_platform_oauth_redirect" ||
      /^\/connector\/oauth\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function canonicalMcpResource(resource: unknown, origin: string): string | null {
  if (typeof resource !== "string") return null;
  try {
    const configured = new URL(origin);
    const requested = new URL(resource);
    if (
      requested.origin !== configured.origin ||
      requested.username ||
      requested.password ||
      requested.search ||
      requested.hash ||
      !/^\/metamcp\/[a-zA-Z0-9_-]+\/mcp$/.test(requested.pathname)
    ) return null;
    return requested.href;
  } catch {
    return null;
  }
}

export function resourceForEndpoint(origin: string, endpointName: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(endpointName)) {
    throw new Error("Invalid OAuth MCP endpoint name");
  }
  return new URL(`/metamcp/${endpointName}/mcp`, origin).href;
}

export function resourceMetadataUrl(origin: string, endpointName: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(endpointName)) {
    throw new Error("Invalid OAuth MCP endpoint name");
  }
  return new URL(
    `/.well-known/oauth-protected-resource/metamcp/${endpointName}/mcp`,
    origin,
  ).href;
}
