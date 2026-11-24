import {
  connect as natsConnect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  StringCodec as NatsStringCodec,
  AckPolicy,
  DeliverPolicy,
} from "nats";
import { log } from "./logger.js";
import type { KnightConfig } from "./config.js";

const sc = NatsStringCodec();

// Re-export StringCodec for tools
export { NatsStringCodec as StringCodec };

export interface ParsedTask {
  task: string;
  taskId: string;
  domain?: string;
  from?: string;
  dispatchedBy?: string;
  timestamp?: string;
  timeoutMs?: number;
  /** Chain run identity (operator-assigned UUID). Used to start a fresh agent session
   *  per run and avoid cross-run context bleed. Optional — absent for ad-hoc tasks. (#31) */
  runId?: string;
  /** Chain / step names from the operator's TaskPayload (activity events, introspection). */
  chainName?: string;
  stepName?: string;
  /** Optional per-task model override ("provider/model"); applies to this task only. */
  model?: string;
}

/**
 * Normalize a task-metadata timeout to a positive, finite millisecond value, or undefined.
 *
 * A non-positive timeout (e.g. a dispatcher that marshals an omitted int field as 0) must not
 * be honored — `setTimeout(abort, 0)` cancels the task before any work happens, looking like a
 * model failure. Returning undefined lets the caller's `?? config.taskTimeoutMs` fallback win. (#30)
 */
export function normalizeTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Accept only a non-empty string run id; anything else means "no run identity". */
function normalizeRunId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parse a raw task message. The operator sends TaskPayload JSON
 * (`taskId`, `chainName`, `stepName`, `runId`, `task`); other dispatchers use
 * snake_case variants. Non-JSON payloads are treated as plain task text.
 */
export function parseTaskPayload(raw: string, subjectTaskId: string): ParsedTask {
  try {
    const json = JSON.parse(raw);
    if (json === null || typeof json !== "object") throw new Error("not an object");
    return {
      task: json.task ?? json.description ?? json.message ?? raw,
      taskId: json.task_id ?? json.taskId ?? subjectTaskId,
      domain: json.domain,
      from: json.from ?? json.payload?.from,
      dispatchedBy: json.dispatched_by ?? json.dispatchedBy,
      timestamp: json.timestamp,
      // Only honor a positive, finite timeout. A non-positive value (some dispatchers
      // marshal an omitted int field as 0) would otherwise abort the task on the next
      // tick; normalize it to undefined so the knight's configured timeout applies. (#30)
      timeoutMs: normalizeTimeoutMs(json.metadata?.timeout_ms ?? json.metadata?.timeoutMs),
      runId: normalizeRunId(json.runId ?? json.run_id),
      chainName: typeof (json.chainName ?? json.chain_name) === "string" ? (json.chainName ?? json.chain_name) : undefined,
      stepName: typeof (json.stepName ?? json.step_name) === "string" ? (json.stepName ?? json.step_name) : undefined,
      model: typeof json.model === "string" && json.model.trim() ? json.model.trim() : undefined,
    };
  } catch {
    // Not JSON (or not an object) — treat entire payload as task text
    return { task: raw, taskId: subjectTaskId };
  }
}

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let connected = false;

// --- Accessors for custom tools ---
export function getConnection(): NatsConnection | null { return nc; }
export function getJetStream(): JetStreamClient | null { return js; }

export function getStatus(): { connected: boolean } {
  return { connected };
}

export async function connectNats(config: KnightConfig): Promise<void> {
  log.info("Connecting to NATS", { url: config.natsUrl });

  nc = await natsConnect({
    servers: config.natsUrl,
    name: `pi-knight-${config.knightName}`,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  });

  connected = true;
  log.info("NATS connected");

  // Monitor connection status
  (async () => {
    if (!nc) return;
    for await (const status of nc.status()) {
      if (status.type === "disconnect" || status.type === "error") {
        connected = false;
        log.warn("NATS disconnected", { type: status.type });
      } else if (status.type === "reconnect") {
        connected = true;
        log.info("NATS reconnected");
      }
    }
  })();

  js = nc.jetstream();
}

/** Heartbeat window: the server redelivers (here: dead-letters) a task whose ack is overdue by this much. */
export const ACK_WAIT_MS = 30_000;
/** How often a running task sends an in-progress ack. Must be well under ACK_WAIT_MS. */
export const HEARTBEAT_MS = 10_000;
/** Max time one pull request waits for messages before it is re-issued. */
const FETCH_EXPIRES_MS = 5_000;

/** The subset of a JetStream message the puller needs (satisfied by nats.js JsMsg). */
export interface PulledMsg {
  data: Uint8Array;
  subject: string;
  ack(): void;
  working(): void;
  term(reason?: string): void;
}

/** A task taken from the stream. It stays un-acked until `ack()`; call `working()` to extend its ack window. */
export interface TaskDelivery {
  task: ParsedTask;
  /** In-progress ack: resets the server's ack_wait timer. */
  working(): void;
  /** Final ack — call once the task finished and its result was published. */
  ack(): void;
}

export interface PullLoopOptions {
  /** Pull up to `max` messages, waiting at most `expiresMs`. */
  fetch(max: number, expiresMs: number): Promise<AsyncIterable<PulledMsg>>;
  /** Free execution slots right now (maxConcurrentTasks - active). */
  freeSlots(): number;
  /** Called for each pulled task. Must count the slot as used synchronously. */
  onTask(delivery: TaskDelivery): void;
  /** Called for self-echo filtering etc. Return false to ack-and-drop the task. */
  accept?(task: ParsedTask): boolean;
  fetchExpiresMs?: number;
  /** Delay after a fetch error before retrying. */
  retryDelayMs?: number;
}

export interface TaskPuller {
  /** Call when a slot frees so the loop re-checks capacity immediately. */
  wake(): void;
  /** Stop pulling. Messages already handed to onTask are unaffected. */
  stop(): Promise<void>;
}

/**
 * Pull loop: only asks the server for as many messages as there are free slots, so
 * backlog stays in the stream (visible as consumer lag) rather than in process memory.
 */
export function startPullLoop(opts: PullLoopOptions): TaskPuller {
  let stopped = false;
  let wakeResolve: (() => void) | null = null;
  const sleepUnlessWoken = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); wakeResolve = null; resolve(); }
      wakeResolve = done;
    });

  const loop = (async () => {
    while (!stopped) {
      const free = opts.freeSlots();
      if (free <= 0) {
        await sleepUnlessWoken(1_000);
        continue;
      }
      try {
        const msgs = await opts.fetch(free, opts.fetchExpiresMs ?? FETCH_EXPIRES_MS);
        for await (const msg of msgs) {
          handleMsg(msg);
          if (stopped) break;
        }
      } catch (err) {
        if (stopped) break;
        log.warn("Task fetch failed — retrying", { error: err instanceof Error ? err.message : String(err) });
        await sleepUnlessWoken(opts.retryDelayMs ?? 2_000);
      }
    }
  })();

  function handleMsg(msg: PulledMsg): void {
    const raw = sc.decode(msg.data);
    const subject = msg.subject;
    const subjectTaskId = subject.split(".").pop() || "unknown";
    const parsed = parseTaskPayload(raw, subjectTaskId);

    // Reject empty/missing task text — don't waste an LLM call on nothing
    if (!parsed.task || parsed.task.trim().length === 0) {
      log.warn("Empty task payload — skipping", { taskId: parsed.taskId, subject, rawLength: raw.length });
      msg.term("empty task payload");
      return;
    }
    if (opts.accept && !opts.accept(parsed)) {
      msg.ack();
      return;
    }
    log.info("Task received", { taskId: parsed.taskId, subject });
    opts.onTask({ task: parsed, working: () => msg.working(), ack: () => msg.ack() });
  }

  return {
    wake: () => wakeResolve?.(),
    async stop() {
      stopped = true;
      wakeResolve?.();
      await loop.catch(() => {});
    },
  };
}

export interface SubscribeOptions {
  freeSlots(): number;
  onTask(delivery: TaskDelivery): void;
  accept?(task: ParsedTask): boolean;
  /**
   * A task was delivered to a knight that never acked it (pod crash / hang) and
   * max_deliver=1 forbids re-running it. Publish a failure result so the dispatcher is not left waiting.
   */
  onLost(task: ParsedTask): void | Promise<void>;
  /** Override the ack_wait heartbeat window (tests only). */
  ackWaitMs?: number;
}

/** Reconcile the durable pull consumer, start the pull loop and the lost-task watcher. */
export async function subscribe(config: KnightConfig, opts: SubscribeOptions): Promise<TaskPuller> {
  if (!nc || !js) throw new Error("NATS not connected");
  _config = config;

  const jsm: JetStreamManager = await nc.jetstreamManager();

  // Create/bind durable pull consumer
  const durableName = `${config.knightName}-consumer`;
  const filterSubjects = config.subscribeTopics;

  // Reconcile durable consumer. NATS does not allow updating deliver_policy or max_deliver
  // on an existing consumer, so those (and the filters) force a recreate; ack_wait can be
  // updated in place — which matters, because recreating a DeliverPolicy.All consumer can replay the stream.
  const ackWaitMs = opts.ackWaitMs ?? ACK_WAIT_MS;
  const desiredConfig = {
    durable_name: durableName,
    filter_subjects: filterSubjects,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    // A task that crashed mid-run is NOT re-run silently; it is reported as a failure (see watchLostTasks).
    max_deliver: 1,
    // Heartbeat window, not the task timeout: running tasks send working() every HEARTBEAT_MS.
    ack_wait: ackWaitMs * 1_000_000, // nanoseconds
  };

  let exists = false;
  try {
    const existing = await jsm.consumers.info(config.natsTasksStream, durableName);
    const existingFilters = existing.config.filter_subjects ??
      (existing.config.filter_subject ? [existing.config.filter_subject] : []);
    const filtersDiffer = JSON.stringify([...existingFilters].sort()) !== JSON.stringify([...filterSubjects].sort());
    const mustRecreate =
      filtersDiffer ||
      existing.config.deliver_policy !== DeliverPolicy.All ||
      existing.config.max_deliver !== 1;

    if (mustRecreate) {
      log.warn("Consumer config mismatch — recreating", {
        durable: durableName,
        reason: {
          filters: filtersDiffer,
          deliverPolicy: existing.config.deliver_policy !== DeliverPolicy.All,
          maxDeliver: existing.config.max_deliver !== 1,
        },
      });
      await jsm.consumers.delete(config.natsTasksStream, durableName);
    } else {
      exists = true;
      if (existing.config.ack_wait !== desiredConfig.ack_wait) {
        log.info("Updating consumer ack_wait in place", { durable: durableName, ackWaitMs });
        await jsm.consumers.update(config.natsTasksStream, durableName, { ack_wait: desiredConfig.ack_wait });
      } else {
        log.info("Consumer config matches — reusing", { durable: durableName, filters: existingFilters });
      }
    }
  } catch {
    log.info("No existing consumer found, creating new", { durable: durableName });
  }

  if (!exists) {
    await jsm.consumers.add(config.natsTasksStream, desiredConfig);
    log.info("Consumer ready", { durable: durableName, stream: config.natsTasksStream, filters: filterSubjects });
  }

  const pullConsumer = await js.consumers.get(config.natsTasksStream, durableName);
  const stopWatch = watchLostTasks(jsm, config.natsTasksStream, durableName, opts.onLost);
  const puller = startPullLoop({
    fetch: (max, expires) => pullConsumer.fetch({ max_messages: max, expires }),
    freeSlots: opts.freeSlots,
    onTask: opts.onTask,
    accept: opts.accept,
  });
  return {
    wake: puller.wake,
    async stop() {
      await puller.stop();
      stopWatch();
    },
  };
}

/**
 * Redelivery policy: max_deliver=1, so a task that was handed to a knight but never acked
 * (crash, OOM, hang past the heartbeat window) is not re-run. JetStream publishes a
 * MAX_DELIVERIES advisory for it; we load the original message by stream sequence and
 * report a failure result instead of losing it silently. The advisory subscription uses a
 * queue group so only one replica of the knight reports each lost task.
 */
function watchLostTasks(
  jsm: JetStreamManager,
  stream: string,
  durable: string,
  onLost: (task: ParsedTask) => void | Promise<void>,
): () => void {
  const sub = nc!.subscribe(`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${stream}.${durable}`, { queue: durable });
  (async () => {
    for await (const m of sub) {
      try {
        const adv = JSON.parse(sc.decode(m.data)) as { stream_seq?: number };
        if (typeof adv.stream_seq !== "number") continue;
        const stored = await jsm.streams.getMessage(stream, { seq: adv.stream_seq });
        const subjectTaskId = stored.subject.split(".").pop() || "unknown";
        const parsed = parseTaskPayload(sc.decode(stored.data), subjectTaskId);
        log.warn("Task delivered but never acked — reporting failure", { taskId: parsed.taskId, seq: adv.stream_seq });
        await onLost(parsed);
      } catch (err) {
        log.error("Failed to handle lost-task advisory", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  })();
  return () => sub.unsubscribe();
}

// Module-level config ref for publishResult (set during subscribe)
let _config: KnightConfig | null = null;

export async function publishResult(
  taskId: string,
  result: Record<string, unknown>,
): Promise<void> {
  if (!js) throw new Error("NATS not connected — cannot publish result");

  const prefix = _config?.natsResultsPrefix ?? "fleet-a.results";
  const subject = `${prefix}.${taskId}`;
  const data = sc.encode(JSON.stringify(result));
  await js.publish(subject, data);
  log.info("Result published", { taskId, subject });
}

export async function drain(): Promise<void> {
  if (nc) {
    await nc.drain();
    connected = false;
    log.info("NATS drained");
  }
}
