import { McpConnectionModeEnum, ServerParameters } from "@repo/zod-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  getSessionLifetime: vi.fn(async () => null),
  recordServerCrash: vi.fn(async () => undefined),
  resetServerErrorState: vi.fn(async () => undefined),
  isServerInErrorState: vi.fn(async () => false),
}));

vi.mock("./client", () => ({ connectMetaMcpClient: mocks.connect }));
vi.mock("../config.service", () => ({
  configService: { getSessionLifetime: mocks.getSessionLifetime },
}));
vi.mock("./server-error-tracker", () => ({
  serverErrorTracker: {
    recordServerCrash: mocks.recordServerCrash,
    resetServerErrorState: mocks.resetServerErrorState,
    isServerInErrorState: mocks.isServerInErrorState,
  },
}));
vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const persistentParams = (idleTimeoutMs = 60_000): ServerParameters => ({
  uuid: "playwright-uuid",
  name: "playwright",
  description: "stateful browser",
  type: "STDIO",
  command: "npx",
  args: ["@playwright/mcp@latest", "--extension"],
  env: {},
  created_at: new Date(0).toISOString(),
  status: "active",
  connectionMode: McpConnectionModeEnum.Enum.PERSISTENT,
  idleTimeoutMs,
});

const sessionParams = (): ServerParameters => ({
  ...persistentParams(),
  connectionMode: McpConnectionModeEnum.Enum.SESSION,
});

const createClient = (processId = 1234) => {
  const cleanup = vi.fn(async () => undefined);
  return {
    client: {} as never,
    cleanup,
    getProcessId: () => processId,
  };
};

async function loadPool() {
  const module = await import("./mcp-server-pool");
  return module.mcpServerPool;
}

beforeEach(() => {
  process.env.METAMCP_DISABLE_IDLE_PREWARM = "true";
  mocks.connect.mockReset();
  mocks.getSessionLifetime.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("McpServerPool persistent lifecycle", () => {
  it("reuses one persistent client across outer sessions", async () => {
    const client = createClient();
    mocks.connect.mockResolvedValue(client);
    const pool = await loadPool();

    const first = await pool.getSession(
      "session-a",
      "playwright-uuid",
      persistentParams(),
    );
    const second = await pool.getSession(
      "session-b",
      "playwright-uuid",
      persistentParams(),
    );

    expect(first).toBe(client);
    expect(second).toBe(client);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(pool.getPoolStatus()).toMatchObject({
      persistent: 1,
      active: 0,
      idle: 0,
      totalConnections: 1,
    });
    expect(pool.getConnectionDetails()).toEqual([
      {
        serverUuid: "playwright-uuid",
        serverName: "playwright",
        serverType: "STDIO",
        kind: "PERSISTENT",
        processId: 1234,
        sessionIds: ["session-a", "session-b"],
        inFlight: 0,
      },
    ]);

    await pool.cleanupSession("session-a");
    expect(client.cleanup).not.toHaveBeenCalled();
    await pool.cleanupAll();
    expect(client.cleanup).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent first connections", async () => {
    const client = createClient();
    let resolveConnect!: (value: typeof client) => void;
    mocks.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const pool = await loadPool();

    const first = pool.getSession(
      "session-a",
      "playwright-uuid",
      persistentParams(),
    );
    const second = pool.getSession(
      "session-b",
      "playwright-uuid",
      persistentParams(),
    );
    expect(mocks.connect).toHaveBeenCalledTimes(1);

    resolveConnect(client);
    expect(await first).toBe(client);
    expect(await second).toBe(client);
    expect(pool.getPoolStatus().totalConnections).toBe(1);
    await pool.cleanupAll();
  });

  it("does not resurrect an outer session closed during persistent connect", async () => {
    const client = createClient();
    let resolveConnect!: (value: typeof client) => void;
    mocks.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const pool = await loadPool();

    const connecting = pool.getSession(
      "session-a",
      "playwright-uuid",
      persistentParams(),
    );
    await pool.cleanupSession("session-a");
    resolveConnect(client);

    expect(await connecting).toBeUndefined();
    expect(pool.getPoolStatus()).toMatchObject({
      persistent: 1,
      totalConnections: 1,
      activeSessionIds: [],
    });
    await pool.cleanupAll();
  });

  it("closes a connection that finishes after cleanupAll", async () => {
    const client = createClient();
    let resolveConnect!: (value: typeof client) => void;
    mocks.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const pool = await loadPool();

    const connecting = pool.getSession(
      "session-a",
      "playwright-uuid",
      persistentParams(),
    );
    await pool.cleanupAll();
    resolveConnect(client);

    expect(await connecting).toBeUndefined();
    expect(client.cleanup).toHaveBeenCalledTimes(1);
    expect(pool.getPoolStatus().totalConnections).toBe(0);
  });

  it("does not create idle replacements when prewarm is disabled", async () => {
    const firstClient = createClient();
    const secondClient = createClient();
    mocks.connect
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const pool = await loadPool();

    await pool.getSession("session-a", "playwright-uuid", sessionParams());
    expect(pool.getConnectionDetails()).toEqual([
      {
        serverUuid: "playwright-uuid",
        serverName: "playwright",
        serverType: "STDIO",
        kind: "SESSION",
        processId: 1234,
        sessionIds: ["session-a"],
        inFlight: 0,
      },
    ]);
    await pool.cleanupSession("session-a");
    expect(firstClient.cleanup).toHaveBeenCalledTimes(1);
    expect(pool.getPoolStatus().idle).toBe(0);

    await pool.getSession("session-b", "playwright-uuid", sessionParams());
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(pool.getPoolStatus().totalConnections).toBe(1);
    await pool.cleanupAll();
  });

  it("invalidates a persistent client and creates a fresh one", async () => {
    const oldClient = createClient();
    const newClient = createClient();
    mocks.connect
      .mockResolvedValueOnce(oldClient)
      .mockResolvedValueOnce(newClient);
    const pool = await loadPool();

    await pool.getSession("session-a", "playwright-uuid", persistentParams());
    await pool.invalidateIdleSession("playwright-uuid", persistentParams());
    expect(oldClient.cleanup).toHaveBeenCalledTimes(1);

    const next = await pool.getSession(
      "session-b",
      "playwright-uuid",
      persistentParams(),
    );
    expect(next).toBe(newClient);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    await pool.cleanupAll();
  });

  it("keeps an in-flight persistent request and expires it after idle TTL", async () => {
    vi.useFakeTimers();
    const client = createClient();
    mocks.connect.mockResolvedValue(client);
    const pool = await loadPool();
    await pool.getSession("session-a", "playwright-uuid", persistentParams());

    let finishRequest!: () => void;
    const request = pool.withClientUsage(
      "playwright-uuid",
      client,
      () =>
        new Promise<void>((resolve) => {
          finishRequest = resolve;
        }),
    );

    await vi.advanceTimersByTimeAsync(180_000);
    expect(client.cleanup).not.toHaveBeenCalled();
    expect(pool.getPoolStatus().persistentInFlight).toBe(1);

    finishRequest();
    await request;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.cleanup).toHaveBeenCalledTimes(1);
    expect(pool.getPoolStatus().persistent).toBe(0);
    await pool.cleanupAll();
  });
});
