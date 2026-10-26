import cors from "cors";
import express from "express";
import helmet from "helmet";

import metamcpRoutes from "./mcp-proxy/metamcp";
import serverRoutes from "./mcp-proxy/server";

const mcpProxyRouter = express.Router();

// Apply security middleware for MCP proxy communication
mcpProxyRouter.use(helmet());
mcpProxyRouter.use(
  cors({
    origin: process.env.APP_URL,
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "mcp-session-id",
      "MCP-Protocol-Version",
      "x-custom-auth-header",
      "last-event-id",
    ],
  }),
);

// Basic authentication disabled for easier OAuth integration

// Apply additional headers
mcpProxyRouter.use((req, res, next) => {
  res.header(
    "Access-Control-Expose-Headers",
    "mcp-session-id, MCP-Protocol-Version, authorization, last-event-id",
  );
  next();
});

// Mount MCP server proxy routes under /server
mcpProxyRouter.use("/server", serverRoutes);

// Mount MetaMCP routes under /metamcp
mcpProxyRouter.use("/metamcp", metamcpRoutes);

export default mcpProxyRouter;
