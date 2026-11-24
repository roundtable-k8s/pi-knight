import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveModel, createTrustedSettingsManager, type ResolvedModel } from "./model.js";
import type { KnightConfig } from "./config.js";
import { log } from "./logger.js";
import { natsTools, setKnightName, setNatsPrefix } from "./tools/nats.js";
import { subagentTools, setParentModel, setParentKnight } from "./tools/subagent.js";
import { browserTools } from "./tools/browser.js";
import type { TaskActivity } from "./activity.js";
import { toolHooksExtension } from "./hooks.js";
import { setupCompactionHook, updateSessionNotes } from "./memory.js";
import { pruneSessionFiles } from "./sessions.js";
import { extractStructured, type PRRef, type Verdict } from "./structured.js";
import { describeSessionFailure, getBestAssistantResult, refusalCode, resolveTaskOutcome, summarizeSessionTail } from "./result-extraction.js";


export interface TaskResult {
  result: string;
  /** False when the agent produced no deliverable output — the result is an error
   *  message, not a real answer. Lets consumers see the failure honestly. (#31) */
  success: boolean;
  /** Populated when success is false. */
  error?: string;
  cost: number;
  tokens: { input: number; output: number; cacheRead: number };
  model: string;
  toolCalls: number;
  /** Pull requests this task opened or updated (omitted when none). */
  prs?: PRRef[];
  /** Review verdict from a final "Verdict:" line (omitted when none). */
  verdict?: Verdict;
  /** Machine-readable refusal reason (omitted unless the provider refused the
   *  task for affordability, e.g. OpenRouter 402 "more credits, or fewer
   *  max_tokens") so the pipeline can defer instead of escalating. (#79) */
  refused?: "credits";
}

/**
 * One live session per chain run (key `run:<runId>`), each with its own lock: steps of
 * one run stay serialised on one shared session, sessions of different runs execute
 * concurrently. A run-less task gets its own fresh session (`task:<taskId>`) so
 * unrelated tasks never share context (#53). Nothing is resumed from PVC history at
 * startup: createAgentSession is given no sessionManager, so pi creates a new file.
 *
 * The map is in LRU order and capped; only idle sessions are evicted (and disposed).
 */
interface SessionSlot {
  key: string;
  runId?: string;
  session: AgentSession | null;
  /** Tail of this session's prompt queue. */
  lock: Promise<void>;
  /** Tasks holding or waiting for the lock — a busy slot is never evicted. */
  pending: number;
}
const slots = new Map<string, SessionSlot>();
let lastActive: SessionSlot | null = null;

/** Where per-task workspaces live: <root>/<runId|taskId>. Overridable for tests. */
const WORK_ROOT = () => process.env.KNIGHT_WORK_ROOT ?? "/data/work";
const MIN_SESSIONS = 8;

/** Get the most recently used session (or null). Used by introspect. */
export function getActiveSession(): AgentSession | null {
  return lastActive?.session ?? null;
}

/**
 * Find a live session by run id (also matches a run-less task's id) or by pi session id.
 * Used by introspect `recent`/`tree` so a request can target one run instead of "most recent".
 */
export function findSession(sel: { runId?: string; sessionId?: string }): AgentSession | null {
  for (const slot of slots.values()) {
    if (!slot.session) continue;
    if (sel.runId && (slot.key === `run:${sel.runId}` || slot.key === `task:${sel.runId}`)) return slot.session;
    if (sel.sessionId && slot.session.getSessionStats().sessionId === sel.sessionId) return slot.session;
  }
  return null;
}

/** All live sessions, for shutdown. */
export function getActiveSessions(): AgentSession[] {
  return [...slots.values()].flatMap((s) => (s.session ? [s.session] : []));
}

/**
 * Warm up at startup (fire-and-forget): create and immediately dispose a throwaway
 * session, so the cold-start cost (observed ~79s on knights with long PVC history)
 * lands here instead of inside the first task's timeout window. Sessions are bound to
 * their task's working directory, so the warm one cannot be adopted. Failures are only logged.
 */
export function warmSession(config: KnightConfig): void {
  const cwd = join(WORK_ROOT(), ".warm");
  mkdir(cwd, { recursive: true })
    .then(() => sessionFactory(config, cwd))
    .then((s) => {
      s.dispose();
      log.info("Session pre-warmed at startup");
    })
    .catch((err) => log.warn("Session pre-warm failed — first task pays the cold start", { error: String(err) }))
    .finally(() => rm(cwd, { recursive: true, force: true }).catch(() => {}));
}

/**
 * Enforce the on-disk session retention policy (fire-and-forget). Per-run sessions
 * each persist their own JSONL file, so without this the PVC grows with every chain
 * run. Live sessions' files are always kept.
 */
export function pruneOldSessions(config: KnightConfig): void {
  const keep = new Set<string>();
  for (const s of getActiveSessions()) {
    const live = s.sessionManager.getSessionFile();
    if (live) keep.add(live);
  }
  pruneSessionFiles(
    {
      maxFiles: config.sessionRetentionMaxFiles,
      maxAgeMs: config.sessionRetentionDays * 24 * 60 * 60 * 1000,
    },
    keep,
  )
    .then((removed) => {
      if (removed.length > 0) log.info("Pruned old session files", { count: removed.length });
    })
    .catch((err) => log.warn("Session retention prune failed", { error: String(err) }));
}

function getSlot(key: string, runId: string | undefined, config: KnightConfig): SessionSlot {
  let slot = slots.get(key);
  if (slot) {
    slots.delete(key); // re-insert at the MRU end
  } else {
    slot = { key, runId, session: null, lock: Promise.resolve(), pending: 0 };
  }
  slots.set(key, slot);
  const cap = Math.max(MIN_SESSIONS, (config.maxConcurrentTasks ?? 1) * 4);
  for (const [k, s] of slots) {
    if (slots.size <= cap) break;
    if (s.pending > 0 || k === key) continue;
    dropSlot(s);
  }
  return slot;
}

function dropSlot(slot: SessionSlot): void {
  slots.delete(slot.key);
  if (lastActive === slot) lastActive = null;
  try {
    slot.session?.dispose();
  } catch (err) {
    log.warn("Failed to dispose session", { key: slot.key, error: String(err) });
  }
}

// Seam so tests can exercise per-task model resolution without a real ModelRuntime.
let taskModelResolver: (modelStr: string) => Promise<Pick<ResolvedModel, "model">> = (m) =>
  resolveModel(m, { strict: true });
/** @internal test-only: replace per-task model resolution. */
export function __setTaskModelResolverForTests(
  f: ((modelStr: string) => Promise<Pick<ResolvedModel, "model">>) | null,
): void {
  taskModelResolver = f ?? ((m) => resolveModel(m, { strict: true }));
}

// Seam so tests can exercise executeTask without a real model/SDK session.
let sessionFactory: (config: KnightConfig, cwd: string) => Promise<AgentSession> = (c, cwd) => createSession(c, cwd);
/** @internal test-only: replace session creation and reset module session state. */
export function __setSessionFactoryForTests(
  f: ((config: KnightConfig, cwd: string) => Promise<AgentSession>) | null,
): void {
  sessionFactory = f ?? ((c, cwd) => createSession(c, cwd));
  slots.clear();
  lastActive = null;
}

/**
 * Per-task workspace directory name, filesystem-safe. Prefixed `run-` / `task-` to mirror
 * the slot key, so a run-less taskId can never share a dir with a concurrent run's id.
 */
export function workspaceName(runId: string | undefined, taskId: string): string {
  const safe = (runId || taskId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "x";
  return `${runId ? "run" : "task"}-${safe}`;
}

async function createSession(config: KnightConfig, cwd: string): Promise<AgentSession> {
  const tStart = Date.now();
  const { model, provider, modelName, modelRuntime } = await resolveModel(config.knightModel);
  const resolveModelMs = Date.now() - tStart;

  log.info("Creating session", { provider, model: modelName, cwd });

  setKnightName(config.knightName);
  // Derive NATS prefix from results prefix (e.g. "rt-dev.results" → "rt-dev")
  setNatsPrefix(config.natsResultsPrefix.replace(/\.results$/, ""));
  setParentModel(config.knightModel);
  setParentKnight(config.knightName);

  const thinkingLevel = (config.thinkingLevel ?? "off") as ThinkingLevel;

  // createAgentSession does not reload a caller-supplied loader: reload() is what discovers
  // skills and loads the inline tool-hook extension.
  const settingsManager = createTrustedSettingsManager("/data", "/data");
  // In-memory overrides (never written to /data): env-driven retry cap and thinking budgets.
  settingsManager.applyOverrides({
    retry: { provider: { maxRetryDelayMs: config.maxRetryDelayMs } },
    ...(thinkingLevel !== "off" && {
      thinkingBudgets: {
        low: config.thinkingBudgetLow,
        medium: config.thinkingBudgetMedium,
        high: config.thinkingBudgetHigh,
      },
    }),
  });
  log.info("Retry delay cap configured", { maxRetryDelayMs: config.maxRetryDelayMs });
  const resourceLoader = new DefaultResourceLoader({
    cwd: "/data",
    agentDir: "/data",
    settingsManager,
    additionalSkillPaths: ["/skills"],
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [{ name: "knight-tool-hooks", factory: toolHooksExtension, hidden: true }],
    systemPrompt: buildKnightPreamble(config),
  });
  await resourceLoader.reload();

  const tCreate = Date.now();
  const { session: newSession } = await createAgentSession({
    model,
    thinkingLevel,
    cwd,
    agentDir: "/data",
    modelRuntime,
    // Explicitly trust the project dir; see model.ts.
    settingsManager,
    customTools: [
      ...natsTools,
      ...subagentTools,
      ...(process.env.BROWSER_ENABLED === "true" ? browserTools : []),
    ],
    resourceLoader,
  });

  const createAgentSessionMs = Date.now() - tCreate;

  // Configure the session fully before publishing it to the module-level
  // `session` — a task arriving mid-pre-warm must never see a session whose
  // hooks aren't installed yet.

  // Install custom compaction hook — knight-specific context preservation
  setupCompactionHook(newSession, config);

  // Context reduction is handled entirely by Pi's built-in compaction (summarizes and
  // resets the prefix cleanly when context approaches the window). We deliberately do NOT
  // install a transformContext prune: truncating old messages mutates the prompt prefix and
  // busts provider prompt caching, which is the main cost lever for these persistent sessions.

  // Log active tool names at session create time so we can verify custom tools
  // are actually registered with the agent (not just in the tool registry).
  try {
    const activeToolNames = (newSession.agent.state?.tools ?? []).map((t: any) => t?.name).filter(Boolean);
    log.info("Agent active tools", {
      count: activeToolNames.length,
      names: activeToolNames,
    });
  } catch (err) {
    log.warn("Failed to introspect active tools", { error: String(err) });
  }

  // Log baseline stats (session may have prior history from PVC).
  // Phase timings answer "what eats a slow cold start" (observed 79s on a
  // knight with PVC history): createAgentSessionMs covers history load +
  // model registry; anything else shows up in the total.
  const stats = newSession.getSessionStats();
  log.info("Session created", {
    sessionId: stats.sessionId,
    priorMessages: stats.totalMessages,
    priorCost: stats.cost,
    resolveModelMs,
    createAgentSessionMs,
    totalMs: Date.now() - tStart,
  });

  return newSession;
}

/**
 * Execute a task on its run's session (see SessionSlot).
 *
 * Tasks of one chain run (same runId) are prompts on the same session and share
 * context, serialised. A task without a runId, or with a different one, gets its own
 * session and runs concurrently (#53) — cross-task memory lives in files on the PVC. Pi SDK auto-compacts when
 * context grows too large.
 */
export async function executeTask(
  task: string,
  config: KnightConfig,
  signal?: AbortSignal,
  runId?: string,
  taskId?: string,
  opts: { model?: string; activity?: TaskActivity } = {},
): Promise<TaskResult> {
  // Same runId → same session, queued behind that run's earlier steps; anything else
  // runs on its own session, concurrently. Run-less tasks never share one (#31, #53).
  const id = taskId || randomUUID();
  const slot = getSlot(runId ? `run:${runId}` : `task:${id}`, runId || undefined, config);
  const prevLock = slot.lock;
  let releaseLock!: () => void;
  slot.lock = new Promise((resolve) => { releaseLock = resolve; });
  slot.pending++;
  await prevLock;

  // Resolve a per-task model override before touching the session: an unresolvable model is
  // a task error (thrown to the caller), never a silent fallback to the knight default.
  // Done after taking the run's queue position so steps of a run keep their arrival order.
  const taskModel = opts.model?.trim() || undefined;
  const modelUsed = taskModel ?? config.knightModel;
  let override: Awaited<ReturnType<typeof taskModelResolver>> | undefined;
  try {
    override = taskModel ? await taskModelResolver(taskModel) : undefined;
  } catch (err) {
    slot.pending--;
    releaseLock();
    if (!slot.session && slot.pending === 0) slots.delete(slot.key);
    throw err;
  }

  const workDir = join(WORK_ROOT(), workspaceName(runId, id));
  let sess: AgentSession;
  let created = false;
  try {
    await mkdir(workDir, { recursive: true });
    if (!slot.session) {
      slot.session = await sessionFactory(config, workDir);
      created = true;
    }
    sess = slot.session;
  } catch (err) {
    // Session creation failed: release the lock or later steps of this run would wait forever.
    slot.pending--;
    releaseLock();
    if (!slot.session && slot.pending === 0) slots.delete(slot.key);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  lastActive = slot;
  if (created) pruneOldSessions(config);

  // Snapshot stats before this task
  const statsBefore = sess.getSessionStats();
  const messagesBefore = (sess as unknown as { messages?: unknown[] }).messages?.length ?? 0;
  const costBefore = statsBefore.cost;
  const toolCallsBefore = statsBefore.toolCalls;
  const tokensBefore = {
    input: statsBefore.tokens.input,
    output: statsBefore.tokens.output,
    cacheRead: statsBefore.tokens.cacheRead,
  };

  log.info("Executing task", { model: modelUsed, taskLength: task.length, runId: runId ?? null, workDir });

  // Abort handling — if signal fires, abort the session
  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      log.warn("Task aborted via signal");
      sess.abort();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  // Switch this run's own session to the per-task model (we hold the slot lock), then
  // restore the knight default afterwards so later steps of the run get it back.
  const defaultModel = override ? sess.model : undefined;
  let promptFailed = true;
  try {
    if (override) {
      try {
        await sess.setModel(override.model);
      } catch (err) {
        throw new Error(`Cannot use model "${taskModel}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    opts.activity?.attach(sess);
    await sess.prompt(task);
    promptFailed = false;
  } finally {
    opts.activity?.detach();
    if (defaultModel) {
      await sess.setModel(defaultModel).catch((err) => {
        log.warn("Failed to restore knight default model after task", { error: String(err) });
      });
    }
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    // Removed after each task (a run's next step recreates it); kept on failure only with DEBUG.
    // Must finish before the lock is released, or it would delete the next step's fresh dir.
    if (!(promptFailed && process.env.DEBUG)) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    slot.pending--;
    releaseLock();
  }

  // Diff stats to get this task's contribution. Clamp at 0: session-cumulative stats
  // are normally monotonic, but routing models (e.g. openrouter/auto) can switch the
  // underlying model between turns and report usage non-monotonically, yielding a negative
  // delta. A negative value would throw in prom-client (Counter.inc cannot decrease) and
  // crash the task in the stats layer, so we never let a per-task delta go below zero.
  const statsAfter = sess.getSessionStats();
  // Non-negative AND finite: routing/custom models can report missing or non-monotonic
  // usage, yielding a negative or NaN diff — either of which throws in prom-client.
  const delta = (after: number, before: number) => {
    const d = after - before;
    return Number.isFinite(d) ? Math.max(0, d) : 0;
  };
  const taskCost = delta(statsAfter.cost, costBefore);
  const taskToolCalls = delta(statsAfter.toolCalls, toolCallsBefore);
  const taskTokens = {
    input: delta(statsAfter.tokens.input, tokensBefore.input),
    output: delta(statsAfter.tokens.output, tokensBefore.output),
    cacheRead: delta(statsAfter.tokens.cacheRead, tokensBefore.cacheRead),
  };

  // Extract the most recent real deliverable, not an intermediate tool-call payload.
  // When the agent yields nothing deliverable, report an explicit failure instead of
  // publishing a sentinel as a successful result, so consumers see the failure. (#31)
  // A silent LLM error or abort (the Pi loop records those on the final assistant
  // message and resolves prompt() normally) is surfaced as the failure reason rather
  // than being masked by the generic no-output message.
  const deliverable = getBestAssistantResult(sess);
  const failureReason = deliverable == null
    ? describeSessionFailure(sess, signal?.aborted ?? false)
    : undefined;
  const { result: resultText, success, error } = resolveTaskOutcome(deliverable, failureReason);
  const refused = success ? undefined : refusalCode(error);
  if (!success) {
    log.warn("Task produced no deliverable", {
      error,
      refused: refused ?? null,
      taskLength: task.length,
      runId: runId ?? null,
      sessionTail: summarizeSessionTail(sess),
    });
  }

  // Structured prs/verdict, from only this task's messages (the session is shared per run).
  const taskMessages = ((sess as unknown as { messages?: unknown[] }).messages ?? []).slice(messagesBefore);
  const structured = success ? extractStructured(taskMessages, resultText) : { prs: [] as PRRef[] };

  // Update session notes after each task (fire-and-forget)
  updateSessionNotes(config.knightName, task, resultText).catch((err) => {
    log.warn("Failed to update session notes", { error: String(err) });
  });

  // Prompt-cache hit rate = cached / (fresh input + cached). Surfaces whether the
  // stable prefix is actually being reused (the main cost lever for these sessions).
  const billedInput = taskTokens.input + taskTokens.cacheRead;
  const cacheHitRate = billedInput > 0 ? taskTokens.cacheRead / billedInput : 0;

  log.info("Task completed", {
    inputTokens: taskTokens.input,
    cachedInputTokens: taskTokens.cacheRead,
    cacheHitRate: Number(cacheHitRate.toFixed(2)),
    outputTokens: taskTokens.output,
    cost: taskCost,
    toolCalls: taskToolCalls,
  });

  return {
    result: resultText,
    success,
    error,
    cost: taskCost,
    tokens: taskTokens,
    model: modelUsed,
    toolCalls: taskToolCalls,
    ...(structured.prs.length > 0 ? { prs: structured.prs } : {}),
    ...(structured.verdict ? { verdict: structured.verdict } : {}),
    ...(refused ? { refused } : {}),
  };
}

/**
 * Build a short preamble identifying the knight.
 * Skills, AGENTS.md, personality files are handled by Pi SDK's resource loader.
 */
/**
 * Build the system prompt preamble for this knight.
 *
 * This is injected BEFORE AGENTS.md/SOUL.md (which the resource loader handles).
 * Keep it focused on runtime identity and behavioral guardrails that apply
 * to ALL knights regardless of their individual personality.
 *
 * Pattern: Explicit negative instructions + reasoning (from Claude Code leak analysis).
 */
function buildKnightPreamble(config: KnightConfig): string {
  return `You are ${config.knightName}, a Knight of the Round Table.
You are a specialized AI agent running as a Kubernetes pod in the Round Table fleet.
The current model is ${config.knightModel}.

<runtime_context>
Knight: ${config.knightName}
Model: ${config.knightModel}
Workspace: /data (persistent PVC — survives restarts)
Skills: /skills (read-only, operator-managed)
Vault: /vault (Derek's Obsidian vault — write only to Briefings/ and Roundtable/)
</runtime_context>

<default_to_action>
By default, implement changes rather than only suggesting them. If the task's intent is
unclear, infer the most useful likely action and proceed, using tools to discover any
missing details instead of guessing. Your text response IS the deliverable — when asked
to write a report, your response IS that report. Never describe what you would write.
</default_to_action>

<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the calls,
make all independent calls in parallel. For example, when reading 3 files, read all 3
at once. Maximize parallel tool calls where possible. However, if some calls depend on
previous results, call those sequentially. Never use placeholders or guess missing
parameters in tool calls.
</use_parallel_tool_calls>

<critical_rules>
1. Read MEMORY.md and SOUL.md at the start of each task for accumulated context.
2. Log your work to memory/YYYY-MM-DD.md after each task.
3. NEVER truncate results. If the task asks for full output, provide full output.
4. NEVER create files unless necessary for the task. Prefer editing existing files.
5. If a tool call fails, understand WHY before retrying — don't loop on the same error.
6. Prefer targeted file reads (offset/limit) over loading entire files.
7. ALWAYS end the task with a final plain-text message stating the result or deliverable.
   The runtime publishes that final text as your task result — if you stop after a tool
   call, or end with an empty message, the task is reported as FAILED with no output,
   even when the tool work itself succeeded. After tool use, summarize what you did and
   state the deliverable in text.
</critical_rules>`;
}
