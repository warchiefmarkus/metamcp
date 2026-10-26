import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ServerParameters } from "@repo/zod-types";

import logger from "@/utils/logger";

import { ProcessManagedStdioTransport } from "../stdio-transport/process-managed-transport";
import { metamcpLogStore } from "./log-store";
import { serverErrorTracker } from "./server-error-tracker";
import { resolveEnvVariables } from "./utils";

const sleep = (time: number) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), time));

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const MIN_CONNECT_TIMEOUT_MS = 5_000;
const MAX_CONNECT_TIMEOUT_MS = 300_000;

const getConnectTimeoutMs = (): number => {
  const configured = Number(process.env.METAMCP_CONNECT_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_CONNECT_TIMEOUT_MS;
  }

  return Math.min(
    Math.max(configured, MIN_CONNECT_TIMEOUT_MS),
    MAX_CONNECT_TIMEOUT_MS,
  );
};

const withConnectTimeout = async <T>(
  operation: Promise<T>,
  description: string,
): Promise<T> => {
  const timeoutMs = getConnectTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${description} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export const startTransportWithTimeout = async (
  transport: Transport,
  description = "MCP transport startup",
): Promise<void> => {
  try {
    await withConnectTimeout(transport.start(), description);
  } catch (error) {
    try {
      await transport.close();
    } catch (cleanupError) {
      logger.error(
        `Failed to close transport after ${description} failed:`,
        cleanupError,
      );
    }
    throw error;
  }
};

const connectClientWithTimeout = async (
  client: Client,
  transport: Transport,
  serverName: string,
): Promise<void> => {
  await withConnectTimeout(
    client.connect(transport),
    `MCP connection to ${serverName}`,
  );
};

const closeClientAndTransport = async (
  client: Client,
  transport: Transport,
): Promise<void> => {
  let closeError: unknown;
  try {
    await transport.close();
  } catch (error) {
    closeError = error;
  }

  try {
    await client.close();
  } catch (error) {
    closeError ??= error;
  }

  if (closeError !== undefined) {
    throw closeError;
  }
};

const getSafeNpxCwd = (command: string): string | undefined => {
  const normalizedCommand = command.toLowerCase();
  const isNpxCommand =
    normalizedCommand === "npx" ||
    normalizedCommand.endsWith("/npx") ||
    normalizedCommand.endsWith("\\npx.cmd") ||
    normalizedCommand.endsWith("\\npx.exe");

  if (!isNpxCommand) {
    return undefined;
  }

  const cwd =
    process.env.METAMCP_NPX_CWD ||
    path.join(os.homedir(), ".metamcp", "npx-cwd");

  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
};

export interface ConnectedClient {
  client: Client;
  cleanup: () => Promise<void>;
  getProcessId: () => number | null;
  onProcessCrash?: (exitCode: number | null, signal: string | null) => void;
}

/**
 * Transforms localhost URLs to use host.docker.internal when running inside Docker
 */
export const transformDockerUrl = (url: string): string => {
  if (process.env.TRANSFORM_LOCALHOST_TO_DOCKER_INTERNAL === "true") {
    const transformed = url.replace(
      /localhost|127\.0\.0\.1/g,
      "host.docker.internal",
    );
    return transformed;
  }
  return url;
};

export const createMetaMcpClient = (
  serverParams: ServerParameters,
): { client: Client | undefined; transport: Transport | undefined } => {
  let transport: Transport | undefined;

  // Create the appropriate transport based on server type
  // Default to "STDIO" if type is undefined
  if (!serverParams.type || serverParams.type === "STDIO") {
    // Resolve environment variable placeholders
    const resolvedEnv = serverParams.env
      ? resolveEnvVariables(serverParams.env)
      : undefined;

    const stdioCommand = serverParams.command || "";
    const stdioCwd = getSafeNpxCwd(stdioCommand);
    if (stdioCwd) {
      logger.info(
        `Using safe npx cwd for server ${serverParams.name}: ${stdioCwd}`,
      );
    }

    const stdioParams: StdioServerParameters = {
      command: stdioCommand,
      args: serverParams.args || undefined,
      env: resolvedEnv,
      stderr: "pipe",
      cwd: stdioCwd,
    };
    transport = new ProcessManagedStdioTransport(stdioParams);

    // Handle stderr stream when set to "pipe"
    if ((transport as ProcessManagedStdioTransport).stderr) {
      const stderrStream = (transport as ProcessManagedStdioTransport).stderr;

      stderrStream?.on("data", (chunk: Buffer) => {
        metamcpLogStore.addLog(
          serverParams.name,
          "error",
          chunk.toString().trim(),
        );
      });

      stderrStream?.on("error", (error: Error) => {
        metamcpLogStore.addLog(
          serverParams.name,
          "error",
          "stderr error",
          error,
        );
      });
    }
  } else if (serverParams.type === "SSE" && serverParams.url) {
    // Transform the URL if TRANSFORM_LOCALHOST_TO_DOCKER_INTERNAL is set to "true"
    const transformedUrl = transformDockerUrl(serverParams.url);

    // Build headers: start with custom headers, then add auth header
    const headers: Record<string, string> = {
      ...(serverParams.headers || {}),
    };

    // Check for authentication - prioritize OAuth tokens, fallback to bearerToken
    const authToken =
      serverParams.oauth_tokens?.access_token || serverParams.bearerToken;
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const hasHeaders = Object.keys(headers).length > 0;

    if (!hasHeaders) {
      transport = new SSEClientTransport(new URL(transformedUrl));
    } else {
      transport = new SSEClientTransport(new URL(transformedUrl), {
        requestInit: {
          headers,
        },
        eventSourceInit: {
          fetch: (url, init) => fetch(url, { ...init, headers }),
        },
      });
    }
  } else if (serverParams.type === "STREAMABLE_HTTP" && serverParams.url) {
    // Transform the URL if TRANSFORM_LOCALHOST_TO_DOCKER_INTERNAL is set to "true"
    const transformedUrl = transformDockerUrl(serverParams.url);

    // Build headers: start with custom headers, then add auth header
    const headers: Record<string, string> = {
      ...(serverParams.headers || {}),
    };

    // Check for authentication - prioritize OAuth tokens, fallback to bearerToken
    const authToken =
      serverParams.oauth_tokens?.access_token || serverParams.bearerToken;
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const hasHeaders = Object.keys(headers).length > 0;

    if (!hasHeaders) {
      transport = new StreamableHTTPClientTransport(new URL(transformedUrl));
    } else {
      transport = new StreamableHTTPClientTransport(new URL(transformedUrl), {
        requestInit: {
          headers,
        },
      });
    }
  } else {
    metamcpLogStore.addLog(
      serverParams.name,
      "error",
      `Unsupported server type: ${serverParams.type}`,
    );
    return { client: undefined, transport: undefined };
  }

  const client = new Client(
    {
      name: "metamcp-client",
      version: "2.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: { subscribe: true },
        tools: {},
      },
    },
  );
  return { client, transport };
};

export const connectMetaMcpClient = async (
  serverParams: ServerParameters,
  onProcessCrash?: (exitCode: number | null, signal: string | null) => void,
): Promise<ConnectedClient | undefined> => {
  const waitFor = 5000;

  // Get max attempts from server error tracker instead of hardcoding
  const maxAttempts = await serverErrorTracker.getServerMaxAttempts(
    serverParams.uuid,
  );
  let count = 0;
  let retry = true;

  logger.info(
    `Connecting to server ${serverParams.name} (${serverParams.uuid}) with max attempts: ${maxAttempts}`,
  );

  while (retry) {
    let transport: Transport | undefined;
    let client: Client | undefined;

    try {
      // Check if server is already in error state before attempting connection
      const isInErrorState = await serverErrorTracker.isServerInErrorState(
        serverParams.uuid,
      );
      if (isInErrorState) {
        logger.info(
          `Server ${serverParams.name} (${serverParams.uuid}) is already in ERROR state, skipping connection attempt`,
        );
        return undefined;
      }

      // Create fresh client and transport for each attempt
      const result = createMetaMcpClient(serverParams);
      client = result.client;
      transport = result.transport;

      if (!client || !transport) {
        return undefined;
      }

      // Set up process crash detection for STDIO transports BEFORE connecting
      if (transport instanceof ProcessManagedStdioTransport) {
        logger.info(
          `Setting up crash handler for server ${serverParams.name} (${serverParams.uuid})`,
        );
        transport.onprocesscrash = (exitCode, signal) => {
          logger.info(
            `Process crashed for server ${serverParams.name} (${serverParams.uuid}): code=${exitCode}, signal=${signal}`,
          );

          // Notify the pool about the crash
          if (onProcessCrash) {
            logger.info(
              `Calling onProcessCrash callback for server ${serverParams.name} (${serverParams.uuid})`,
            );
            onProcessCrash(exitCode, signal);
          } else {
            logger.info(
              `No onProcessCrash callback provided for server ${serverParams.name} (${serverParams.uuid})`,
            );
          }
        };
      }

      await connectClientWithTimeout(client, transport, serverParams.name);

      return {
        client,
        cleanup: async () => {
          await closeClientAndTransport(client!, transport!);
        },
        getProcessId: () =>
          transport instanceof ProcessManagedStdioTransport
            ? transport.pid
            : null,
        onProcessCrash: (exitCode, signal) => {
          logger.warn(
            `Process crash detected for server ${serverParams.name} (${serverParams.uuid}): code=${exitCode}, signal=${signal}`,
          );

          // Notify the pool about the crash
          if (onProcessCrash) {
            onProcessCrash(exitCode, signal);
          }
        },
      };
    } catch (error) {
      metamcpLogStore.addLog(
        "client",
        "error",
        `Error connecting to MetaMCP client (attempt ${count + 1}/${maxAttempts})`,
        error,
      );

      // CRITICAL FIX: Clean up transport/process on connection failure
      // This prevents orphaned processes from accumulating
      if (transport && client) {
        try {
          await closeClientAndTransport(client, transport);
          console.log(
            `Cleaned up MCP client and transport for failed connection to ${serverParams.name} (${serverParams.uuid})`,
          );
        } catch (cleanupError) {
          console.error(
            `Error cleaning up MCP client and transport for ${serverParams.name} (${serverParams.uuid}):`,
            cleanupError,
          );
        }
      } else if (transport) {
        try {
          await transport.close();
        } catch (cleanupError) {
          console.error(
            `Error cleaning up transport for ${serverParams.name} (${serverParams.uuid}):`,
            cleanupError,
          );
        }
      } else if (client) {
        try {
          await client.close();
        } catch (cleanupError) {
          console.error(
            `Error cleaning up client for ${serverParams.name} (${serverParams.uuid}):`,
            cleanupError,
          );
        }
      }

      count++;
      retry = count < maxAttempts;
      if (retry) {
        await sleep(waitFor);
      }
    }
  }

  return undefined;
};
