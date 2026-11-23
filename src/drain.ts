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
