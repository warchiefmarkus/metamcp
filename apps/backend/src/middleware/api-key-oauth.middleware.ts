import { DatabaseEndpoint } from "@repo/zod-types";
import express from "express";

import logger from "@/utils/logger";

import { ApiKeysRepository } from "../db/repositories/api-keys.repo";
import {
  authRateLimiter,
  getAuthRateLimitIdentifier,
} from "../lib/auth-rate-limiter";
import { getBaseUrl } from "../routers/oauth/utils";
import { resourceForEndpoint, resourceMetadataUrl } from "../routers/oauth/resource";
import { oauthRepository } from "../db/repositories";

// Extend Express Request interface for our custom properties
export interface ApiKeyAuthenticatedRequest extends express.Request {
  namespaceUuid: string;
  endpointName: string;
  endpoint: DatabaseEndpoint;
  apiKeyUserId?: string;
  apiKeyUuid?: string;
  oauthUserId?: string; // For OAuth-authenticated requests
  authMethod?: "api_key" | "oauth"; // Track which auth method was used
}

const apiKeysRepository = new ApiKeysRepository();

/**
 * Validates OAuth bearer token using MCP token introspection
 * @param token OAuth bearer token
 * @param req Express request object
 * @returns OAuth validation result
 */
async function validateOAuthToken(
  token: string,
  req: express.Request,
  endpoint: DatabaseEndpoint,
): Promise<{
  valid: boolean;
  user_id?: string;
  scopes?: string[];
  error?: string;
}> {
  if (!token.startsWith("mcp_token_")) {
    return { valid: false, error: "Unsupported token format" };
  }

  try {
    // Validate against persisted token state directly. Avoid public HTTP
    // introspection loops and always enforce the exact MCP resource audience.
    const stored = await oauthRepository.getAccessToken(token);
    const expectedAudience = resourceForEndpoint(getBaseUrl(req), endpoint.name);
    if (!stored?.resource || stored.resource !== expectedAudience) {
      return { valid: false, error: "OAuth token audience mismatch" };
    }
    if (stored.expires_at.getTime() <= Date.now()) {
      await oauthRepository.deleteAccessToken(token);
      return { valid: false, error: "Expired OAuth token" };
    }
    return {
      valid: true,
      user_id: stored.user_id,
      scopes: stored.scope.trim().split(/\s+/),
    };
  } catch (error) {
    logger.error("Error validating MCP OAuth token:", error);
    return { valid: false, error: "OAuth validation failed" };
  }
}

/**
 * Extract authentication token from request headers and query parameters
 */
function extractAuthToken(
  req: express.Request,
  endpoint: DatabaseEndpoint,
): {
  token?: string;
  source: "x-api-key" | "authorization" | "query" | "none";
  isOAuthLikeToken: boolean;
} {
  // Check for API key in X-API-Key header
  const apiKeyHeader = req.headers["x-api-key"] as string;
  if (apiKeyHeader) {
    return {
      token: apiKeyHeader,
      source: "x-api-key",
      isOAuthLikeToken: false,
    };
  }

  // Check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    return {
      token,
      source: "authorization",
      isOAuthLikeToken: token.startsWith("mcp_token_"),
    };
  }

  // Check query parameters for API key (if enabled)
  if (endpoint.enable_api_key_auth && endpoint.use_query_param_auth) {
    const queryApiKey =
      (req.query.api_key as string) || (req.query.apikey as string);
    if (queryApiKey) {
      return {
        token: queryApiKey,
        source: "query",
        isOAuthLikeToken: false,
      };
    }
  }

  return { source: "none", isOAuthLikeToken: false };
}

/**
 * Enhanced authentication middleware organized by 4 clear conditions
 * to prevent infinite retry issues with MCP inspector
 */
export const authenticateApiKey = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const authReq = req as ApiKeyAuthenticatedRequest;
  const endpoint = authReq.endpoint;

  // Extract token information
  const { token, source, isOAuthLikeToken } = extractAuthToken(req, endpoint);

  // ===== CONDITION 1: Both API key and OAuth OFF =====
  if (!endpoint?.enable_api_key_auth && !endpoint?.enable_oauth) {
    return next(); // Pass through without authentication
  }

  try {
    // ===== CONDITION 2: API key ON, OAuth OFF =====
    if (endpoint.enable_api_key_auth && !endpoint.enable_oauth) {
      if (!token) {
        // No token provided - request API key
        return sendApiKeyRequiredResponse(res);
      }

      // Validate API key
      const apiKeyResult = await apiKeysRepository.validateApiKey(token);

      if (apiKeyResult?.valid) {
        // API key valid - perform access control and pass
        authReq.apiKeyUserId = apiKeyResult.user_id || undefined;
        authReq.apiKeyUuid = apiKeyResult.key_uuid;
        authReq.authMethod = "api_key";

        const accessCheckResult = checkApiKeyAccess(apiKeyResult, endpoint);
        if (!accessCheckResult.allowed) {
          return res.status(403).json({
            error: "Access denied",
            message: accessCheckResult.message,
            timestamp: new Date().toISOString(),
          });
        }

        return next();
      } else {
        // API key invalid - check rate limiting
        const rateLimitId = getAuthRateLimitIdentifier(req, endpoint);
        authRateLimiter.recordFailedAttempt(rateLimitId);

        if (authRateLimiter.isRateLimited(rateLimitId)) {
          return res.status(429).json({
            error: "too_many_requests",
            error_description:
              "Too many failed authentication attempts. Please try again later.",
            timestamp: new Date().toISOString(),
          });
        }

        return res.status(401).json({
          error: "invalid_api_key",
          error_description: "The provided API key is invalid or expired",
          timestamp: new Date().toISOString(),
        });
      }
    }

    // ===== CONDITION 3: API key ON, OAuth ON =====
    if (endpoint.enable_api_key_auth && endpoint.enable_oauth) {
      if (!token) {
        // No token provided - allow OAuth flow
        return sendOAuthChallengeResponse(req, res, endpoint);
      }

      // If token looks like OAuth token or came from Authorization header, try OAuth first
      if (isOAuthLikeToken || source === "authorization") {
        const oauthResult = await validateOAuthToken(token, req, endpoint);

        if (oauthResult.valid) {
          // OAuth token valid - perform access control and pass
          authReq.oauthUserId = oauthResult.user_id;
          authReq.authMethod = "oauth";

          const accessCheckResult = checkOAuthAccess(oauthResult, endpoint);
          if (!accessCheckResult.allowed) {
            return res.status(403).json({
              error: "access_denied",
              error_description: accessCheckResult.message,
              timestamp: new Date().toISOString(),
            });
          }

          return next();
        }
      }

      // Try API key validation
      const apiKeyResult = await apiKeysRepository.validateApiKey(token);

      if (apiKeyResult?.valid) {
        // API key valid - perform access control and pass
        authReq.apiKeyUserId = apiKeyResult.user_id || undefined;
        authReq.apiKeyUuid = apiKeyResult.key_uuid;
        authReq.authMethod = "api_key";

        const accessCheckResult = checkApiKeyAccess(apiKeyResult, endpoint);
        if (!accessCheckResult.allowed) {
          return res.status(403).json({
            error: "Access denied",
            message: accessCheckResult.message,
            timestamp: new Date().toISOString(),
          });
        }

        return next();
      } else {
        // Both OAuth and API key failed - check rate limiting
        const rateLimitId = getAuthRateLimitIdentifier(req, endpoint);
        authRateLimiter.recordFailedAttempt(rateLimitId);

        if (authRateLimiter.isRateLimited(rateLimitId)) {
          return res.status(429).json({
            error: "too_many_requests",
            error_description:
              "Too many failed authentication attempts. Please try again later.",
            timestamp: new Date().toISOString(),
          });
        }

        return res.status(401).json({
          error: "invalid_credentials",
          error_description:
            "Authentication failed. Invalid credentials provided.",
          timestamp: new Date().toISOString(),
        });
      }
    }

    // ===== CONDITION 4: API key OFF, OAuth ON =====
    if (!endpoint.enable_api_key_auth && endpoint.enable_oauth) {
      if (!token) {
        // No token provided - allow OAuth flow
        return sendOAuthChallengeResponse(req, res, endpoint);
      }

      // Validate OAuth token
      const oauthResult = await validateOAuthToken(token, req, endpoint);

      if (oauthResult.valid) {
        // OAuth token valid - perform access control and pass
        authReq.oauthUserId = oauthResult.user_id;
        authReq.authMethod = "oauth";

        const accessCheckResult = checkOAuthAccess(oauthResult, endpoint);
        if (!accessCheckResult.allowed) {
          return res.status(403).json({
            error: "access_denied",
            error_description: accessCheckResult.message,
            timestamp: new Date().toISOString(),
          });
        }

        return next();
      } else {
        // OAuth token invalid - check rate limiting
        const rateLimitId = getAuthRateLimitIdentifier(req, endpoint);
        authRateLimiter.recordFailedAttempt(rateLimitId);

        if (authRateLimiter.isRateLimited(rateLimitId)) {
          return res.status(429).json({
            error: "too_many_requests",
            error_description:
              "Too many failed authentication attempts. Please try again later.",
            timestamp: new Date().toISOString(),
          });
        }

        return res.status(401).json({
          error: "invalid_token",
          error_description:
            "The provided OAuth token is invalid or has expired.",
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Fallback - should not reach here with the conditions above
    return res.status(500).json({
      error: "Internal server error",
      message: "Invalid authentication configuration",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Error in authentication middleware:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: "Failed to validate authentication",
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Check if API key has access to the endpoint
 */
function checkApiKeyAccess(
  validation: { user_id?: string | null },
  endpoint: DatabaseEndpoint,
): { allowed: boolean; message?: string } {
  const isPublicApiKey = validation.user_id === null;
  const isPrivateEndpoint = endpoint.user_id !== null;

  if (isPublicApiKey && isPrivateEndpoint) {
    return {
      allowed: false,
      message:
        "Public API keys cannot access private endpoints. Use a private API key owned by the endpoint owner.",
    };
  }

  if (
    !isPublicApiKey &&
    isPrivateEndpoint &&
    endpoint.user_id !== validation.user_id
  ) {
    return {
      allowed: false,
      message: "You can only access endpoints you own or public endpoints.",
    };
  }

  return { allowed: true };
}

/**
 * Check if OAuth token user has access to the endpoint
 */
function checkOAuthAccess(
  oauthResult: { user_id?: string; scopes?: string[] },
  endpoint: DatabaseEndpoint,
): { allowed: boolean; message?: string } {
  // If no user_id in token, deny access
  if (!oauthResult.user_id) {
    return {
      allowed: false,
      message: "OAuth token missing user information",
    };
  }

  if (!oauthResult.scopes?.includes("admin")) {
    return { allowed: false, message: "OAuth admin scope required" };
  }

  // Check endpoint access based on user permissions:
  // 1. Public endpoints (user_id is null) - accessible to all authenticated users
  // 2. Private endpoints (user_id is not null) - only accessible to the owner

  if (endpoint.user_id === null) {
    // Public endpoint - any authenticated user can access
    return { allowed: true };
  }

  if (endpoint.user_id === oauthResult.user_id) {
    // Private endpoint owned by the user - allowed
    return { allowed: true };
  }

  // Private endpoint owned by someone else - denied
  return {
    allowed: false,
    message: `Access denied. This is a private endpoint owned by another user. You can only access public endpoints or endpoints you own.`,
  };
}

/**
 * Send API key required response (no WWW-Authenticate header to prevent OAuth flow)
 */
function sendApiKeyRequiredResponse(res: express.Response): express.Response {
  return res.status(401).json({
    error: "authentication_required",
    error_description: "Authentication required via API key",
    supported_methods: [
      "X-API-Key header",
      "query parameter (api_key or apikey)",
    ],
    timestamp: new Date().toISOString(),
  });
}

/**
 * Send OAuth challenge response with proper WWW-Authenticate header
 */
function sendOAuthChallengeResponse(
  req: express.Request,
  res: express.Response,
  endpoint: DatabaseEndpoint,
): express.Response {
  const baseUrl = getBaseUrl(req);
  const metadataUrl = resourceMetadataUrl(baseUrl, endpoint.name);

  // Set WWW-Authenticate header for OAuth flow
  const bearerChallenge = [
    `Bearer realm="MetaMCP"`,
    `scope="admin"`,
    `resource_metadata="${metadataUrl}"`,
  ].join(", ");

  res.set("WWW-Authenticate", bearerChallenge);

  const authMethods = ["Authorization header (Bearer token)"];

  // Add API key methods if also enabled
  if (endpoint.enable_api_key_auth) {
    authMethods.push("X-API-Key header");
    if (endpoint.use_query_param_auth) {
      authMethods.push("query parameter (api_key or apikey)");
    }
  }

  const errorDescription = endpoint.enable_api_key_auth
    ? "Authentication required via OAuth bearer token or API key"
    : "Authentication required via OAuth bearer token";

  return res.status(401).json({
    error: "authentication_required",
    error_description: errorDescription,
    resource_metadata: metadataUrl,
    supported_methods: authMethods,
    timestamp: new Date().toISOString(),
  });
}
