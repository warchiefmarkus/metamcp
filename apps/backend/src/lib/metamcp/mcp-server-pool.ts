import { McpConnectionModeEnum, ServerParameters } from "@repo/zod-types";

import logger from "@/utils/logger";

import { configService } from "../config.service";
import { ConnectedClient, connectMetaMcpClient } from "./client";
import { serverErrorTracker } from "./server-error-tracker";

export interface McpServerPoolStatus {
  idle: number;
  active: number;
  persistent: number;
  persistentInFlight: number;
  totalConnections: number;
  activeSessionIds: string[];
  idleServerUuids: string[];
  persistentServerUuids: string[];
}

interface PersistentClientEntry {
  client: ConnectedClient;
  lastUsedAt: number;
  inFlight: number;
  idleTimeoutMs: number;
}

export class McpServerPool {
  // Singleton instance
  private static instance: McpServerPool | null = null;

  // Idle sessions: serverUuid -> ConnectedClient (no sessionId assigned yet)
  private idleSessions: Record<string, ConnectedClient> = {};

  // Active sessions: sessionId -> Record<serverUuid, ConnectedClient>
  private activeSessions: Record<string, Record<string, ConnectedClient>> = {};

  // Mapping: sessionId -> Set<serverUuid> for cleanup tracking
  private sessionToServers: Record<string, Set<string>> = {};

  // Session creation timestamps: sessionId -> timestamp
  private sessionTimestamps: Record<string, number> = {};
  private sessionConnectionVersions: Record<string, number> = {};

  // Server parameters cache: serverUuid -> ServerParameters
  private serverParamsCache: Record<string, ServerParameters> = {};

  // Track ongoing idle session creation to prevent duplicates
  private creatingIdleSessions: Set<string> = new Set();

  // Persistent stateful clients are shared across short-lived outer MCP sessions.
  private persistentSessions: Record<string, PersistentClientEntry> = {};
  private connectingPersistentSessions: Map<
    string,
    Promise<ConnectedClient | undefined>
  > = new Map();
  private serverConnectionVersions: Record<string, number> = {};
  private lifecycleVersion = 0;

  // Session cleanup timer
  private cleanupTimer: NodeJS.Timeout | null = null;

  // Background idle sessions by namespace: namespaceUuid -> any
  private backgroundIdleSessionsByNamespace: Map<string, any> = new Map();

  // Default number of idle sessions per server UUID
  private readonly defaultIdleCount: number;

  // Maximum total connections (idle + active) to prevent runaway process spawning
  private readonly maxTotalConnections: number;
  private readonly disableIdleSessions: boolean;

  private constructor(
    defaultIdleCount: number = 1,
    maxTotalConnections: number = 100,
  ) {
    this.defaultIdleCount = defaultIdleCount;
    this.maxTotalConnections = maxTotalConnections;
    this.disableIdleSessions = ["1", "true", "yes", "y", "on"].includes(
      (process.env.METAMCP_DISABLE_IDLE_PREWARM || "").trim().toLowerCase(),
    );
    if (this.disableIdleSessions) {
      logger.info(
        "Underlying MCP idle connection pool disabled via METAMCP_DISABLE_IDLE_PREWARM=true",
      );
    }
    this.startCleanupTimer();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(defaultIdleCount: number = 1): McpServerPool {
    if (!McpServerPool.instance) {
      McpServerPool.instance = new McpServerPool(defaultIdleCount);
    }
    return McpServerPool.instance;
  }

  /**
   * Get or create a session for a specific MCP server
   */
  async getSession(
    sessionId: string,
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<ConnectedClient | undefined> {
    // Update server params cache
    this.serverParamsCache[serverUuid] = params;
    const sessionVersion = this.sessionConnectionVersions[sessionId] || 0;
    const lifecycleVersion = this.lifecycleVersion;

    if (params.connectionMode === McpConnectionModeEnum.Enum.PERSISTENT) {
      return await this.getPersistentSession(
        sessionId,
        sessionVersion,
        lifecycleVersion,
        serverUuid,
        params,
        namespaceUuid,
      );
    }

    // Check if we already have an active session for this sessionId and server
    if (this.activeSessions[sessionId]?.[serverUuid]) {
      return this.activeSessions[sessionId][serverUuid];
    }

    // Initialize session if it doesn't exist
    if (!this.activeSessions[sessionId]) {
      this.activeSessions[sessionId] = {};
      this.sessionToServers[sessionId] = new Set();
      this.sessionTimestamps[sessionId] = Date.now();
    }

    // Check if we have an idle session for this server that we can convert
    const idleClient = this.idleSessions[serverUuid];
    if (idleClient) {
      // Convert idle session to active session
      delete this.idleSessions[serverUuid];
      this.activeSessions[sessionId][serverUuid] = idleClient;
      this.sessionToServers[sessionId].add(serverUuid);

      logger.info(
        `Converted idle session to active for server ${serverUuid}, session ${sessionId}`,
      );

      // Create a new idle session to replace the one we just used (ASYNC - NON-BLOCKING)
      if (!this.disableIdleSessions) {
        this.createIdleSessionAsync(serverUuid, params, namespaceUuid);
      }

      return idleClient;
    }

    // No idle session available, create a new connection
    const newClient = await this.createNewConnection(params, namespaceUuid);
    if (!newClient) {
      return undefined;
    }

    if (
      this.lifecycleVersion !== lifecycleVersion ||
      (this.sessionConnectionVersions[sessionId] || 0) !== sessionVersion
    ) {
      await newClient.cleanup();
      return undefined;
    }

    this.activeSessions[sessionId][serverUuid] = newClient;
    this.sessionToServers[sessionId].add(serverUuid);

    logger.info(
      `Created new active session for server ${serverUuid}, session ${sessionId}`,
    );

    // Also create an idle session for future use (ASYNC - NON-BLOCKING)
    if (!this.disableIdleSessions) {
      this.createIdleSessionAsync(serverUuid, params, namespaceUuid);
    }

    return newClient;
  }

  private bindSessionClient(
    sessionId: string,
    serverUuid: string,
    client: ConnectedClient,
  ): void {
    if (!this.activeSessions[sessionId]) {
      this.activeSessions[sessionId] = {};
      this.sessionToServers[sessionId] = new Set();
    }
    this.activeSessions[sessionId][serverUuid] = client;
    this.sessionToServers[sessionId].add(serverUuid);
    this.sessionTimestamps[sessionId] = Date.now();
  }

  private async getPersistentSession(
    sessionId: string,
    sessionVersion: number,
    lifecycleVersion: number,
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<ConnectedClient | undefined> {
    const existing = this.persistentSessions[serverUuid];
    if (existing) {
      existing.lastUsedAt = Date.now();
      this.bindSessionClient(sessionId, serverUuid, existing.client);
      return existing.client;
    }

    const connectionVersion = this.serverConnectionVersions[serverUuid] || 0;
    let connecting = this.connectingPersistentSessions.get(serverUuid);
    if (!connecting) {
      connecting = this.createNewConnection(params, namespaceUuid);
      this.connectingPersistentSessions.set(serverUuid, connecting);
    }

    try {
      const client = await connecting;
      if (!client) {
        return undefined;
      }

      if (
        this.lifecycleVersion !== lifecycleVersion ||
        (this.serverConnectionVersions[serverUuid] || 0) !== connectionVersion
      ) {
        await client.cleanup();
        return undefined;
      }

      const winner = this.persistentSessions[serverUuid];
      if (winner) {
        if (winner.client !== client) {
          await client.cleanup();
        }
        winner.lastUsedAt = Date.now();
        if (
          (this.sessionConnectionVersions[sessionId] || 0) !== sessionVersion
        ) {
          return undefined;
        }
        this.bindSessionClient(sessionId, serverUuid, winner.client);
        return winner.client;
      }

      this.persistentSessions[serverUuid] = {
        client,
        lastUsedAt: Date.now(),
        inFlight: 0,
        idleTimeoutMs: Math.max(params.idleTimeoutMs, 60_000),
      };
      if ((this.sessionConnectionVersions[sessionId] || 0) !== sessionVersion) {
        return undefined;
      }
      this.bindSessionClient(sessionId, serverUuid, client);
      logger.info(
        `Created persistent connection for server ${params.name} (${serverUuid})`,
      );
      return client;
    } finally {
      if (this.connectingPersistentSessions.get(serverUuid) === connecting) {
        this.connectingPersistentSessions.delete(serverUuid);
      }
    }
  }

  async withClientUsage<T>(
    serverUuid: string,
    client: ConnectedClient,
    action: () => Promise<T>,
  ): Promise<T> {
    const persistent = this.persistentSessions[serverUuid];
    if (!persistent || persistent.client !== client) {
      return await action();
    }

    persistent.inFlight += 1;
    persistent.lastUsedAt = Date.now();
    try {
      return await action();
    } finally {
      persistent.inFlight = Math.max(0, persistent.inFlight - 1);
      persistent.lastUsedAt = Date.now();
    }
  }

  /**
   * Create a new connection for a server
   */
  private async createNewConnection(
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<ConnectedClient | undefined> {
    // Check connection limit before attempting to create
    if (!this.canCreateConnection()) {
      logger.warn(
        `Skipping connection for server ${params.name} (${params.uuid}) - connection limit reached`,
      );
      return undefined;
    }

    logger.info(
      `Creating new connection for server ${params.name} (${params.uuid}) with namespace: ${namespaceUuid || "none"}`,
    );

    const connectedClient = await connectMetaMcpClient(
      params,
      (exitCode, signal) => {
        logger.info(
          `Crash handler callback called for server ${params.name} (${params.uuid}) with namespace: ${namespaceUuid || "none"}`,
        );

        // Handle process crash - always set up crash handler
        if (namespaceUuid) {
          // If we have a namespace context, use it
          this.handleServerCrash(
            params.uuid,
            namespaceUuid,
            exitCode,
            signal,
          ).catch((error) => {
            logger.error(
              `Error handling server crash for ${params.uuid} in ${namespaceUuid}:`,
              error,
            );
          });
        } else {
          // If no namespace context, still track the crash globally
          this.handleServerCrashWithoutNamespace(
            params.uuid,
            exitCode,
            signal,
          ).catch((error) => {
            logger.error(
              `Error handling server crash for ${params.uuid} (no namespace):`,
              error,
            );
          });
        }
      },
    );
    if (!connectedClient) {
      return undefined;
    }

    return connectedClient;
  }

  /**
   * Create an idle session for a server (blocking version for initial setup)
   */
  private async createIdleSession(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    if (
      this.disableIdleSessions ||
      params.connectionMode === McpConnectionModeEnum.Enum.PERSISTENT
    ) {
      return;
    }

    // Don't create if we already have an idle session for this server
    if (this.idleSessions[serverUuid]) {
      return;
    }

    const newClient = await this.createNewConnection(params, namespaceUuid);
    if (newClient) {
      this.idleSessions[serverUuid] = newClient;
      logger.info(`Created idle session for server ${serverUuid}`);
    }
  }

  /**
   * Create an idle session for a server asynchronously (non-blocking)
   */
  private createIdleSessionAsync(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): void {
    if (
      this.disableIdleSessions ||
      params.connectionMode === McpConnectionModeEnum.Enum.PERSISTENT
    ) {
      return;
    }

    // Don't create if we already have an idle session or are already creating one
    if (
      this.idleSessions[serverUuid] ||
      this.creatingIdleSessions.has(serverUuid)
    ) {
      return;
    }

    // Mark that we're creating an idle session for this server
    this.creatingIdleSessions.add(serverUuid);

    // Create the session in the background (fire and forget)
    this.createNewConnection(params, namespaceUuid)
      .then((newClient) => {
        if (newClient && !this.idleSessions[serverUuid]) {
          this.idleSessions[serverUuid] = newClient;
          logger.info(
            `Created background idle session for server [${params.name}] ${serverUuid}`,
          );
          if (namespaceUuid) {
            this.setBackgroundIdleSessionsByNamespace(
              namespaceUuid,
              new Map().set("status", "created"),
            );
          }
        } else if (newClient) {
          // We already have an idle session, cleanup the extra one
          newClient.cleanup().catch((error) => {
            logger.error(
              `Error cleaning up extra idle session for ${serverUuid}:`,
              error,
            );
          });
        }
      })
      .catch((error) => {
        logger.error(
          `Error creating background idle session for ${serverUuid}:`,
          error,
        );
      })
      .finally(() => {
        // Remove from creating set
        this.creatingIdleSessions.delete(serverUuid);
      });
  }

  /**
   * Ensure idle sessions exist for all servers
   */
  async ensureIdleSessions(
    serverParams: Record<string, ServerParameters>,
    namespaceUuid?: string,
  ): Promise<void> {
    if (this.disableIdleSessions) {
      return;
    }

    const promises = Object.entries(serverParams).map(
      async ([uuid, params]) => {
        if (!this.idleSessions[uuid]) {
          await this.createIdleSession(uuid, params, namespaceUuid);
        }
      },
    );

    await Promise.allSettled(promises);
  }

  /**
   * Cleanup a session by sessionId
   */
  async cleanupSession(sessionId: string): Promise<void> {
    this.sessionConnectionVersions[sessionId] =
      (this.sessionConnectionVersions[sessionId] || 0) + 1;
    const activeSession = this.activeSessions[sessionId];
    if (!activeSession) {
      delete this.sessionTimestamps[sessionId];
      delete this.sessionToServers[sessionId];
      return;
    }

    await Promise.allSettled(
      Object.entries(activeSession).map(async ([serverUuid, client]) => {
        const persistent = this.persistentSessions[serverUuid];
        if (persistent?.client === client) {
          persistent.lastUsedAt = Date.now();
          return;
        }
        await client.cleanup();
      }),
    );

    delete this.activeSessions[sessionId];
    delete this.sessionTimestamps[sessionId];

    const serverUuids = this.sessionToServers[sessionId];
    if (serverUuids && !this.disableIdleSessions) {
      for (const serverUuid of serverUuids) {
        const params = this.serverParamsCache[serverUuid];
        if (
          params &&
          params.connectionMode !== McpConnectionModeEnum.Enum.PERSISTENT
        ) {
          this.createIdleSessionAsync(serverUuid, params);
        }
      }
    }
    delete this.sessionToServers[sessionId];

    logger.info(`Cleaned up MCP server pool session ${sessionId}`);
  }

  /**
   * Cleanup all sessions
   */
  async cleanupAll(): Promise<void> {
    this.lifecycleVersion += 1;
    const clients = new Set<ConnectedClient>();
    Object.values(this.idleSessions).forEach((client) => clients.add(client));
    Object.values(this.persistentSessions).forEach((entry) =>
      clients.add(entry.client),
    );
    Object.values(this.activeSessions).forEach((session) =>
      Object.values(session).forEach((client) => clients.add(client)),
    );

    await Promise.allSettled(
      Array.from(clients).map(async (client) => await client.cleanup()),
    );

    this.idleSessions = {};
    this.activeSessions = {};
    this.persistentSessions = {};
    this.sessionToServers = {};
    this.sessionTimestamps = {};
    this.sessionConnectionVersions = {};
    this.serverParamsCache = {};
    this.creatingIdleSessions.clear();
    this.connectingPersistentSessions.clear();
    this.serverConnectionVersions = {};

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    logger.info("Cleaned up all MCP server pool sessions");
  }

  /**
   * Get pool status for monitoring
   */
  getPoolStatus(): McpServerPoolStatus {
    const persistentClients = new Set(
      Object.values(this.persistentSessions).map((entry) => entry.client),
    );
    const idle = Object.keys(this.idleSessions).length;
    const active = Object.values(this.activeSessions).reduce(
      (total, session) =>
        total +
        Object.values(session).filter(
          (client) => !persistentClients.has(client),
        ).length,
      0,
    );
    const persistent = Object.keys(this.persistentSessions).length;
    const persistentInFlight = Object.values(this.persistentSessions).reduce(
      (total, entry) => total + entry.inFlight,
      0,
    );

    return {
      idle,
      active,
      persistent,
      persistentInFlight,
      totalConnections: this.getTotalConnectionCount(),
      activeSessionIds: Object.keys(this.activeSessions),
      idleServerUuids: Object.keys(this.idleSessions),
      persistentServerUuids: Object.keys(this.persistentSessions),
    };
  }

  /**
   * Get total connection count (idle + active + pending)
   */
  private getTotalConnectionCount(): number {
    const clients = new Set<ConnectedClient>();
    Object.values(this.idleSessions).forEach((client) => clients.add(client));
    Object.values(this.persistentSessions).forEach((entry) =>
      clients.add(entry.client),
    );
    Object.values(this.activeSessions).forEach((session) =>
      Object.values(session).forEach((client) => clients.add(client)),
    );
    return (
      clients.size +
      this.creatingIdleSessions.size +
      this.connectingPersistentSessions.size
    );
  }

  /**
   * Check if we can create a new connection (respects maxTotalConnections limit)
   */
  private canCreateConnection(): boolean {
    const total = this.getTotalConnectionCount();
    if (total >= this.maxTotalConnections) {
      logger.warn(
        `Connection limit reached: ${total}/${this.maxTotalConnections}. Refusing to create new connection.`,
      );
      return false;
    }
    return true;
  }

  /**
   * Get active session connections for a specific session (for debugging/monitoring)
   */
  getSessionConnections(
    sessionId: string,
  ): Record<string, ConnectedClient> | undefined {
    return this.activeSessions[sessionId];
  }

  /**
   * Get all active session IDs (for debugging/monitoring)
   */
  getActiveSessionIds(): string[] {
    return Object.keys(this.activeSessions);
  }

  /**
   * Get background idle sessions by namespace
   */
  getBackgroundIdleSessionsByNamespace(): Map<string, any> {
    return this.backgroundIdleSessionsByNamespace;
  }

  /**
   * Set background idle sessions by namespace
   */
  setBackgroundIdleSessionsByNamespace(
    namespaceUuid: string,
    options: any,
  ): void {
    this.backgroundIdleSessionsByNamespace.set(namespaceUuid, options);
  }

  /**
   * Invalidate and refresh idle session for a specific server
   * This should be called when a server's parameters (command, args, etc.) change
   */
  async invalidateIdleSession(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    logger.info(`Invalidating connections for server ${serverUuid}`);
    this.serverParamsCache[serverUuid] = params;
    await this.cleanupServerSessions(serverUuid);

    if (
      !this.disableIdleSessions &&
      params.connectionMode !== McpConnectionModeEnum.Enum.PERSISTENT
    ) {
      await this.createIdleSession(serverUuid, params, namespaceUuid);
    }
  }

  /**
   * Invalidate and refresh idle sessions for multiple servers
   */
  async invalidateIdleSessions(
    serverParams: Record<string, ServerParameters>,
    namespaceUuid?: string,
  ): Promise<void> {
    const promises = Object.entries(serverParams).map(([serverUuid, params]) =>
      this.invalidateIdleSession(serverUuid, params, namespaceUuid),
    );

    await Promise.allSettled(promises);
  }

  /**
   * Clean up idle session for a specific server without creating a new one
   * This should be called when a server is being deleted
   */
  async cleanupIdleSession(serverUuid: string): Promise<void> {
    logger.info(`Cleaning up all connections for server ${serverUuid}`);
    await this.cleanupServerSessions(serverUuid);
    delete this.serverParamsCache[serverUuid];
  }

  /**
   * Ensure idle session exists for a newly created server
   * This should be called when a new server is created
   */
  async ensureIdleSessionForNewServer(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    logger.info(`Ensuring idle session exists for new server ${serverUuid}`);

    // Update server params cache
    this.serverParamsCache[serverUuid] = params;

    if (
      this.disableIdleSessions ||
      params.connectionMode === McpConnectionModeEnum.Enum.PERSISTENT
    ) {
      return;
    }

    // Only create if we don't already have one
    if (
      !this.idleSessions[serverUuid] &&
      !this.creatingIdleSessions.has(serverUuid)
    ) {
      await this.createIdleSession(serverUuid, params, namespaceUuid);
    }
  }

  /**
   * Handle server process crash
   */
  async handleServerCrash(
    serverUuid: string,
    namespaceUuid: string,
    exitCode: number | null,
    signal: string | null,
  ): Promise<void> {
    logger.warn(
      `Handling server crash for ${serverUuid} in namespace ${namespaceUuid}`,
    );

    // Record the crash in the error tracker
    await serverErrorTracker.recordServerCrash(serverUuid, exitCode, signal);

    // Clean up any existing sessions for this server
    await this.cleanupServerSessions(serverUuid);
  }

  /**
   * Handle server process crash without namespace context
   * This is used when servers are created without a specific namespace
   */
  async handleServerCrashWithoutNamespace(
    serverUuid: string,
    exitCode: number | null,
    signal: string | null,
  ): Promise<void> {
    logger.warn(
      `Handling server crash for ${serverUuid} (no namespace context)`,
    );

    // Record the crash in the error tracker
    logger.info(`Recording crash for server ${serverUuid}`);
    await serverErrorTracker.recordServerCrash(serverUuid, exitCode, signal);

    // Clean up any existing sessions for this server
    await this.cleanupServerSessions(serverUuid);
  }

  /**
   * Clean up all sessions for a specific server
   */
  private async cleanupServerSessions(serverUuid: string): Promise<void> {
    this.serverConnectionVersions[serverUuid] =
      (this.serverConnectionVersions[serverUuid] || 0) + 1;
    const clients = new Set<ConnectedClient>();

    const idleSession = this.idleSessions[serverUuid];
    if (idleSession) {
      clients.add(idleSession);
      delete this.idleSessions[serverUuid];
    }

    const persistent = this.persistentSessions[serverUuid];
    if (persistent) {
      clients.add(persistent.client);
      delete this.persistentSessions[serverUuid];
    }

    this.connectingPersistentSessions.delete(serverUuid);

    for (const [sessionId, sessionServers] of Object.entries(
      this.activeSessions,
    )) {
      const client = sessionServers[serverUuid];
      if (!client) continue;
      clients.add(client);
      delete sessionServers[serverUuid];
      this.sessionToServers[sessionId]?.delete(serverUuid);
      if (Object.keys(sessionServers).length === 0) {
        delete this.activeSessions[sessionId];
        delete this.sessionToServers[sessionId];
        delete this.sessionTimestamps[sessionId];
      }
    }

    await Promise.allSettled(
      Array.from(clients).map(async (client) => await client.cleanup()),
    );
    this.creatingIdleSessions.delete(serverUuid);
  }

  /**
   * Check if a server is in error state
   */
  async isServerInErrorState(serverUuid: string): Promise<boolean> {
    return await serverErrorTracker.isServerInErrorState(serverUuid);
  }

  /**
   * Reset error state for a server (e.g., after manual recovery)
   */
  async resetServerErrorState(serverUuid: string): Promise<void> {
    // Reset crash attempts and error status
    await serverErrorTracker.resetServerErrorState(serverUuid);

    logger.info(`Reset error state for server ${serverUuid}`);
  }

  /**
   * Start the automatic cleanup timer for expired sessions
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      await Promise.allSettled([
        this.cleanupExpiredSessions(),
        this.cleanupExpiredPersistentSessions(),
      ]);
    }, 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  private async cleanupExpiredPersistentSessions(): Promise<void> {
    const now = Date.now();
    const expired = Object.entries(this.persistentSessions).filter(
      ([_serverUuid, entry]) =>
        entry.inFlight === 0 && now - entry.lastUsedAt > entry.idleTimeoutMs,
    );

    await Promise.allSettled(
      expired.map(async ([serverUuid, entry]) => {
        if (this.persistentSessions[serverUuid] !== entry) {
          return;
        }
        delete this.persistentSessions[serverUuid];
        for (const [sessionId, sessionServers] of Object.entries(
          this.activeSessions,
        )) {
          if (sessionServers[serverUuid] === entry.client) {
            delete sessionServers[serverUuid];
            this.sessionToServers[sessionId]?.delete(serverUuid);
            if (Object.keys(sessionServers).length === 0) {
              delete this.activeSessions[sessionId];
              delete this.sessionToServers[sessionId];
              delete this.sessionTimestamps[sessionId];
            }
          }
        }
        await entry.client.cleanup();
        logger.info(
          `Cleaned up idle persistent MCP connection for server ${serverUuid}`,
        );
      }),
    );
  }

  /**
   * Clean up expired sessions based on session lifetime setting
   */
  private async cleanupExpiredSessions(): Promise<void> {
    try {
      const sessionLifetime = await configService.getSessionLifetime();

      // If session lifetime is null, sessions are infinite - skip cleanup
      if (sessionLifetime === null) {
        return;
      }

      const now = Date.now();
      const expiredSessionIds: string[] = [];

      // Find expired sessions
      for (const [sessionId, timestamp] of Object.entries(
        this.sessionTimestamps,
      )) {
        if (now - timestamp > sessionLifetime) {
          expiredSessionIds.push(sessionId);
        }
      }

      // Clean up expired sessions
      if (expiredSessionIds.length > 0) {
        logger.info(
          `Cleaning up ${expiredSessionIds.length} expired MCP server pool sessions: ${expiredSessionIds.join(", ")}`,
        );

        await Promise.allSettled(
          expiredSessionIds.map((sessionId) => this.cleanupSession(sessionId)),
        );
      }
    } catch (error) {
      logger.error("Error during automatic session cleanup:", error);
    }
  }

  /**
   * Get session age in milliseconds
   */
  getSessionAge(sessionId: string): number | undefined {
    const timestamp = this.sessionTimestamps[sessionId];
    return timestamp ? Date.now() - timestamp : undefined;
  }

  /**
   * Check if a session is expired
   */
  async isSessionExpired(sessionId: string): Promise<boolean> {
    const age = this.getSessionAge(sessionId);
    if (age === undefined) return false;

    const sessionLifetime = await configService.getSessionLifetime();
    if (sessionLifetime === null) return false; // infinite sessions
    return age > sessionLifetime;
  }
}

// Create a singleton instance
export const mcpServerPool = McpServerPool.getInstance();
