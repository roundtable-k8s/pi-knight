import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTask, workspaceName, __setSessionFactoryForTests, __setTaskModelResolverForTests } from "../src/knight.ts";
import type { KnightConfig } from "../src/config.ts";

// Minimal fake AgentSession: records prompts as messages so we can see what each
// session accumulated.
function fakeSession(id: number, disposed: number[]) {
  const messages: { role: string; content: string }[] = [];
  return {
    id,
    messages,
    dispose: () => void disposed.push(id),
    abort: () => {},
    sessionManager: { getSessionFile: () => `/nonexistent/s${id}.jsonl` },
    model: { id: "default" } as any,
    modelLog: [] as string[],
    async setModel(m: any) {
      this.modelLog.push(m.id);
      this.model = m;
    },
    getSessionStats: () => ({
      sessionId: `s${id}`,
      totalMessages: messages.length,
      cost: 0,
      toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0 },
    }),
    getLastAssistantText: () => messages.filter((m) => m.role === "assistant").at(-1)?.content,
    prompt: async (t: string) => {
      messages.push({ role: "user", content: t });
      messages.push({ role: "assistant", content: `done: ${t}` });
    },
  };
}

// Tests must never touch /data.
process.env.KNIGHT_WORK_ROOT = mkdtempSync(join(tmpdir(), "pk-work-"));
process.env.KNIGHT_DATA_DIR = mkdtempSync(join(tmpdir(), "pk-data-"));
const config = { knightName: "t", knightModel: "x/y", sessionRetentionMaxFiles: 0, sessionRetentionDays: 0 } as unknown as KnightConfig;

function setup() {
  const created: ReturnType<typeof fakeSession>[] = [];
  const disposed: number[] = [];
  __setSessionFactoryForTests(async () => {
    const s = fakeSession(created.length + 1, disposed);
    created.push(s);
    return s as any;
  });
  return { created, disposed };
}

test("executeTask: two runId-less tasks do not share messages (#53)", async () => {
  const { created, disposed } = setup();
  await executeTask("first", config);
  await executeTask("second", config);
  assert.equal(created.length, 2);
  assert.deepEqual(disposed, [], "idle sessions stay until LRU eviction");
  assert.deepEqual(created[0].messages.map((m) => m.content), ["first", "done: first"]);
  assert.deepEqual(created[1].messages.map((m) => m.content), ["second", "done: second"]);
  __setSessionFactoryForTests(null);
});

test("executeTask: same runId shares a session, a different runId does not", async () => {
  const { created } = setup();
  await executeTask("a1", config, undefined, "run-a");
  await executeTask("a2", config, undefined, "run-a");
  assert.equal(created.length, 1);
  assert.equal(created[0].messages.length, 4);
  await executeTask("b1", config, undefined, "run-b");
  assert.equal(created.length, 2);
  // A run-less task after a run must not join that run's session.
  await executeTask("adhoc", config);
  assert.equal(created.length, 3);
  assert.deepEqual(created[2].messages.map((m) => m.content), ["adhoc", "done: adhoc"]);
  __setSessionFactoryForTests(null);
});

test("executeTask: per-task model is applied for that task, then the default is restored", async () => {
  const { created } = setup();
  __setTaskModelResolverForTests(async (m) => ({ model: { id: m } as any }));
  const r1 = await executeTask("a1", config, undefined, "run-m", "tm1", { model: "anthropic/claude-opus-4-5" });
  assert.equal(r1.model, "anthropic/claude-opus-4-5");
  assert.deepEqual(created[0].modelLog, ["anthropic/claude-opus-4-5", "default"]);
  assert.equal(created[0].model.id, "default");
  // Next step of the same run: no override, same session, knight default reported.
  const r2 = await executeTask("a2", config, undefined, "run-m", "tm2");
  assert.equal(r2.model, "x/y");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].modelLog, ["anthropic/claude-opus-4-5", "default"]);
  __setTaskModelResolverForTests(null);
  __setSessionFactoryForTests(null);
});

test("executeTask: unresolvable per-task model rejects without prompting or wedging the lock", async () => {
  const { created } = setup();
  __setTaskModelResolverForTests(async (m) => {
    throw new Error(`Unknown model "${m}"`);
  });
  await assert.rejects(executeTask("x", config, undefined, undefined, "tm3", { model: "nope/nope" }), /Unknown model "nope\/nope"/);
  assert.equal(created.length, 0);
  __setTaskModelResolverForTests(null);
  const ok = await executeTask("y", config);
  assert.equal(ok.success, true);
  __setSessionFactoryForTests(null);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A session whose prompt takes a while, logging start/end and the cwd it was created with.
function slowSetup(log: string[]) {
  const cwds: string[] = [];
  const created: any[] = [];
  __setSessionFactoryForTests(async (_c, cwd) => {
    const s: any = fakeSession(created.length + 1, []);
    cwds.push(cwd);
    s.prompt = async (t: string) => {
      log.push(`start ${t}`);
      s.messages.push({ role: "user", content: t });
      assert.ok(existsSync(cwd), "workspace exists while prompting");
      await sleep(60);
      s.messages.push({ role: "assistant", content: `done: ${t}` });
      log.push(`end ${t}`);
    };
    created.push(s);
    return s;
  });
  return { cwds, created };
}

test("executeTask: tasks of different runs overlap in time, with separate sessions", async () => {
  const log: string[] = [];
  const { created, cwds } = slowSetup(log);
  await Promise.all([
    executeTask("a", config, undefined, "run-a", "t1"),
    executeTask("b", config, undefined, "run-b", "t2"),
    executeTask("c", config, undefined, undefined, "t3"),
  ]);
  assert.deepEqual(log.slice(0, 3).sort(), ["start a", "start b", "start c"]);
  assert.equal(created.length, 3);
  for (const s of created) assert.equal(s.messages.length, 2, "no message sharing");
  assert.equal(new Set(cwds).size, 3);
  assert.deepEqual(cwds.map((d) => d.split("/").pop()).sort(), ["run-run-a", "run-run-b", "task-t3"]);
  for (const d of cwds) assert.ok(!existsSync(d), "workspace removed after the task");
  __setSessionFactoryForTests(null);
});

test("executeTask: steps of the same run serialise on one session", async () => {
  // Gate-driven, not timing-driven: step 2 must not start until step 1 is released.
  const log: string[] = [];
  let release1!: () => void;
  const gate1 = new Promise<void>((r) => (release1 = r));
  let started1!: () => void;
  const started1P = new Promise<void>((r) => (started1 = r));
  const created: any[] = [];
  __setSessionFactoryForTests(async (_c, cwd) => {
    const s: any = fakeSession(created.length + 1, []);
    s.prompt = async (t: string) => {
      log.push(`start ${t}`);
      s.messages.push({ role: "user", content: t });
      assert.ok(existsSync(cwd), "workspace exists while prompting");
      if (t === "s1") {
        started1();
        await gate1;
      }
      s.messages.push({ role: "assistant", content: `done: ${t}` });
      log.push(`end ${t}`);
    };
    created.push(s);
    return s;
  });
  const p1 = executeTask("s1", config, undefined, "run-x", "t1");
  const p2 = executeTask("s2", config, undefined, "run-x", "t2");
  await started1P;
  // Let any (wrongly) unserialised step 2 run before we check it hasn't.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ["start s1"], "s2 is queued while s1 is in flight");
  release1();
  await Promise.all([p1, p2]);
  assert.deepEqual(log, ["start s1", "end s1", "start s2", "end s2"]);
  assert.equal(created.length, 1, "one session created despite the concurrent start");
  assert.equal(created[0].messages.length, 4);
  __setSessionFactoryForTests(null);
});

test("executeTask: a run-less taskId never shares a workspace with a run of the same id", async () => {
  const log: string[] = [];
  const { cwds } = slowSetup(log);
  await Promise.all([
    executeTask("a", config, undefined, "same", "t1"),
    executeTask("b", config, undefined, undefined, "same"),
  ]);
  assert.equal(new Set(cwds).size, 2);
  assert.equal(workspaceName("same", "x"), "run-same");
  assert.equal(workspaceName(undefined, "same"), "task-same");
  __setSessionFactoryForTests(null);
});

test("executeTask: a failed session creation does not wedge the run", async () => {
  let n = 0;
  __setSessionFactoryForTests(async () => {
    if (n++ === 0) throw new Error("boom");
    return fakeSession(1, []) as any;
  });
  await assert.rejects(executeTask("a", config, undefined, "run-f", "t1"), /boom/);
  const r = await executeTask("b", config, undefined, "run-f", "t2");
  assert.equal(r.success, true);
  __setSessionFactoryForTests(null);
});

test("executeTask: per-task model applies on the run's own session, under its lock, inside its workspace", async () => {
  const log: string[] = [];
  const { created, cwds } = slowSetup(log);
  __setTaskModelResolverForTests(async (m) => ({ model: { id: m } as any }));
  const [a1, a2, b] = await Promise.all([
    executeTask("a1", config, undefined, "run-a", "t1", { model: "m/opus" }),
    executeTask("a2", config, undefined, "run-a", "t2"),
    executeTask("b1", config, undefined, "run-b", "t3", { model: "m/haiku" }),
  ]);
  assert.equal(created.length, 2);
  assert.equal(a1.model, "m/opus");
  assert.equal(a2.model, "x/y", "next step of run-a runs on the knight default");
  assert.equal(b.model, "m/haiku");
  // Which run's session is created first depends on async mkdir completion across the two
  // runs, so identify each session by the workspace it was created in, never by index.
  const sessionIn = (ws: string) => {
    const i = cwds.findIndex((d) => d.endsWith(`/${ws}`));
    assert.ok(i >= 0, `a session was created in ${ws}`);
    return created[i];
  };
  // each session saw only its own switch + restore, in that session's workspace
  assert.deepEqual(sessionIn(workspaceName("run-a", "t1")).modelLog, ["m/opus", "default"]);
  assert.deepEqual(sessionIn(workspaceName("run-b", "t3")).modelLog, ["m/haiku", "default"]);
  // run-a steps stayed serialised even though the model switched around them
  assert.deepEqual(log.filter((l) => l.endsWith("a1") || l.endsWith("a2")), ["start a1", "end a1", "start a2", "end a2"]);
  __setTaskModelResolverForTests(null);
  __setSessionFactoryForTests(null);
});
