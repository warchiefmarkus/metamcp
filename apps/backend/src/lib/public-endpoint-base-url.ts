/**
 * Assemble a publicly advertised endpoint base from the user-configured
 * external origin and the active Windows/Linux Host reverse-SSH mapping.
 *
 * Local MetaMCP routing remains /metamcp; only advertised public URLs use
 * the ingress prefix selected for this computer.
 */
export function buildPublicEndpointBaseUrl(
  externalBaseUrl: string,
  mappingPublicPath?: string,
): string {
  const rawPath = mappingPublicPath?.trim() || "/metamcp";
  const publicPath = /^\/[a-zA-Z0-9_-]+$/.test(rawPath)
    ? rawPath
    : "/metamcp";
  const url = new URL(externalBaseUrl.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("External tunnel base URL must use http or https");
  }
  if (url.search || url.hash) {
    throw new Error("External tunnel base URL cannot contain a query or fragment");
  }

  const configuredPath = url.pathname.replace(/\/+$/, "");
  const existingSegments = configuredPath.split("/").filter(Boolean);
  const lastSegment = existingSegments[existingSegments.length - 1] || "";

  // A previously saved device-specific mapping is an ingress prefix, not
  // an application route. Replace it if the machine mapping changes.
  if (/^metamcp(?:pct|thp|yoga)?$/.test(lastSegment)) {
    existingSegments.pop();
  } else if (configuredPath === publicPath) {
    return url.toString().replace(/\/+$/, "");
  }

  url.pathname = "/" + [...existingSegments, publicPath.slice(1)].join("/");
  return url.toString().replace(/\/+$/, "");
}
