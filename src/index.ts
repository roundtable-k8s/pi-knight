import { loadConfig } from "./config.js";
import { initLogger, log } from "./logger.js";
import { connectNats, subscribe, publishResult, drain, HEARTBEAT_MS, type TaskDelivery } from "./nats.js";
import { createShutdown, installSignalHandlers } from "./drain.js";
import { startHealthServer, stopHealthServer, setSkillCount, setActiveTaskCount, setDegradedReason, setDraining } from "./health.js";
import { skillsExpected, waitForSkills } from "./skill-wait.js";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { executeTask, getActiveSessions, pruneOldSessions, warmSession } from "./knight.js";
import { startIntrospect } from "./introspect.js";
import { resolveModel } from "./model.js";
import { buildResultPayload, failedTaskResult } from "./task-payload.js";
import { preflightModelUntilReady } from "./preflight.js";
import { TaskActivity } from "./activity.js";
import * as metrics from "./metrics.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config.knightName, config.logLevel);

  log.info("Pi-Knight starting", {
    model: config.knightModel,
    topics: config.subscribeTopics,
    thinking: config.thinkingLevel,
  });

  // Start health/metrics HTTP server
  startHealthServer(config);
  log.info("Health server started", { port: config.metricsPort });

  // Preflight the model endpoint before doing anything else. For local endpoints
  // (Ollama/LM Studio/LiteLLM) this catches an unreachable endpoint or missing
  // model and warns on Ollama context-truncation footguns; cloud endpoints are a no-op.
  // An unreachable endpoint used to exit fatally → CrashLoopBackOff; now the knight
  // stays up and degraded (readiness 503 with the reason, /health still 200 so the
  // startup probe passes) and retries with capped backoff until the endpoint answers.
  // Resolving here is throwaway (knight.ts re-resolves for the session) but shares the
  // same baseUrl/default logic, so what we probe is exactly what the session will use.
  await preflightModelUntilReady((await resolveModel(config.knightModel)).model, {
    onAttemptFailed: (error) => setDegradedReason(`model preflight failed: ${error}`),
  });
  setDegradedReason(null);

  // Discover skills using Pi SDK's built-in agentskills.io loader
  // Retry for git-sync race at startup
  const skillCount = await waitForSkills({
    maxAttempts: 20, // ~60s total — allows git-sync + skill-filter to complete
    intervalMs: 3000,
    expected: skillsExpected(),
    info: (msg, data) => log.info(msg, data),
    load: () => {
      const { skills, diagnostics } = loadSkills({
        cwd: "/data",
        agentDir: "/config",
        skillPaths: ["/skills"],
        includeDefaults: true,
      });
      if (skills.length > 0) {
        log.info("Skills loaded (Pi SDK)", {
          count: skills.length,
          names: skills.map((s) => s.name),
        });
        for (const d of diagnostics) {
          if (d.type === "warning") log.warn("Skill diagnostic", { message: d.message, path: d.path });
        }
      }
      return skills.length;
    },
  });
  setSkillCount(skillCount);

  // Pre-warm the agent session in the background (after skills so the session
  // snapshot includes them, before task subscribe so cold-start latency —
  // observed 79s with PVC history — lands here, not in the first task's window).
  warmSession(config);
  // Apply session-file retention once at startup; it runs again on every run change.
  pruneOldSessions(config);

  // Connect to NATS
  await connectNats(config);
  metrics.natsConnected.labels(config.knightName).set(1);

  // Start introspection responder (zero-cost session queries)
  startIntrospect(config);

  // Subscribe to task stream

  // Task execution state
  let activeCount = 0;
  let puller: Awaited<ReturnType<typeof subscribe>> | null = null;
  let shuttingDown = false;
  // Concurrency slots (0-based) in use, reported on task.started.
  const usedSlots = new Set<number>();

  // Process a single task
  async function processTask(delivery: TaskDelivery): Promise<void> {
    const { task: taskText, taskId, runId, model, chainName, stepName, timestamp } = delivery.task;
    const timeoutMs = delivery.task.timeoutMs ?? config.taskTimeoutMs;
    let slot = 0;
    while (usedSlots.has(slot)) slot++;
    usedSlots.add(slot);
    const sentAt = timestamp ? Date.parse(timestamp) : NaN;
    const activity = new TaskActivity(
      config,
      {
        taskId,
        runId,
        chainName,
        stepName,
        model: model ?? config.knightModel,
        ...(Number.isFinite(sentAt) ? { queuedFor: Math.max(0, Date.now() - sentAt) } : {}),
      },
      { content: config.activityContent },
    );
    // Keep the message un-acked but alive while the task runs; ack only when it finishes.
    const heartbeat = setInterval(() => {
      delivery.working();
      activity.heartbeat();
    }, HEARTBEAT_MS);
    activeCount++;
    activity.started(slot, config.maxConcurrentTasks);
    setActiveTaskCount(activeCount);
    metrics.activeTasks.labels(config.knightName).set(activeCount);

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await executeTask(taskText, config, controller.signal, runId, taskId, { model, activity });
      const durationMs = Date.now() - startTime;

      activity.finished({ success: result.success, error: result.error, cost: result.cost, tokens: result.tokens });
      await publishResult(taskId, buildResultPayload(result, { taskId, knight: config.knightName, durationMs }));

      // Token/cost are recorded regardless — a no-output task still spent them. Only the
      // task-outcome counter reflects the honest success/failure. (#31)
      metrics.tasksTotal.labels(config.knightName, result.success ? "success" : "error").inc();
      metrics.taskDuration.labels(config.knightName).observe(durationMs / 1000);
      metrics.llmCost.labels(config.knightName, result.model).inc(result.cost);
      metrics.tokensTotal.labels(config.knightName, "input").inc(result.tokens.input);
      metrics.tokensTotal.labels(config.knightName, "output").inc(result.tokens.output);
      metrics.tokensTotal.labels(config.knightName, "cached").inc(result.tokens.cacheRead);
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Task failed", { taskId, error: errMsg });
      activity.finished({ success: false, error: errMsg });

      await publishResult(taskId, buildResultPayload(
        failedTaskResult(errMsg, config.knightModel),
        { taskId, knight: config.knightName, durationMs },
      )).catch((e) => log.error("Failed to publish error result", { error: String(e) }));

      metrics.tasksTotal.labels(config.knightName, "error").inc();
      metrics.taskDuration.labels(config.knightName).observe(durationMs / 1000);
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      activity.detach();
      usedSlots.delete(slot);
      delivery.ack();
      activeCount--;
      setActiveTaskCount(activeCount);
      metrics.activeTasks.labels(config.knightName).set(activeCount);
      puller?.wake();
    }
  }

  // Pull only when a slot is free; backlog stays in the stream (consumer lag), not in memory.
  puller = await subscribe(config, {
    freeSlots: () => (shuttingDown ? 0 : config.maxConcurrentTasks - activeCount),
    // Skip self-echo — ignore messages published by this knight back to its own topic
    accept: (parsed) => {
      const self = !!parsed.from && parsed.from.toLowerCase() === config.knightName.toLowerCase();
      if (self) log.debug("Skipping self-echo", { taskId: parsed.taskId, from: parsed.from });
      return !self;
    },
    onTask: (delivery) => {
      void processTask(delivery);
    },
    onLost: async (parsed) => {
      const msg = "Task was delivered to a knight that stopped before finishing it (not re-run: max_deliver=1)";
      metrics.recordLostTask(config.knightName);
      await publishResult(parsed.taskId, {
        task_id: parsed.taskId,
        knight: config.knightName,
        success: false,
        result: `Task failed: ${msg}`,
        error: msg,
        lost: true,
        duration_ms: 0,
        cost: 0,
        tokens: { input: 0, output: 0 },
        model: config.knightModel,
        timestamp: new Date().toISOString(),
      });
    },
  });

  // Graceful shutdown (sequence lives in drain.ts so tests run the real thing)
  const shutdown = createShutdown({
    setDraining: (d) => {
      shuttingDown = d; // freeSlots() -> 0: no new fetches
      setDraining(d);
    },
    stopPulling: async () => void (await puller?.stop()),
    getActive: () => activeCount,
    maxWaitMs: config.drainTimeoutMs,
    // Dispose sessions to abort in-flight agent/compaction/retry/bash work.
    abortInflight: () => {
      for (const s of getActiveSessions()) {
        try {
          s.dispose();
        } catch (e) {
          log.error("Session dispose error", { error: String(e) });
        }
      }
    },
    drainNats: drain,
    cleanup: async () => {
      metrics.natsConnected.labels(config.knightName).set(0);
      await stopHealthServer();
    },
    exit: (code) => process.exit(code),
  });
  installSignalHandlers(shutdown);

  log.info("Pi-Knight ready");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
