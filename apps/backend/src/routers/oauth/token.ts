import express from "express";

import logger from "@/utils/logger";

import { oauthRepository } from "../../db/repositories";
import { generateSecureAccessToken, getBaseUrl, rateLimitToken } from "./utils";
import { canonicalMcpResource } from "./resource";
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, issueInitialRefresh, makeRefreshToken, rotateRefresh, revokeRefresh } from "./refresh";

const tokenRouter = express.Router();

/**
 * OAuth 2.0 Token Endpoint
 * Handles token exchange requests from MCP clients
 * Implements proper PKCE verification and code validation
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

    const { grant_type, code, redirect_uri, client_id, code_verifier, resource, refresh_token } =
      req.body;

    // Refresh exchange: opaque rotating 384-bit tokens, per-client/resource
    // binding, and refresh-family replay revocation.
    if (grant_type === "refresh_token") {
      if (typeof client_id !== "string" || typeof refresh_token !== "string") {
        return res.status(400).json({ error: "invalid_request" });
      }
      // RFC 8707 allows refresh requests to omit resource; retain the original
      // resource bound to the refresh token. Explicit resource cannot change.
      const target = resource === undefined ? undefined :
        (canonicalMcpResource(resource, getBaseUrl(req)) ?? undefined);
      if (resource !== undefined && !target)
        return res.status(400).json({ error: "invalid_target" });
      const client = await oauthRepository.getClient(client_id);
      if (!client || !client.grant_types.includes("refresh_token")) {
        return res.status(400).json({ error: "invalid_client" });
      }
      if (client.token_endpoint_auth_method === "client_secret_basic") {
        const header = req.headers.authorization;
        if (!header?.startsWith("Basic ")) return res.status(401).json({ error: "invalid_client" });
        const credentials = Buffer.from(header.slice(6), "base64").toString("utf8");
        const separator = credentials.indexOf(":");
        if (separator < 0 || credentials.slice(0, separator) !== client_id ||
            credentials.slice(separator + 1) !== client.client_secret) {
          return res.status(401).json({ error: "invalid_client" });
        }
      } else if (client.token_endpoint_auth_method === "client_secret_post") {
        if (!client.client_secret || req.body.client_secret !== client.client_secret)
          return res.status(401).json({ error: "invalid_client" });
      } else if (client.token_endpoint_auth_method !== "none") {
        return res.status(401).json({ error: "invalid_client" });
      }
      const result = await rotateRefresh(refresh_token, client_id, target);
      if (result.status !== "ok") {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: result.status === "replayed" ?
            "Refresh token reused; authorization revoked" : "Invalid or expired refresh token",
        });
      }
      res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
      return res.json({
        access_token: result.new_access_token,
        refresh_token: result.new_refresh_token,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_SECONDS,
        refresh_token_expires_in: Math.max(0, Math.floor((result.expires_at.getTime() - Date.now()) / 1000)),
        scope: result.scope,
      });
    }

    // Validate grant type
    if (grant_type !== "authorization_code") {
      return res.status(400).json({
        error: "unsupported_grant_type",
        error_description: "Only 'authorization_code' grant type is supported",
      });
    }

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

    const requestedResource = canonicalMcpResource(resource, getBaseUrl(req));
    if (!requestedResource || requestedResource !== codeData.resource) {
      return res.status(400).json({
        error: "invalid_target",
        error_description: "OAuth resource does not match the authorization request",
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
    // Note: Client should have been registered either explicitly via /oauth/register
    // or auto-registered during the /oauth/authorize flow
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

    if (typeof code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier)) {
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

    // Atomic consume avoids two concurrent exchanges minting tokens for one code.
    if (!(await oauthRepository.consumeAuthCode(code))) {
      return res.status(400).json({
        error: "invalid_grant",
        error_description: "Authorization code already consumed or expired",
      });
    }

    // Generate access token
    const accessToken = generateSecureAccessToken();
    const expiresIn = ACCESS_TTL_SECONDS;
    const issuesRefresh = clientData.grant_types.includes("refresh_token");
    const newRefreshToken = issuesRefresh ? makeRefreshToken() : undefined;
    if (newRefreshToken) {
      await issueInitialRefresh(
        codeData.client_id,
        codeData.user_id,
        codeData.scope,
        requestedResource,
        newRefreshToken,
        accessToken,
      );
    } else {
      // Older clients registered only for authorization_code remain supported.
      await oauthRepository.setAccessToken(accessToken, {
        client_id: codeData.client_id,
        user_id: codeData.user_id,
        scope: codeData.scope,
        resource: requestedResource,
        expires_at: Date.now() + expiresIn * 1000,
      });
    }

    res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
    res.json({
      access_token: accessToken,
      ...(newRefreshToken ? { refresh_token: newRefreshToken, refresh_token_expires_in: REFRESH_TTL_SECONDS } : {}),
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: codeData.scope,
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
      aud: tokenData.resource,
      client_id: tokenData.client_id,
      token_type: "Bearer",
      exp: Math.floor(tokenData.expires_at.getTime() / 1000),
      iat: Math.floor((tokenData.expires_at.getTime() - 3600 * 1000) / 1000), // Issued 1 hour before expiry
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
 * Allows clients to revoke access tokens
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

    // RFC 7009: token revocation is idempotent for both access and refresh.
    if (typeof token === "string" && token.startsWith("mcp_refresh_")) {
      await revokeRefresh(token);
    } else if (typeof token === "string" && await oauthRepository.getAccessToken(token)) {
      await oauthRepository.deleteAccessToken(token);
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
