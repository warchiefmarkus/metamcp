import { randomUUID } from "node:crypto";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import express from "express";

import logger from "@/utils/logger";

import { createServer } from "../../lib/metamcp/index";
import { mcpServerPool } from "../../lib/metamcp/mcp-server-pool";
import { betterAuthMcpMiddleware } from "../../middleware/better-auth-mcp.middleware";

const metamcpRouter = express.Router();

// Apply better auth middleware to all metamcp routes
metamcpRouter.use(betterAuthMcpMiddleware);

const webAppTransports: Map<string, Transport> = new Map<string, Transport>(); // Web app transports by sessionId
const metamcpServers: Map<
  string,
  {
    server: Awaited<ReturnType<typeof createServer>>["server"];
    cleanup: () => Promise<void>;
  }
> = new Map(); // MetaMCP servers by sessionId
const SESSION_IDLE_TIMEOUT_MS = Number(
  process.env.METAMCP_SESSION_IDLE_TIMEOUT_MS || "60000",
);
const sessionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const sessionsBeingCleanedUp: Set<string> = new Set();

const clearSessionTimer = (sessionId: string) => {
  const timer = sessionTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    sessionTimers.delete(sessionId);
  }
};

const scheduleSessionTimer = (sessionId: string) => {
  if (!Number.isFinite(SESSION_IDLE_TIMEOUT_MS) || SESSION_IDLE_TIMEOUT_MS <= 0) {
    return;
  }

  clearSessionTimer(sessionId);

  const timer = setTimeout(() => {
    logger.info(
      `MetaMCP session ${sessionId} idle for ${SESSION_IDLE_TIMEOUT_MS}ms, cleaning up`,
    );
    cleanupSession(sessionId).catch((error) => {
      logger.error(
        `Error during idle cleanup for MetaMCP session ${sessionId}:`,
        error,
      );
    });
  }, SESSION_IDLE_TIMEOUT_MS);

  timer.unref?.();
  sessionTimers.set(sessionId, timer);
};

// Create a MetaMCP server instance
const createMetaMcpServer = async (
  namespaceUuid: string,
  sessionId: string,
  includeInactiveServers: boolean = false,
) => {
  const { server, cleanup } = await createServer(
    namespaceUuid,
    sessionId,
    includeInactiveServers,
  );
  return { server, cleanup };
};

// Cleanup function for a specific session
const cleanupSession = async (sessionId: string) => {
  if (sessionsBeingCleanedUp.has(sessionId)) {
    return;
  }

  sessionsBeingCleanedUp.add(sessionId);
  clearSessionTimer(sessionId);
  logger.info(`Cleaning up session ${sessionId}`);

  try {
    // Clean up transport
    const transport = webAppTransports.get(sessionId);
    if (transport) {
      webAppTransports.delete(sessionId);
      await transport.close();
    }

    // Clean up server instance
    const serverInstance = metamcpServers.get(sessionId);
    if (serverInstance) {
      metamcpServers.delete(sessionId);
      await serverInstance.cleanup();
    }

    // Clean up session connections
    await mcpServerPool.cleanupSession(sessionId);
  } finally {
    sessionsBeingCleanedUp.delete(sessionId);
  }
};

metamcpRouter.get("/:uuid/mcp", async (req, res) => {
  // const namespaceUuid = req.params.uuid;
  const sessionId = req.headers["mcp-session-id"] as string;
  // logger.info(
  //   `Received GET message for MetaMCP namespace ${namespaceUuid} sessionId ${sessionId}`,
  // );
  try {
    const transport = webAppTransports.get(
      sessionId,
    ) as StreamableHTTPServerTransport;
    if (!transport) {
      res.status(404).end("Session not found");
      return;
    } else {
      scheduleSessionTimer(sessionId);
      await transport.handleRequest(req, res);
    }
  } catch (error) {
    logger.error("Error in MetaMCP /mcp route:", error);
    res.status(500).json(error);
  }
});

metamcpRouter.post("/:uuid/mcp", async (req, res) => {
  const namespaceUuid = req.params.uuid;
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let mcpServerInstance:
    | {
        server: Awaited<ReturnType<typeof createServer>>["server"];
        cleanup: () => Promise<void>;
      }
    | undefined;

  if (!sessionId) {
    try {
      logger.info(
        `New MetaMCP StreamableHttp connection request for namespace ${namespaceUuid}`,
      );

      const webAppTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: async (newSessionId) => {
          try {
            // Extract includeInactiveServers from query parameters
            const includeInactiveServers =
              req.query.includeInactiveServers === "true";

            // Create MetaMCP server instance with sessionId
            mcpServerInstance = await createMetaMcpServer(
              namespaceUuid,
              newSessionId,
              includeInactiveServers,
            );
            logger.info(
              `Created MetaMCP server instance for session ${newSessionId}`,
            );

            webAppTransports.set(newSessionId, webAppTransport);
            metamcpServers.set(newSessionId, mcpServerInstance);
            scheduleSessionTimer(newSessionId);

            logger.info(
              `MetaMCP Client <-> Proxy sessionId: ${newSessionId} for namespace ${namespaceUuid}`,
            );

            await mcpServerInstance.server.connect(webAppTransport);

            // Handle cleanup when connection closes
            res.on("close", async () => {
              logger.info(
                `MetaMCP connection closed for session ${newSessionId}`,
              );
              await cleanupSession(newSessionId);
            });
          } catch (error) {
            logger.error(`Error initializing session ${newSessionId}:`, error);
          }
        },
      });
      logger.info("Created MetaMCP StreamableHttp transport");

      await (webAppTransport as StreamableHTTPServerTransport).handleRequest(
        req,
        res,
        req.body,
      );
    } catch (error) {
      logger.error("Error in MetaMCP /mcp POST route:", error);
      res.status(500).json(error);
    }
  } else {
    // logger.info(
    //   `Received POST message for MetaMCP namespace ${namespaceUuid} sessionId ${sessionId}`,
    // );
    try {
      const transport = webAppTransports.get(
        sessionId,
      ) as StreamableHTTPServerTransport;
      if (!transport) {
        res.status(404).end("Transport not found for sessionId " + sessionId);
      } else {
        scheduleSessionTimer(sessionId);
        await (transport as StreamableHTTPServerTransport).handleRequest(
          req,
          res,
        );
      }
    } catch (error) {
      logger.error("Error in MetaMCP /mcp route:", error);
      res.status(500).json(error);
    }
  }
});

metamcpRouter.delete("/:uuid/mcp", async (req, res) => {
  const namespaceUuid = req.params.uuid;
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  logger.info(
    `Received DELETE message for MetaMCP namespace ${namespaceUuid} sessionId ${sessionId}`,
  );

  if (sessionId) {
    try {
      await cleanupSession(sessionId);
      logger.info(`MetaMCP session ${sessionId} cleaned up successfully`);
      res.status(200).end();
    } catch (error) {
      logger.error("Error in MetaMCP /mcp DELETE route:", error);
      res.status(500).json(error);
    }
  } else {
    res.status(400).end("Missing sessionId");
  }
});

metamcpRouter.get("/:uuid/sse", async (req, res) => {
  const namespaceUuid = req.params.uuid;
  const includeInactiveServers = req.query.includeInactiveServers === "true";

  try {
    logger.info(
      `New MetaMCP SSE connection request for namespace ${namespaceUuid}, includeInactiveServers: ${includeInactiveServers}`,
    );

    const webAppTransport = new SSEServerTransport(
      `/mcp-proxy/metamcp/${namespaceUuid}/message`,
      res,
    );
    logger.info("Created MetaMCP SSE transport");

    const sessionId = webAppTransport.sessionId;

    // Create MetaMCP server instance with sessionId and includeInactiveServers flag
    const mcpServerInstance = await createMetaMcpServer(
      namespaceUuid,
      sessionId,
      includeInactiveServers,
    );
    logger.info(`Created MetaMCP server instance for session ${sessionId}`);

    webAppTransports.set(sessionId, webAppTransport);
    metamcpServers.set(sessionId, mcpServerInstance);
    scheduleSessionTimer(sessionId);

    // Handle cleanup when connection closes
    res.on("close", async () => {
      logger.info(`MetaMCP SSE connection closed for session ${sessionId}`);
      await cleanupSession(sessionId);
    });

    await mcpServerInstance.server.connect(webAppTransport);
  } catch (error) {
    logger.error("Error in MetaMCP /sse route:", error);
    res.status(500).json(error);
  }
});

metamcpRouter.post("/:uuid/message", async (req, res) => {
  // const namespaceUuid = req.params.uuid;
  try {
    const sessionId = req.query.sessionId;
    // logger.info(
    //   `Received POST message for MetaMCP namespace ${namespaceUuid} sessionId ${sessionId}`,
    // );

    const transport = webAppTransports.get(
      sessionId as string,
    ) as SSEServerTransport;
    if (!transport) {
      res.status(404).end("Session not found");
      return;
    }
    scheduleSessionTimer(sessionId as string);
    await transport.handlePostMessage(req, res);
  } catch (error) {
    logger.error("Error in MetaMCP /message route:", error);
    res.status(500).json(error);
  }
});

metamcpRouter.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "metamcp",
  });
});

metamcpRouter.get("/info", (req, res) => {
  res.json({
    service: "metamcp",
    version: "1.0.0",
    description: "MetaMCP unified MCP proxy service",
  });
});

export default metamcpRouter;
