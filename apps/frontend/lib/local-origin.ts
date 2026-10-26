/**
 * Treat localhost and 127.0.0.1 as equivalent only for the same local
 * protocol and effective port. Do not weaken validation for public domains.
 */
export function resolveBrowserAppUrl(
  configuredUrl: string,
  browserOrigin: string,
  allowedPublicOAuthOrigin?: string,
): string {
  const configured = new URL(configuredUrl);
  const browser = new URL(browserOrigin);

  const isLoopback = (hostname: string) =>
    hostname === "localhost" || hostname === "127.0.0.1";

  // Only the explicitly configured HTTPS OAuth origin may override the local
  // URL when login is performed in the externally hosted authorization flow.
  // Never trust an arbitrary Host / browser origin.
  if (allowedPublicOAuthOrigin && isLoopback(configured.hostname)) {
    const allowed = new URL(allowedPublicOAuthOrigin);
    if (
      allowed.protocol === "https:" &&
      allowed.origin === browser.origin &&
      allowed.pathname === "/" &&
      !allowed.search &&
      !allowed.hash &&
      !allowed.username &&
      !allowed.password
    ) {
      return browser.origin;
    }
  }

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
