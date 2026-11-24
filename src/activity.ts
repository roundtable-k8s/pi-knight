/**
 * Live task activity events (roundtable-k8s/roundtable#249).
 *
 * Core-NATS, fire-and-forget events on `<prefix>.activity.<Knight>.<taskId>` so a dashboard
 * can see what a pod is doing before the result lands. Never JetStream, never fatal:
 * a publish failure is logged at debug and the task carries on. Every free-text field is
 * redacted and bounded (500 chars previews, 200 chars argument summaries, 8 KiB per event).
 *
 * Also keeps the registry of in-flight tasks that introspection reports (`inflight`).
 */
import os from "node:os";
import type { KnightConfig } from "./config.js";
import { log } from "./logger.js";
import { getConnection, StringCodec } from "./nats.js";
import { redactSecrets } from "./hooks.js";

const sc = StringCodec();

export const ACTIVITY_VERSION = 1;
export const MAX_EVENT_BYTES = 8 * 1024;
export const MAX_PREVIEW_CHARS = 500;
export const MAX_ARGS_CHARS = 200;
/** Per-task cap on tool/assistant events; lifecycle events and heartbeats are exempt. */
export const MAX_EVENTS_PER_SEC = 20;

export type ActivityType =
  | "task.started"
  | "task.heartbeat"
  | "task.finished"
  | "tool.started"
  | "tool.finished"
  | "assistant.message";

export interface ActivityEvent {
  v: number;
  type: ActivityType;
  ts: string;
  knight: string;
  pod: string;
  node?: string;
  taskId: string;
  runId?: string;
  chainName?: string;
  stepName?: string;
  model: string;
  seq: number;
  truncated?: boolean;
  [field: string]: unknown;
}

export interface PodIdentity {
  pod: string;
  node?: string;
}

/** Pod identity from the downward API env (POD_NAME / NODE_NAME), falling back to the hostname. */
export function podIdentity(): PodIdentity {
  return { pod: process.env.POD_NAME || os.hostname(), node: process.env.NODE_NAME || undefined };
}

/** `<prefix>` from `<prefix>.results`. */
export function natsPrefix(config: Pick<KnightConfig, "natsResultsPrefix">): string {
  return config.natsResultsPrefix.replace(/\.results$/, "");
}

export interface TaskMeta {
  taskId: string;
  runId?: string;
  chainName?: string;
  stepName?: string;
  model: string;
  /** ms between publish and pickup, when the dispatcher stamped the task. */
  queuedFor?: number;
}

export interface InflightTask {
  taskId: string;
  runId?: string;
  chainName?: string;
  stepName?: string;
  model: string;
  startedAt: string;
  lastHeartbeatAt: string;
}

const inflight = new Map<string, InflightTask>();

/** Tasks currently executing on this pod (what introspect `stats` reports). */
export function listInflight(): InflightTask[] {
  return [...inflight.values()];
}

// ─── Bounding + redaction helpers ───────────────────────────────────

/** Redact secrets, then cut to `max` chars. Returns the text and whether it was cut. */
export function boundText(text: string, max: number): { text: string; truncated: boolean } {
  // Pre-cut so redaction never scans megabytes of tool output. Redact BEFORE the final
  // cut so a secret straddling the limit is replaced whole instead of half-leaked.
  const pre = text.length > max * 8 ? text.slice(0, max * 8) : text;
  const clean = redactSecrets(pre);
  if (clean.length <= max && pre.length === text.length) return { text: clean, truncated: false };
  return { text: clean.slice(0, max), truncated: true };
}

// Argument keys whose values are file contents or credentials: never summarised.
const SENSITIVE_ARG = /^(content|contents|text|new_?string|old_?string|new_?text|old_?text|data|body|env|headers?|authorization|token|password|secret|api_?key)$/i;

/** Short `key=value` summary of tool arguments, without file contents or credentials. */
export function summarizeArgs(args: unknown): { text: string; truncated: boolean } {
  let raw: string;
  let cut = false;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    raw = Object.entries(args as Record<string, unknown>)
      .map(([k, v]) => {
        if (SENSITIVE_ARG.test(k)) return `${k}=<omitted>`;
        const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
        if (s.length > 120) cut = true;
        return `${k}=${s.length > 120 ? s.slice(0, 120) + "…" : s}`;
      })
      .join(" ");
  } else {
    raw = typeof args === "string" ? args : JSON.stringify(args) ?? "";
  }
  const b = boundText(raw, MAX_ARGS_CHARS);
  return cut ? { ...b, truncated: true } : b;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as any).type === "text" ? String((b as any).text ?? "") : ""))
    .join("");
}

/** Serialize an event within MAX_EVENT_BYTES, shedding previews first if it is oversized. */
export function encodeEvent(ev: ActivityEvent): string {
  let json = JSON.stringify(ev);
  if (Buffer.byteLength(json) <= MAX_EVENT_BYTES) return json;
  const slim: ActivityEvent = { ...ev, truncated: true };
  for (const k of ["preview", "argsSummary", "currentTool", "error"]) delete slim[k];
  json = JSON.stringify(slim);
  if (Buffer.byteLength(json) <= MAX_EVENT_BYTES) return json;
  // Pathological identity fields (huge model/stepName): keep only the routing keys.
  const { v, type, ts, knight, pod, taskId, seq } = ev;
  return JSON.stringify({ v, type, ts, knight, pod, taskId: String(taskId).slice(0, 200), seq, truncated: true });
}

/** Subject token safe for a NATS subject (no dots, wildcards or spaces). */
export function subjectToken(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_") || "_";
}

// ─── Publisher ──────────────────────────────────────────────────────

export type ActivityPublish = (subject: string, data: string) => void;

let publishImpl: ActivityPublish = (subject, data) => {
  getConnection()?.publish(subject, sc.encode(data));
};
/** @internal test-only: replace the NATS publish. */
export function __setActivityPublishForTests(f: ActivityPublish | null): void {
  publishImpl = f ?? ((subject, data) => void getConnection()?.publish(subject, sc.encode(data)));
}

export interface ActivityOptions {
  /** `none` drops previews, argument summaries and message text. Default `preview`. */
  content?: "none" | "preview";
  now?: () => number;
}

/** Activity stream for one task. All methods are safe to call at any time and never throw. */
export class TaskActivity {
  private seq = 0;
  private done = false;
  private tokens = { input: 0, output: 0, cacheRead: 0 };
  private cost = 0;
  private turns = 0;
  private currentTool: string | undefined;
  private toolStart = new Map<string, { at: number; name: string }>();
  private bucket = MAX_EVENTS_PER_SEC;
  private bucketAt: number;
  private readonly id: PodIdentity;
  private readonly subject: string;
  private readonly now: () => number;
  private readonly content: "none" | "preview";
  private unsub: (() => void) | undefined;
  private startedMs: number;

  constructor(private readonly config: KnightConfig, private readonly meta: TaskMeta, opts: ActivityOptions = {}) {
    this.id = podIdentity();
    this.subject = `${natsPrefix(config)}.activity.${subjectToken(config.knightName)}.${subjectToken(meta.taskId)}`;
    this.now = opts.now ?? Date.now;
    this.content = opts.content ?? "preview";
    this.bucketAt = this.now();
    this.startedMs = this.now();
  }

  private emit(type: ActivityType, fields: Record<string, unknown> = {}, droppable = false): void {
    try {
      if (droppable && !this.takeToken()) {
        this.seq++; // consume a seq so consumers can see the gap
        return;
      }
      const ev: ActivityEvent = {
        v: ACTIVITY_VERSION,
        type,
        ts: new Date(this.now()).toISOString(),
        knight: this.config.knightName,
        pod: this.id.pod,
        ...(this.id.node ? { node: this.id.node } : {}),
        taskId: this.meta.taskId,
        ...(this.meta.runId ? { runId: this.meta.runId } : {}),
        ...(this.meta.chainName ? { chainName: this.meta.chainName } : {}),
        ...(this.meta.stepName ? { stepName: this.meta.stepName } : {}),
        model: this.meta.model,
        seq: this.seq++,
        ...fields,
      };
      publishImpl(this.subject, encodeEvent(ev));
    } catch (err) {
      log.debug("Activity publish failed", { type, error: String(err) });
    }
  }

  private takeToken(): boolean {
    const t = this.now();
    this.bucket = Math.min(MAX_EVENTS_PER_SEC, this.bucket + ((t - this.bucketAt) / 1000) * MAX_EVENTS_PER_SEC);
    this.bucketAt = t;
    if (this.bucket < 1) return false;
    this.bucket -= 1;
    return true;
  }

  private text(s: string, max = MAX_PREVIEW_CHARS): Record<string, unknown> {
    if (this.content === "none") return {};
    const b = boundText(s, max);
    return { preview: b.text, ...(b.truncated ? { truncated: true } : {}) };
  }

  started(slot: number, concurrency: number): void {
    const at = new Date(this.now()).toISOString();
    inflight.set(this.meta.taskId, {
      taskId: this.meta.taskId,
      ...(this.meta.runId ? { runId: this.meta.runId } : {}),
      ...(this.meta.chainName ? { chainName: this.meta.chainName } : {}),
      ...(this.meta.stepName ? { stepName: this.meta.stepName } : {}),
      model: this.meta.model,
      startedAt: at,
      lastHeartbeatAt: at,
    });
    this.emit("task.started", {
      slot,
      concurrency,
      ...(this.meta.queuedFor !== undefined ? { queuedFor: this.meta.queuedFor } : {}),
    });
  }

  heartbeat(): void {
    const rec = inflight.get(this.meta.taskId);
    if (rec) rec.lastHeartbeatAt = new Date(this.now()).toISOString();
    this.emit("task.heartbeat", {
      turns: this.turns,
      tokens: { ...this.tokens },
      cost: this.cost,
      ...(this.currentTool ? { currentTool: this.currentTool } : {}),
    });
  }

  finished(r: { success: boolean; error?: string; cost?: number; tokens?: { input: number; output: number; cacheRead?: number } }): void {
    if (this.done) return; // a late publishResult failure must not emit a second task.finished
    this.done = true;
    inflight.delete(this.meta.taskId);
    this.detach();
    const err = r.error ? boundText(r.error, MAX_PREVIEW_CHARS) : undefined;
    this.emit("task.finished", {
      success: r.success,
      ...(err ? { error: err.text, errorClass: classifyError(r.error!), ...(err.truncated ? { truncated: true } : {}) } : {}),
      durationMs: this.now() - this.startedMs,
      cost: r.cost ?? this.cost,
      tokens: r.tokens ?? { ...this.tokens },
    });
  }

  /** Subscribe to a session's events. No-op for sessions without `subscribe`. */
  attach(session: { subscribe?: (l: (e: any) => void) => () => void }): void {
    this.detach();
    try {
      this.unsub = session.subscribe?.((e) => this.onSessionEvent(e));
    } catch (err) {
      log.debug("Activity subscribe failed", { error: String(err) });
    }
  }

  detach(): void {
    try {
      this.unsub?.();
    } catch {
      // ignore
    }
    this.unsub = undefined;
  }

  /** Map a pi session event to an activity event. Exposed for tests. */
  onSessionEvent(e: any): void {
    try {
      switch (e?.type) {
        case "tool_execution_start": {
          this.currentTool = e.toolName;
          this.toolStart.set(e.toolCallId, { at: this.now(), name: e.toolName });
          const a = this.content === "none" ? undefined : summarizeArgs(e.args);
          this.emit("tool.started", {
            tool: e.toolName,
            toolCallId: e.toolCallId,
            ...(a ? { argsSummary: a.text, ...(a.truncated ? { truncated: true } : {}) } : {}),
          }, true);
          break;
        }
        case "tool_execution_end": {
          const st = this.toolStart.get(e.toolCallId);
          this.toolStart.delete(e.toolCallId);
          if (this.currentTool === e.toolName) this.currentTool = undefined;
          this.emit("tool.finished", {
            tool: e.toolName,
            toolCallId: e.toolCallId,
            durationMs: e.durationMs ?? (st ? this.now() - st.at : 0),
            isError: !!e.isError,
            ...this.text(contentText(e.result?.content)),
          }, true);
          break;
        }
        case "message_end": {
          const m = e.message;
          if (m?.role !== "assistant") break;
          this.turns++;
          const u = m.usage;
          if (u) {
            const add = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
            this.tokens.input += add(u.input);
            this.tokens.output += add(u.output);
            this.tokens.cacheRead += add(u.cacheRead);
            this.cost += add(u.cost?.total);
          }
          const text = contentText((m.content ?? []).filter((b: any) => b?.type === "text"));
          if (text.trim()) this.emit("assistant.message", this.text(text), true);
          break;
        }
      }
    } catch (err) {
      log.debug("Activity event mapping failed", { error: String(err) });
    }
  }
}

/** Coarse error class for dashboards. */
export function classifyError(error: string): "timeout" | "aborted" | "model" | "error" {
  if (/timed? ?out|timeout/i.test(error)) return "timeout";
  if (/abort/i.test(error)) return "aborted";
  if (/model|provider|rate.?limit|overloaded|context/i.test(error)) return "model";
  return "error";
}
