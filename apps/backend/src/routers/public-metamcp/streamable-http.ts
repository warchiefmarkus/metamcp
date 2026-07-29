import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import {
  ApiKeyAuthenticatedRequest,
  authenticateApiKey,
} from "@/middleware/api-key-oauth.middleware";
import { lookupEndpoint } from "@/middleware/lookup-endpoint-middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import logger from "@/utils/logger";

import { metaMcpServerPool } from "../../lib/metamcp/metamcp-server-pool";
import { SessionLifetimeManagerImpl } from "../../lib/session-lifetime-manager";

const streamableHttpRouter = express.Router();

// Session lifetime manager for StreamableHTTP sessions
const sessionManager =
  new SessionLifetimeManagerImpl<StreamableHTTPServerTransport>(
    "StreamableHTTP",
  );
const SESSION_IDLE_TIMEOUT_MS = Number(
  process.env.METAMCP_SESSION_IDLE_TIMEOUT_MS || "60000",
);
const sessionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const sessionsBeingCleanedUp: Set<string> = new Set();
const sessionInFlight: Map<string, number> = new Map();

const clearSessionTimer = (sessionId: string) => {
  const timer = sessionTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    sessionTimers.delete(sessionId);
  }
};

const scheduleSessionTimer = (sessionId: string) => {
  if (
    !Number.isFinite(SESSION_IDLE_TIMEOUT_MS) ||
    SESSION_IDLE_TIMEOUT_MS <= 0 ||
    (sessionInFlight.get(sessionId) || 0) > 0
  ) {
    return;
  }

  clearSessionTimer(sessionId);

  const timer = setTimeout(() => {
    if ((sessionInFlight.get(sessionId) || 0) > 0) {
      scheduleSessionTimer(sessionId);
      return;
    }
    logger.info(
      `Public StreamableHTTP session ${sessionId} idle for ${SESSION_IDLE_TIMEOUT_MS}ms, cleaning up`,
    );
    cleanupSession(sessionId).catch((error) => {
      logger.error(
        `Error during idle cleanup of public StreamableHTTP session ${sessionId}:`,
        error,
      );
    });
  }, SESSION_IDLE_TIMEOUT_MS);

  timer.unref?.();
  sessionTimers.set(sessionId, timer);
};

const beginSessionRequest = (sessionId: string) => {
  clearSessionTimer(sessionId);
  sessionInFlight.set(sessionId, (sessionInFlight.get(sessionId) || 0) + 1);
};

const endSessionRequest = (sessionId: string) => {
  const next = Math.max(0, (sessionInFlight.get(sessionId) || 1) - 1);
  if (next === 0) {
    sessionInFlight.delete(sessionId);
    scheduleSessionTimer(sessionId);
  } else {
    sessionInFlight.set(sessionId, next);
  }
};

const handleSessionRequest = async (
  sessionId: string,
  res: express.Response,
  action: () => Promise<void>,
) => {
  beginSessionRequest(sessionId);
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    res.off("finish", complete);
    res.off("close", complete);
    endSessionRequest(sessionId);
  };
  res.once("finish", complete);
  res.once("close", complete);

  try {
    await action();
    if (res.writableEnded) complete();
  } catch (error) {
    complete();
    throw error;
  }
};

// Cleanup function for a specific session
const cleanupSession = async (
  sessionId: string,
  transport?: StreamableHTTPServerTransport,
) => {
  if (sessionsBeingCleanedUp.has(sessionId)) {
    return;
  }

  sessionsBeingCleanedUp.add(sessionId);
  clearSessionTimer(sessionId);
  logger.info(`Cleaning up StreamableHTTP session ${sessionId}`);

  try {
    // Use provided transport or get from session manager
    const sessionTransport = transport || sessionManager.getSession(sessionId);

    if (sessionTransport) {
      logger.info(`Closing transport for session ${sessionId}`);
      await sessionTransport.close();
      logger.info(`Transport cleaned up for session ${sessionId}`);
    } else {
      logger.info(`No transport found for session ${sessionId}`);
    }

    // Remove from session manager
    sessionManager.removeSession(sessionId);

    // Clean up MetaMCP server pool session
    await metaMcpServerPool.cleanupSession(sessionId);

    logger.info(`Session ${sessionId} cleanup completed successfully`);
  } catch (error) {
    logger.error(`Error during cleanup of session ${sessionId}:`, error);
    // Even if cleanup fails, remove the session from manager to prevent memory leaks
    sessionManager.removeSession(sessionId);
    logger.info(`Removed orphaned session ${sessionId} due to cleanup error`);
    throw error;
  } finally {
    sessionInFlight.delete(sessionId);
    sessionsBeingCleanedUp.delete(sessionId);
  }
};

// Health check endpoint to monitor sessions
streamableHttpRouter.get("/health/sessions", (req, res) => {
  const sessionIds = sessionManager.getSessionIds();
  const poolStatus = metaMcpServerPool.getPoolStatus();
  const mcpPoolStatus = metaMcpServerPool.getMcpServerPoolStatus();
  const mcpConnections = metaMcpServerPool.getMcpServerConnectionDetails();

  res.json({
    timestamp: new Date().toISOString(),
    streamableHttpSessions: {
      count: sessionIds.length,
      sessionIds: sessionIds,
      sessions: sessionIds.map((sessionId) => ({
        sessionId,
        activeRequests: sessionInFlight.get(sessionId) || 0,
      })),
    },
    metaMcpPoolStatus: poolStatus,
    mcpServerPoolStatus: mcpPoolStatus,
    mcpConnections,
    activeSessionRequests: Array.from(sessionInFlight.values()).reduce(
      (total, count) => total + count,
      0,
    ),
    totalActiveSessions: sessionIds.length,
    totalMcpConnections: mcpPoolStatus.totalConnections,
  });
});

streamableHttpRouter.get(
  "/:endpoint_name/mcp",
  lookupEndpoint,
  authenticateApiKey,
  rateLimitMiddleware,
  async (req, res) => {
    // const authReq = req as ApiKeyAuthenticatedRequest;
    // const { namespaceUuid, endpointName } = authReq;
    const sessionId = req.headers["mcp-session-id"] as string;

    // logger.info(
    //   `Received GET message for public endpoint ${endpointName} -> namespace ${namespaceUuid} sessionId ${sessionId}`,
    // );

    try {
      logger.info(`Looking up existing session: ${sessionId}`);
      logger.info(`Available sessions:`, sessionManager.getSessionIds());

      const transport = sessionManager.getSession(sessionId);
      if (!transport) {
        logger.info(`Session ${sessionId} not found in session manager`);
        res.status(404).end("Session not found");
        return;
      } else {
        logger.info(`Found session ${sessionId}, handling request`);
        await handleSessionRequest(sessionId, res, async () => {
          await transport.handleRequest(req, res);
        });
      }
    } catch (error) {
      logger.error("Error in public endpoint /mcp route:", error);
      res.status(500).json(error);
    }
  },
);

streamableHttpRouter.post(
  "/:endpoint_name/mcp",
  lookupEndpoint,
  authenticateApiKey,
  rateLimitMiddleware,
  async (req, res) => {
    const authReq = req as ApiKeyAuthenticatedRequest;
    const { namespaceUuid, endpointName } = authReq;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Log authentication information for debugging
    logger.info(`POST /mcp request for endpoint: ${endpointName}`);
    logger.info(`Authentication method: ${authReq.authMethod || "none"}`);
    logger.info(`Session ID: ${sessionId || "new session"}`);

    if (!sessionId) {
      try {
        logger.info(
          `New public endpoint StreamableHttp connection request for ${endpointName} -> namespace ${namespaceUuid}`,
        );

        // Generate session ID upfront
        const newSessionId = randomUUID();
        logger.info(
          `Generated new session ID: ${newSessionId} for endpoint: ${endpointName}`,
        );

        // Get or create MetaMCP server instance from the pool
        const mcpServerInstance = await metaMcpServerPool.getServer(
          newSessionId,
          namespaceUuid,
        );
        if (!mcpServerInstance) {
          throw new Error("Failed to get MetaMCP server instance from pool");
        }

        logger.info(
          `Using MetaMCP server instance for public endpoint session ${newSessionId} (endpoint: ${endpointName})`,
        );

        // Create transport with the predetermined session ID
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: async (sessionId) => {
            try {
              logger.info(`Session initialized for sessionId: ${sessionId}`);
            } catch (error) {
              logger.error(
                `Error initializing public endpoint session ${sessionId}:`,
                error,
              );
            }
          },
        });

        // Note: Cleanup is handled explicitly via DELETE requests
        // StreamableHTTP is designed to persist across multiple requests
        logger.info("Created public endpoint StreamableHttp transport");
        logger.info(
          `Session ${newSessionId} will be cleaned up when DELETE request is received`,
        );

        // Store transport reference
        sessionManager.addSession(newSessionId, transport);

        logger.info(
          `Public Endpoint Client <-> Proxy sessionId: ${newSessionId} for endpoint ${endpointName} -> namespace ${namespaceUuid}`,
        );
        logger.info(`Stored transport for sessionId: ${newSessionId}`);
        logger.info(`Current stored sessions:`, sessionManager.getSessionIds());
        logger.info(
          `Total active sessions: ${sessionManager.getSessionCount()}`,
        );

        // Connect the server to the transport before handling the request
        await mcpServerInstance.server.connect(transport);

        // Now handle the request - server is guaranteed to be ready
        await handleSessionRequest(newSessionId, res, async () => {
          await transport.handleRequest(req, res);
        });
      } catch (error) {
        logger.error("Error in public endpoint /mcp POST route:", error);

        // Provide more detailed error information
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        res.status(500).json({
          error: "Internal server error",
          message: errorMessage,
          endpoint: endpointName,
          timestamp: new Date().toISOString(),
        });
      }
    } else {
      // logger.info(
      //   `Received POST message for public endpoint ${endpointName} -> namespace ${namespaceUuid} sessionId ${sessionId}`,
      // );
      logger.info(`Available session IDs:`, sessionManager.getSessionIds());
      logger.info(`Looking for sessionId: ${sessionId}`);
      try {
        logger.info(`Looking up existing session: ${sessionId}`);
        logger.info(`Available sessions:`, sessionManager.getSessionIds());

        const transport = sessionManager.getSession(sessionId);
        if (!transport) {
          logger.error(
            `Transport not found for sessionId ${sessionId}. Available sessions:`,
            sessionManager.getSessionIds(),
          );
          res.status(404).json({
            error: "Session not found",
            message: `Transport not found for sessionId ${sessionId}`,
            available_sessions: sessionManager.getSessionIds(),
            timestamp: new Date().toISOString(),
          });
        } else {
          logger.info(`Found session ${sessionId}, handling request`);
          await handleSessionRequest(sessionId, res, async () => {
            await transport.handleRequest(req, res);
          });
        }
      } catch (error) {
        logger.error("Error in public endpoint /mcp route:", error);

        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        res.status(500).json({
          error: "Internal server error",
          message: errorMessage,
          session_id: sessionId,
          endpoint: endpointName,
          timestamp: new Date().toISOString(),
        });
      }
    }
  },
);

streamableHttpRouter.delete(
  "/:endpoint_name/mcp",
  lookupEndpoint,
  authenticateApiKey,
  rateLimitMiddleware,
  async (req, res) => {
    const authReq = req as ApiKeyAuthenticatedRequest;
    const { namespaceUuid, endpointName } = authReq;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    logger.info(
      `Received DELETE message for public endpoint ${endpointName} -> namespace ${namespaceUuid} sessionId ${sessionId}`,
    );

    if (sessionId) {
      try {
        logger.info(`Starting cleanup for session ${sessionId}`);
        logger.info(
          `Available sessions before cleanup:`,
          sessionManager.getSessionIds(),
        );

        await cleanupSession(sessionId);

        logger.info(
          `Public endpoint session ${sessionId} cleaned up successfully`,
        );
        logger.info(
          `Available sessions after cleanup:`,
          sessionManager.getSessionIds(),
        );

        res.status(200).json({
          message: "Session cleaned up successfully",
          sessionId: sessionId,
          remainingSessions: sessionManager.getSessionIds(),
        });
      } catch (error) {
        logger.error("Error in public endpoint /mcp DELETE route:", error);
        res.status(500).json({
          error: "Cleanup failed",
          message: error instanceof Error ? error.message : "Unknown error",
          sessionId: sessionId,
        });
      }
    } else {
      res.status(400).json({
        error: "Missing sessionId",
        message: "sessionId header is required for cleanup",
      });
    }
  },
);

// Initialize automatic cleanup timer using session manager
sessionManager.startCleanupTimer(async (sessionId, transport) => {
  if ((sessionInFlight.get(sessionId) || 0) > 0) {
    scheduleSessionTimer(sessionId);
    return;
  }
  await cleanupSession(sessionId, transport);
});

export default streamableHttpRouter;
