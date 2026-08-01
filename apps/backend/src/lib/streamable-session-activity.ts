export interface StreamableSessionActivitySnapshot {
  sessionId: string;
  inFlightOperations: number;
  openEventStreams: number;
  lastActivityAt: number;
  idleMs: number;
}

interface StreamableSessionActivityOptions {
  idleTimeoutMs: number;
  cleanup: (sessionId: string) => Promise<void>;
  onCleanupError?: (sessionId: string, error: unknown) => void;
}

/**
 * Tracks meaningful MCP operations separately from long-lived GET event streams.
 * Event streams are telemetry only and must never keep an otherwise idle session alive.
 */
export class StreamableSessionActivityTracker {
  private readonly operationCounts = new Map<string, number>();
  private readonly eventStreamCounts = new Map<string, number>();
  private readonly lastActivityAt = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: StreamableSessionActivityOptions) {}

  registerSession(sessionId: string): void {
    this.lastActivityAt.set(sessionId, Date.now());
    this.scheduleIdleCleanup(sessionId);
  }

  beginOperation(sessionId: string): () => void {
    this.clearTimer(sessionId);
    this.lastActivityAt.set(sessionId, Date.now());
    this.operationCounts.set(
      sessionId,
      (this.operationCounts.get(sessionId) || 0) + 1,
    );

    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      const remaining = Math.max(
        0,
        (this.operationCounts.get(sessionId) || 1) - 1,
      );
      if (remaining === 0) {
        this.operationCounts.delete(sessionId);
        this.lastActivityAt.set(sessionId, Date.now());
        this.scheduleIdleCleanup(sessionId);
      } else {
        this.operationCounts.set(sessionId, remaining);
      }
    };
  }

  beginEventStream(sessionId: string): () => void {
    this.eventStreamCounts.set(
      sessionId,
      (this.eventStreamCounts.get(sessionId) || 0) + 1,
    );

    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      const remaining = Math.max(
        0,
        (this.eventStreamCounts.get(sessionId) || 1) - 1,
      );
      if (remaining === 0) {
        this.eventStreamCounts.delete(sessionId);
      } else {
        this.eventStreamCounts.set(sessionId, remaining);
      }
    };
  }

  removeSession(sessionId: string): void {
    this.clearTimer(sessionId);
    this.operationCounts.delete(sessionId);
    this.eventStreamCounts.delete(sessionId);
    this.lastActivityAt.delete(sessionId);
  }

  scheduleIdleCleanup(sessionId: string): void {
    const timeout = this.options.idleTimeoutMs;
    if (
      !Number.isFinite(timeout) ||
      timeout <= 0 ||
      this.getInFlightOperations(sessionId) > 0
    ) {
      return;
    }

    this.clearTimer(sessionId);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      if (this.getInFlightOperations(sessionId) > 0) {
        this.scheduleIdleCleanup(sessionId);
        return;
      }

      void this.options.cleanup(sessionId).catch((error) => {
        this.options.onCleanupError?.(sessionId, error);
      });
    }, timeout);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  getInFlightOperations(sessionId: string): number {
    return this.operationCounts.get(sessionId) || 0;
  }

  getOpenEventStreams(sessionId: string): number {
    return this.eventStreamCounts.get(sessionId) || 0;
  }

  getSnapshot(sessionId: string): StreamableSessionActivitySnapshot {
    const lastActivityAt = this.lastActivityAt.get(sessionId) || Date.now();
    return {
      sessionId,
      inFlightOperations: this.getInFlightOperations(sessionId),
      openEventStreams: this.getOpenEventStreams(sessionId),
      lastActivityAt,
      idleMs: Math.max(0, Date.now() - lastActivityAt),
    };
  }

  getTotalInFlightOperations(): number {
    return Array.from(this.operationCounts.values()).reduce(
      (total, count) => total + count,
      0,
    );
  }

  getTotalOpenEventStreams(): number {
    return Array.from(this.eventStreamCounts.values()).reduce(
      (total, count) => total + count,
      0,
    );
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }
}
