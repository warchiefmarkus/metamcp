import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StreamableSessionActivityTracker } from "./streamable-session-activity";

describe("StreamableSessionActivityTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T20:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cleans an idle session even while its GET event stream remains open", async () => {
    const cleanup = vi.fn(async () => undefined);
    const tracker = new StreamableSessionActivityTracker({
      idleTimeoutMs: 1_000,
      cleanup,
    });

    tracker.registerSession("session-1");
    const closeStream = tracker.beginEventStream("session-1");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("session-1");
    expect(tracker.getOpenEventStreams("session-1")).toBe(1);
    closeStream();
    expect(tracker.getOpenEventStreams("session-1")).toBe(0);
  });

  it("does not clean a session while a meaningful operation is running", async () => {
    const cleanup = vi.fn(async () => undefined);
    const tracker = new StreamableSessionActivityTracker({
      idleTimeoutMs: 1_000,
      cleanup,
    });

    tracker.registerSession("session-1");
    const completeOperation = tracker.beginOperation("session-1");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanup).not.toHaveBeenCalled();

    completeOperation();
    await vi.advanceTimersByTimeAsync(999);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("tracks operations and event streams independently", () => {
    const tracker = new StreamableSessionActivityTracker({
      idleTimeoutMs: 1_000,
      cleanup: async () => undefined,
    });

    tracker.registerSession("session-1");
    const completeOperation = tracker.beginOperation("session-1");
    const closeStreamA = tracker.beginEventStream("session-1");
    const closeStreamB = tracker.beginEventStream("session-1");

    expect(tracker.getSnapshot("session-1")).toMatchObject({
      inFlightOperations: 1,
      openEventStreams: 2,
      idleMs: 0,
    });

    closeStreamA();
    completeOperation();
    expect(tracker.getSnapshot("session-1")).toMatchObject({
      inFlightOperations: 0,
      openEventStreams: 1,
    });
    closeStreamB();
  });

  it("cancels pending cleanup when a session is removed", async () => {
    const cleanup = vi.fn(async () => undefined);
    const tracker = new StreamableSessionActivityTracker({
      idleTimeoutMs: 1_000,
      cleanup,
    });

    tracker.registerSession("session-1");
    tracker.removeSession("session-1");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(cleanup).not.toHaveBeenCalled();
  });
});
