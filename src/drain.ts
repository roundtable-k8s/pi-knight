import { log } from "./logger.js";

export interface DrainOptions {
  /** Tasks currently executing. */
  getActive(): number;
  /** Longest wait for in-flight tasks (the pod grace period; kubelet SIGKILLs after it anyway). */
  maxWaitMs: number;
  pollMs?: number;
}

/**
 * Rollout drain: wait for in-flight tasks to finish. Their heartbeat (working()) timers keep
 * running and each task publishes its result and acks itself, so this only has to wait.
 * Returns the number of tasks still active when the wait ended (0 = clean drain).
 */
export async function waitForInflight(opts: DrainOptions): Promise<number> {
  const deadline = Date.now() + opts.maxWaitMs;
  const pollMs = opts.pollMs ?? 500;
  let lastLogged = -1;
  while (opts.getActive() > 0 && Date.now() < deadline) {
    const n = opts.getActive();
    if (n !== lastLogged) {
      log.info("Draining: waiting for in-flight tasks", { activeCount: n });
      lastLogged = n;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return opts.getActive();
}

export interface ShutdownDeps {
  /** /ready -> 503 so the pod leaves Service endpoints. */
  setDraining(draining: boolean): void;
  /** Stop fetching new tasks (resolves once the pull loop has ended). */
  stopPulling(): Promise<void>;
  getActive(): number;
  maxWaitMs: number;
  pollMs?: number;
  /** Close NATS after flushing pending publishes. */
  drainNats(): Promise<void>;
  /**
   * Forced path only (tasks still running at the deadline): abort them, e.g. dispose sessions.
   * Aborted tasks then get `abortGraceMs` to publish their failure result before NATS is drained.
   */
  abortInflight?(): void;
  abortGraceMs?: number;
  /** Final teardown after NATS is drained (metrics, health server). */
  cleanup?(): Promise<void> | void;
  exit(code: number): void;
}

/**
 * The shutdown sequence: setDraining → stop fetching → wait for in-flight → drain NATS → cleanup → exit.
 * Idempotent: a second signal while shutting down is ignored. This is the one function the
 * SIGTERM/SIGINT handlers call, and the one the tests exercise.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let shuttingDown = false;
  return async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutdown signal received — draining", { signal, activeCount: deps.getActive() });
    deps.setDraining(true);
    await deps.stopPulling();
    const left = await waitForInflight({ getActive: deps.getActive, maxWaitMs: deps.maxWaitMs, pollMs: deps.pollMs });
    if (left > 0) {
      log.warn("Forcing shutdown with active tasks", { activeCount: left });
      if (deps.abortInflight) {
        deps.abortInflight();
        // Let the aborted tasks' catch-branch publish their failure result before nc.drain()/exit.
        const stuck = await waitForInflight({
          getActive: deps.getActive,
          maxWaitMs: deps.abortGraceMs ?? 5000,
          pollMs: deps.pollMs,
        });
        if (stuck > 0) log.warn("Aborted tasks did not finish in time", { activeCount: stuck });
      }
    }
    await deps.drainNats().catch((e) => log.error("NATS drain error", { error: String(e) }));
    await deps.cleanup?.();
    log.info("Shutdown complete");
    deps.exit(0);
  };
}

/** Wire the shutdown function to the real signals (the target is injectable for tests). */
export function installSignalHandlers(
  shutdown: (signal: string) => Promise<void>,
  target: Pick<NodeJS.Process, "on"> = process,
): void {
  target.on("SIGTERM", () => void shutdown("SIGTERM"));
  target.on("SIGINT", () => void shutdown("SIGINT"));
}
