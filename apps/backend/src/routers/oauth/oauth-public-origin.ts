/**
 * External HTTPS issuer for OAuth, independent from the Windows Host local APP_URL.
 * Not enabled by default; activate only when the public Nginx routes are deployed.
 */
export function configuredOAuthPublicOrigin(): string | undefined {
  const raw = process.env.OAUTH_PUBLIC_BASE_URL?.trim();
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OAUTH_PUBLIC_BASE_URL must be a valid absolute URL");
  }

  const localDev =
    process.env.NODE_ENV !== "production" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");

  if (
    (url.protocol !== "https:" && !(localDev && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "OAUTH_PUBLIC_BASE_URL must be a secure origin without a path, query, or credentials",
    );
  }

  return url.origin;
}
