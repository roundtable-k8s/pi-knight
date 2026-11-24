import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KNIGHT_WORK_ROOT = mkdtempSync(join(tmpdir(), "pk-work-"));
process.env.KNIGHT_DATA_DIR = mkdtempSync(join(tmpdir(), "pk-data-"));
process.env.POD_NAME = "pod-a";
process.env.NODE_NAME = "node-1";

const {
  TaskActivity, __setActivityPublishForTests, listInflight, boundText, summarizeArgs,
  encodeEvent, MAX_EVENT_BYTES, MAX_PREVIEW_CHARS, MAX_ARGS_CHARS,
} = await import("../src/activity.ts");
const { executeTask, __setSessionFactoryForTests } = await import("../src/knight.ts");
const { handleIntrospect } = await import("../src/introspect.ts");
const { parseTaskPayload } = await import("../src/nats.ts");

const config = {
  knightName: "k", knightModel: "x/y", natsResultsPrefix: "rt.results",
  sessionRetentionMaxFiles: 0, sessionRetentionDays: 0, maxConcurrentTasks: 2,
} as any;

type Pub = { subject: string; ev: any };
function capture(): Pub[] {
  const out: Pub[] = [];
  __setActivityPublishForTests((subject, data) => {
    assert.ok(Buffer.byteLength(data) <= MAX_EVENT_BYTES, "event over 8 KiB");
    out.push({ subject, ev: JSON.parse(data) });
  });
  return out;
}

const GHP = "ghp_" + "a".repeat(40);

test("tool + assistant events map with redaction and bounds", () => {
  const pubs = capture();
  const a = new TaskActivity(config, { taskId: "t1", runId: "r1", chainName: "c", stepName: "s", model: "m" });
  a.started(0, 2);
  a.onSessionEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "bash",
    args: { command: `echo ${GHP} ${"x".repeat(500)}`, content: "FILE CONTENTS" } });
  a.onSessionEvent({ type: "tool_execution_end", toolCallId: "1", toolName: "bash", isError: false, durationMs: 12,
    result: { content: [{ type: "text", text: `token ${GHP} ` + "y".repeat(2000) }] } });
  a.onSessionEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }],
    usage: { input: 10, output: 5, cacheRead: 2, cost: { total: 0.5 } } } });
  a.heartbeat();
  a.finished({ success: true });

  assert.deepEqual(pubs.map((p) => p.ev.type),
    ["task.started", "tool.started", "tool.finished", "assistant.message", "task.heartbeat", "task.finished"]);
  assert.deepEqual(pubs.map((p) => p.ev.seq), [0, 1, 2, 3, 4, 5]);
  assert.equal(pubs[0].subject, "rt.activity.k.t1");
  assert.equal(pubs[0].ev.pod, "pod-a");
  assert.equal(pubs[0].ev.node, "node-1");
  assert.equal(pubs[0].ev.runId, "r1");
  const all = JSON.stringify(pubs.map((p) => p.ev));
  assert.ok(!all.includes(GHP), "secret leaked");
  assert.ok(!all.includes("FILE CONTENTS"), "file content leaked");
  assert.ok(pubs[1].ev.argsSummary.length <= MAX_ARGS_CHARS + 1);
  assert.equal(pubs[1].ev.truncated, true);
  assert.ok(pubs[2].ev.preview.length <= MAX_PREVIEW_CHARS);
  assert.equal(pubs[2].ev.durationMs, 12);
  assert.deepEqual(pubs[4].ev.tokens, { input: 10, output: 5, cacheRead: 2 });
  assert.equal(pubs[4].ev.cost, 0.5);
  assert.equal(pubs[4].ev.turns, 1);
  assert.equal(listInflight().length, 0);
});

test("a secret straddling the preview limit is not half-leaked", () => {
  const text = "a".repeat(MAX_PREVIEW_CHARS - 10) + ` api_key=${"Z".repeat(40)}`;
  const { text: out } = boundText(text, MAX_PREVIEW_CHARS);
  assert.ok(!out.includes("ZZZZ"));
});

test("content=none omits previews and argument summaries", () => {
  const pubs = capture();
  const a = new TaskActivity(config, { taskId: "t2", model: "m" }, { content: "none" });
  a.onSessionEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "/x" } });
  a.onSessionEvent({ type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: true,
    result: { content: [{ type: "text", text: "secret stuff" }] } });
  assert.equal(pubs[0].ev.argsSummary, undefined);
  assert.equal(pubs[1].ev.preview, undefined);
  assert.equal(pubs[1].ev.isError, true);
});

test("rate limit drops tool events but never lifecycle events; seq shows the gap", () => {
  const pubs = capture();
  const now = () => 1_000_000;
  const a = new TaskActivity(config, { taskId: "t3", model: "m" }, { now });
  a.started(0, 1);
  for (let i = 0; i < 200; i++) a.onSessionEvent({ type: "tool_execution_start", toolCallId: String(i), toolName: "bash", args: {} });
  a.heartbeat();
  a.finished({ success: false, error: "timed out" });
  const tools = pubs.filter((p) => p.ev.type === "tool.started").length;
  assert.ok(tools <= 21 && tools >= 15, `tools=${tools}`);
  assert.equal(pubs.at(-2)!.ev.type, "task.heartbeat");
  const fin = pubs.at(-1)!.ev;
  assert.equal(fin.type, "task.finished");
  assert.equal(fin.errorClass, "timeout");
  assert.ok(fin.seq > pubs.length - 1);
});

test("oversized events are shed below 8 KiB", () => {
  const json = encodeEvent({ v: 1, type: "tool.finished", ts: "t", knight: "k", pod: "p", taskId: "t", model: "m", seq: 1,
    preview: "x".repeat(20_000) } as any);
  assert.ok(Buffer.byteLength(json) <= MAX_EVENT_BYTES);
  assert.equal(JSON.parse(json).truncated, true);
});

test("summarizeArgs never includes file content or credentials", () => {
  const s = summarizeArgs({ path: "/a", content: "SECRET BODY", headers: { Authorization: "x" } }).text;
  assert.ok(s.includes("path=/a"));
  assert.ok(!s.includes("SECRET BODY") && !s.includes("Authorization"));
});

test("publish failures never throw", () => {
  __setActivityPublishForTests(() => { throw new Error("boom"); });
  const a = new TaskActivity(config, { taskId: "t4", model: "m" });
  a.started(0, 1);
  a.heartbeat();
  a.finished({ success: true });
});

test("parseTaskPayload carries chainName/stepName", () => {
  const p = parseTaskPayload(JSON.stringify({ task: "x", taskId: "a", chainName: "c", stepName: "s" }), "a");
  assert.equal(p.chainName, "c");
  assert.equal(p.stepName, "s");
});

// ─── Concurrent runs ────────────────────────────────────────────────

function fakeSession(id: number, gate: Promise<void>) {
  const listeners = new Set<(e: any) => void>();
  const messages: any[] = [];
  const emit = (e: any) => listeners.forEach((l) => l(e));
  return {
    messages,
    subscribe: (l: (e: any) => void) => { listeners.add(l); return () => void listeners.delete(l); },
    dispose() {}, abort() {},
    sessionManager: { getSessionFile: () => `/nonexistent/s${id}.jsonl`, getEntries: () => [], getTree: () => [] },
    model: { id: "default" },
    async setModel() {},
    getSessionStats: () => ({ sessionId: `s${id}`, totalMessages: 0, userMessages: 0, assistantMessages: 0, cost: 0, toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } }),
    getLastAssistantText: () => "done",
    async prompt(t: string) {
      emit({ type: "tool_execution_start", toolCallId: `c${id}`, toolName: "bash", args: { command: `run-${t}` } });
      await gate;
      emit({ type: "tool_execution_end", toolCallId: `c${id}`, toolName: "bash", isError: false, durationMs: 1, result: { content: [{ type: "text", text: `out-${t}` }] } });
      messages.push({ role: "assistant", content: [{ type: "text", text: `done ${t}` }] });
    },
  };
}

test("two concurrent runs produce separate event streams; introspect reports inflight + runId selector", async () => {
  const pubs = capture();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let n = 0;
  __setSessionFactoryForTests(async () => fakeSession(++n, gate) as any);

  const run = (taskId: string, runId: string) => {
    const act = new TaskActivity(config, { taskId, runId, model: "x/y" });
    act.started(taskId === "ta" ? 0 : 1, 2);
    return executeTask(taskId, config, undefined, runId, taskId, { activity: act })
      .then(() => act.finished({ success: true }));
  };
  const pa = run("ta", "run-A");
  const pb = run("tb", "run-B");
  await new Promise((r) => setTimeout(r, 100));

  const stats: any = await handleIntrospect({ type: "stats" }, config);
  assert.equal(stats.runtime.activeTasks, 2);
  assert.deepEqual(stats.inflight.map((i: any) => i.runId).sort(), ["run-A", "run-B"]);
  assert.equal(stats.pod, "pod-a");
  assert.equal(stats.node, "node-1");
  const a: any = await handleIntrospect({ type: "stats", runId: "run-A" }, config);
  const b: any = await handleIntrospect({ type: "stats", runId: "run-B" }, config);
  assert.notEqual(a.session.sessionId, b.session.sessionId);
  const missing: any = await handleIntrospect({ type: "recent", runId: "nope" }, config);
  assert.match(missing.error, /nope/);

  open();
  await Promise.all([pa, pb]);

  for (const [taskId, runId] of [["ta", "run-A"], ["tb", "run-B"]]) {
    const mine = pubs.filter((p) => p.ev.taskId === taskId);
    assert.deepEqual(mine.map((p) => p.ev.type), ["task.started", "tool.started", "tool.finished", "task.finished"]);
    assert.ok(mine.every((p) => p.ev.runId === runId && p.subject === `rt.activity.k.${taskId}`));
    assert.ok(mine[1].ev.argsSummary.includes(`run-${taskId}`));
    assert.ok(mine[2].ev.preview.includes(`out-${taskId}`));
  }
  assert.equal(((await handleIntrospect({ type: "stats" }, config)) as any).runtime.activeTasks, 0);
});
