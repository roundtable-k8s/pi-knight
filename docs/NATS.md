# NATS Integration

> Native NATS JetStream integration for task dispatch and knight-to-knight collaboration.

## Architecture

Pi-Knight communicates exclusively via NATS JetStream:

```
Tim (orchestrator)
  │
  ├─ nats pub fleet-a.tasks.security.<id> ──→ Galahad
  ├─ nats pub fleet-a.tasks.finance.<id>  ──→ Percival
  └─ nats pub fleet-a.tasks.career.<id>   ──→ Lancelot
                                                │
                                          fleet-a.results.<id>
                                                │
                                          ──→ Tim (or any subscriber)
```

## Custom Tools

NATS is registered as **native Pi SDK tools** — agents call them directly in the tool loop, no shell scripts needed.

### `nats_publish`

Fire-and-forget message to any NATS subject.

```
Tool: nats_publish
Params:
  subject: "fleet-a.tasks.security.my-task"
  message: '{"task": "Analyze CVE-2026-1234", "task_id": "my-task"}'
```

Use for: broadcasting events, sending notifications, out-of-band messaging.

**Do NOT use for task results** — those are published automatically by the runtime.

### `nats_request`

Send a task to another knight and wait for their response. This is the **branch-and-wait** pattern for cross-knight collaboration.

```
Tool: nats_request
Params:
  knight: "percival"
  domain: "finance"
  task: "What is the estimated financial impact of the Conduent breach?"
  timeout_ms: 600000  (optional, default 10 min)
```

Flow:
1. Generates unique task ID
2. Subscribes to `fleet-a.results.<task-id>` for the response
3. Publishes task to `fleet-a.tasks.<domain>.<task-id>`
4. Blocks the calling agent's tool loop until response arrives
5. Returns the response text — agent continues with that context

Use for: asking another knight a question, delegating subtasks, gathering cross-domain expertise.

## Task Message Format

```json
{
  "task": "Analyze the latest npm supply chain attacks",
  "task_id": "galahad-xreq-1708732800000-abc123",
  "domain": "security",
  "dispatched_by": "knight",
  "timestamp": "2026-02-23T18:00:00.000Z",
  "metadata": {
    "timeout_ms": 600000
  }
}
```

## Result Message Format

```json
{
  "task_id": "galahad-xreq-1708732800000-abc123",
  "knight": "galahad",
  "success": true,
  "result": "Analysis text...",
  "duration_ms": 45000,
  "cost": 0.12,
  "tokens": { "input": 5000, "output": 2000 },
  "model": "openrouter/deepseek/deepseek-v3.2",
  "tool_calls": 3,
  "timestamp": "2026-02-23T18:00:45.000Z"
}
```

## JetStream Configuration

- **Task stream**: `fleet_a_tasks` — subjects `fleet-a.tasks.>`
- **Result stream**: `fleet_a_results` — subjects `fleet-a.results.>`
- **Consumer**: `<knight-name>-consumer` (durable, per-knight)
- **Delivery**: pull consumer. The knight fetches at most `MAX_CONCURRENT_TASKS - active` messages, so backlog stays in the stream (consumer lag is real; KEDA can scale on it). There is no in-memory overflow queue.
- **Ack policy**: Explicit. The message is acked when the task *finishes* (after the result is published). While it runs the knight sends an in-progress ack (`working()`) every 10s.
- **Ack wait**: 30s heartbeat window (not the task timeout).
- **Max deliver**: 1. **Redelivery policy:** a task is never re-run silently. If a knight takes a task and dies/hangs without acking, the server stops after the ack window and emits a `MAX_DELIVERIES` advisory; a live knight replica (queue group, so exactly one) reads the original message by stream sequence and publishes a failure result (`success: false`, `lost: true`). Limitation: the advisory is core-NATS, so it is missed if *no* replica of that knight is running when the ack window expires (30s after the crash).

Second limitation (spurious `lost` result): an event-loop stall longer than the ack window (30s, e.g. an extreme GC pause) can fire the `MAX_DELIVERIES` advisory while the task is still running. The live replica then publishes a `success: false, lost: true` result for a task that is in fact still executing, and the real result follows later. The task is never re-run, but consumers can see two results for one `taskId`. Consumers should prefer the later result that is not `lost` for the same `taskId`.

## Session Persistence

Knights maintain **persistent sessions** across tasks. When a knight processes multiple tasks, it retains context from previous work. Pi SDK handles auto-compaction when context grows too large.

Session data persists to `/data` (PVC) as JSONL files, surviving pod restarts.

## Task activity events and introspection

Each task publishes core-NATS (not JetStream) events on `<prefix>.activity.<Knight>.<taskId>`:
`task.started` (`slot`, `concurrency`, `queuedFor`), `task.heartbeat` (every 10 s: `turns`, `tokens`,
`cost`, `currentTool`), `tool.started` / `tool.finished`, `assistant.message`, `task.finished`.
Common fields: `v`, `type`, `ts`, `knight`, `pod`, `node`, `taskId`, `runId`, `chainName`, `stepName`,
`model`, `seq` (per task; a gap means dropped events). Previews are redacted, then cut to 500 chars
(argument summaries 200); events are capped at 8 KiB; tool/assistant events are limited to 20/s per task
(lifecycle events and heartbeats are never dropped). Publish failures never fail a task.

Introspection is served on `<prefix>.introspect.<Knight>` (queue group: one replica answers) and
`<prefix>.introspect.<Knight>.<pod>` (a specific replica). Every reply carries `pod` and `node`;
`stats` reports the real `runtime.activeTasks` and an `inflight` list; `stats`/`recent`/`tree` accept
`runId` or `sessionId` to pick a live session instead of the most recent one.
