import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/metamcp", () => ({
  metaMcpServerPool: {
    resetMcpServerConnections: vi.fn(),
  },
}));
vi.mock("../utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { isHostControlAuthorized } from "./host-control";

describe("host control authorization", () => {
  it("accepts a matching token only from loopback", () => {
    expect(isHostControlAuthorized("127.0.0.1", "secret", "secret")).toBe(true);
    expect(isHostControlAuthorized("::1", "secret", "secret")).toBe(true);
    expect(
      isHostControlAuthorized("::ffff:127.0.0.1", "secret", "secret"),
    ).toBe(true);
  });

  it("rejects remote clients and invalid tokens", () => {
    expect(isHostControlAuthorized("10.0.0.2", "secret", "secret")).toBe(false);
    expect(isHostControlAuthorized("127.0.0.1", "wrong", "secret")).toBe(false);
    expect(isHostControlAuthorized("127.0.0.1", undefined, "secret")).toBe(
      false,
    );
  });
});
