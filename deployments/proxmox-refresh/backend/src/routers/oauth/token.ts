import express from "express";

import logger from "@/utils/logger";

import { oauthRepository } from "../../db/repositories";
import {
  generateSecureAccessToken,
  rateLimitToken,
  getBaseUrl,
} from "./utils";
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, issueInitialRefresh, makeRefreshToken, rotateRefresh, revokeRefresh } from "./refresh";

const tokenRouter = express.Router();

const ACCESS_TOKEN_EXPIRY = ACCESS_TTL_SECONDS;
const REFRESH_TOKEN_EXPIRY = REFRESH_TTL_SECONDS;

// Resource is bound to the refresh family. Clients may supply an MCP resource
// URI, otherwise use the issuing server's canonical default endpoint.
function refreshResource(req: express.Request): string | null {
  const value = req.body?.resource;
  if (value === undefined || value === null || value === "") {
    return getBaseUrl(req).replace(/\/$/, "") + "/metamcp/Proxmox/mcp";
  }
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username || url.password || url.search || url.hash ||
        !/^\/metamcp\/[^/]+\/mcp$/.test(url.pathname))
      return null;
    return url.toString();
  } catch { return null; }
}

/** Create a rotating refresh pair; legacy plaintext token fields stay unused. */
async function issueTokenPair(
  clientId: string, userId: string, scope: string, resource: string,
) {
  const accessToken = generateSecureAccessToken();
  const refreshToken = makeRefreshToken();
  await issueInitialRefresh(clientId, userId, scope, resource, refreshToken, accessToken);
  return { accessToken, refreshToken };
}

/**
 * OAuth 2.0 Token Endpoint
 * Handles token exchange requests from MCP clients
 * Supports authorization_code and refresh_token grant types
 */
tokenRouter.post("/oauth/token", rateLimitToken, async (req, res) => {
  try {
    // Check if body was parsed correctly
    if (!req.body || typeof req.body !== "object") {
      logger.error("Token endpoint: req.body is undefined or invalid", {
        bodyType: typeof req.body,
        contentType: req.headers["content-type"],
        method: req.method,
      });
      return res.status(400).json({
        error: "invalid_request",
        error_description:
          "Request body is missing or malformed. Ensure Content-Type is application/json or application/x-www-form-urlencoded",
      });
    }

    const { grant_type } = req.body;

    if (grant_type === "refresh_token") {
      return handleRefreshTokenGrant(req, res);
    }

    if (grant_type === "authorization_code") {
      return handleAuthorizationCodeGrant(req, res);
    }

    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description:
        "Supported grant types: authorization_code, refresh_token",
    });
  } catch (error) {
    logger.error("Error in OAuth token endpoint:", error);
    res.status(500).json({
      error: "server_error",
      error_description: "Internal server error",
    });
  }
});

/**
 * Handle grant_type=authorization_code
 */
async function handleAuthorizationCodeGrant(
  req: express.Request,
  res: express.Response,
) {
  const { code, redirect_uri, client_id, code_verifier } = req.body;

  // Validate authorization code
  if (!code) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing authorization code",
    });
  }

  // Look up the authorization code
  const codeData = await oauthRepository.getAuthCode(code);
  if (!codeData) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Invalid or expired authorization code",
    });
  }

  // Check if code has expired (10 minutes)
  if (Date.now() > codeData.expires_at.getTime()) {
    await oauthRepository.deleteAuthCode(code);
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Authorization code has expired",
    });
  }

  // Validate client_id and redirect_uri match the original request
  if (codeData.client_id !== client_id) {
    return res.status(400).json({
      error: "invalid_client",
      error_description: "Client ID does not match",
    });
  }

  if (codeData.redirect_uri !== redirect_uri) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Redirect URI does not match",
    });
  }

  // Validate client_id against registered clients
  const clientData = await oauthRepository.getClient(client_id);
  if (!clientData) {
    return res.status(400).json({
      error: "invalid_client",
      error_description: "Client not found or not registered",
    });
  }

  // Validate client authentication based on registered auth method
  if (clientData.token_endpoint_auth_method === "client_secret_basic") {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return res.status(401).json({
        error: "invalid_client",
        error_description: "Client authentication required via Basic auth",
      });
    }

    const credentials = Buffer.from(
      authHeader.substring(6),
      "base64",
    ).toString();
    const [authClientId, authClientSecret] = credentials.split(":");

    if (
      authClientId !== client_id ||
      authClientSecret !== clientData.client_secret
    ) {
      return res.status(401).json({
        error: "invalid_client",
        error_description: "Invalid client credentials",
      });
    }
  } else if (clientData.token_endpoint_auth_method === "client_secret_post") {
    const { client_secret } = req.body;
    if (!client_secret || client_secret !== clientData.client_secret) {
      return res.status(401).json({
        error: "invalid_client",
        error_description: "Invalid client secret",
      });
    }
  }
  // For "none" auth method, no additional validation needed

  // OAuth 2.1 Security: PKCE is mandatory for all clients
  if (!codeData.code_challenge) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description:
        "Authorization code was not issued with PKCE challenge",
    });
  }

  if (!code_verifier) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "PKCE code verifier is required",
    });
  }

  // Verify code challenge
  const crypto = await import("crypto");
  let challengeFromVerifier: string;

  if (codeData.code_challenge_method === "S256") {
    const hash = crypto.createHash("sha256").update(code_verifier).digest();
    challengeFromVerifier = hash.toString("base64url");
  } else if (codeData.code_challenge_method === "plain") {
    challengeFromVerifier = code_verifier;
  } else {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Unsupported code challenge method",
    });
  }

  if (challengeFromVerifier !== codeData.code_challenge) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "PKCE verification failed",
    });
  }

  // Code is valid, delete it (authorization codes are single-use)
  await oauthRepository.deleteAuthCode(code);

  // Issue access token + refresh token
  const requestedResource = refreshResource(req);
  if (!requestedResource) return res.status(400).json({ error: "invalid_target" });
  const { accessToken, refreshToken } = await issueTokenPair(
    codeData.client_id,
    codeData.user_id,
    codeData.scope,
    requestedResource,
  );

  res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_EXPIRY,
    refresh_token: refreshToken,
    refresh_token_expires_in: REFRESH_TOKEN_EXPIRY,
    scope: codeData.scope,
  });
}

/**
 * Handle grant_type=refresh_token
 * Issues a new access token + refresh token pair (token rotation).
 */
async function handleRefreshTokenGrant(
  req: express.Request,
  res: express.Response,
) {
  const { refresh_token, client_id, resource } = req.body;
  if (typeof client_id !== "string" || typeof refresh_token !== "string")
    return res.status(400).json({ error: "invalid_request" });
  const client = await oauthRepository.getClient(client_id);
  if (!client || !client.grant_types.includes("refresh_token"))
    return res.status(400).json({ error: "invalid_client" });
  if (client.token_endpoint_auth_method === "client_secret_basic") {
    const header = req.headers.authorization;
    if (!header?.startsWith("Basic "))
      return res.status(401).json({ error: "invalid_client" });
    const basic = Buffer.from(header.slice(6), "base64").toString("utf8");
    const split = basic.indexOf(":");
    if (split < 0 || basic.slice(0, split) !== client_id ||
        basic.slice(split+1) !== client.client_secret)
      return res.status(401).json({ error: "invalid_client" });
  } else if (client.token_endpoint_auth_method === "client_secret_post") {
    if (!client.client_secret || req.body.client_secret !== client.client_secret)
      return res.status(401).json({ error: "invalid_client" });
  } else if (client.token_endpoint_auth_method !== "none") {
    return res.status(401).json({ error: "invalid_client" });
  }
  // Omitted resource retains the original bound audience.
  const target = resource === undefined ? undefined : refreshResource(req);
  if (resource !== undefined && !target)
    return res.status(400).json({ error: "invalid_target" });
  const result = await rotateRefresh(refresh_token, client_id, target || undefined);
  if (result.status !== "ok")
    return res.status(400).json({ error: "invalid_grant" });
  res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
  return res.json({
    access_token: result.new_access_token,
    refresh_token: result.new_refresh_token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_EXPIRY,
    refresh_token_expires_in: Math.max(0, Math.floor((result.expires_at.getTime() - Date.now()) / 1000)),
    scope: result.scope,
  });
}

/**
 * OAuth 2.0 Token Introspection Endpoint
 * Allows clients to introspect access tokens
 */
tokenRouter.post("/oauth/introspect", async (req, res) => {
  try {
    // Check if body was parsed correctly
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Request body is missing or malformed",
      });
    }

    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Missing token parameter",
      });
    }

    // Check if token exists and is valid
    const tokenData = await oauthRepository.getAccessToken(token);

    if (!tokenData || !token.startsWith("mcp_token_")) {
      return res.json({
        active: false,
      });
    }

    // Check if token has expired
    if (Date.now() > tokenData.expires_at.getTime()) {
      await oauthRepository.deleteAccessToken(token);
      return res.json({
        active: false,
      });
    }

    // Token is active, return introspection details
    res.json({
      active: true,
      scope: tokenData.scope,
      client_id: tokenData.client_id,
      token_type: "Bearer",
      exp: Math.floor(tokenData.expires_at.getTime() / 1000),
      iat: Math.floor(tokenData.created_at.getTime() / 1000),
      sub: tokenData.user_id,
    });
  } catch (error) {
    logger.error("Error in OAuth introspect endpoint:", error);
    res.status(500).json({
      error: "server_error",
      error_description: "Internal server error",
    });
  }
});

/**
 * OAuth 2.0 Token Revocation Endpoint
 * Allows clients to revoke access tokens or refresh tokens
 */
tokenRouter.post("/oauth/revoke", async (req, res) => {
  try {
    // Check if body was parsed correctly
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Request body is missing or malformed",
      });
    }

    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Missing token parameter",
      });
    }

    // Try revoking as access token
    if (await oauthRepository.getAccessToken(token)) {
      await oauthRepository.deleteAccessToken(token);
    } else {
      if (typeof token === "string" && token.startsWith("mcp_refresh_"))
        await revokeRefresh(token);
      // RFC 7009: unknown tokens return success without revealing status.
    }

    // RFC 7009 specifies that revocation endpoint should return 200 OK
    res.status(200).send();
  } catch (error) {
    logger.error("Error in OAuth revoke endpoint:", error);
    res.status(500).json({
      error: "server_error",
      error_description: "Internal server error",
    });
  }
});

export default tokenRouter;
