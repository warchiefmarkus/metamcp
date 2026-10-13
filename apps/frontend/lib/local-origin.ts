/**
 * Treat localhost and 127.0.0.1 as equivalent only for the same local
 * protocol and effective port. Do not weaken validation for public domains.
 */
export function resolveBrowserAppUrl(configuredUrl: string, browserOrigin: string): string {
  const configured = new URL(configuredUrl);
  const browser = new URL(browserOrigin);

  const isLoopback = (hostname: string) =>
    hostname === "localhost" || hostname === "127.0.0.1";

  if (
    isLoopback(configured.hostname) &&
    isLoopback(browser.hostname) &&
    configured.protocol === browser.protocol &&
    configured.port === browser.port &&
    configured.pathname === "/" &&
    !configured.search &&
    !configured.hash
  ) {
    return browser.origin;
  }

  return configuredUrl;
}
