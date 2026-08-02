import { timingSafeEqual } from "node:crypto";

import express from "express";

import { metaMcpServerPool } from "../lib/metamcp";
import logger from "../utils/logger";

const hostControlRouter = express.Router();
const tokenHeader = "x-metamcp-host-control-token";

function isLoopback(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

export function isHostControlAuthorized(
  remoteAddress: string | undefined,
  suppliedToken: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!isLoopback(remoteAddress) || !suppliedToken || !expectedToken) {
    return false;
  }

  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
hostControlRouter.use((req, res, next) => {
  const expectedToken = process.env.METAMCP_HOST_CONTROL_TOKEN;
  if (!expectedToken) {
    res.status(503).json({ error: "Host control is not configured" });
    return;
  }

  const suppliedToken = req.header(tokenHeader);
  if (
    !isHostControlAuthorized(
      req.socket.remoteAddress,
      suppliedToken,
      expectedToken,
    )
  ) {
    res.status(403).json({ error: "Host control access denied" });
    return;
  }
  next();
});

hostControlRouter.post("/mcp-connections/reset", async (_req, res) => {
  try {
    const result = await metaMcpServerPool.resetMcpServerConnections();
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error("Failed to reset downstream MCP connections:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default hostControlRouter;
