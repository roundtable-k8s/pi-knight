import test from "node:test";
import assert from "node:assert/strict";
import { executeTask, __setSessionFactoryForTests } from "../src/knight.ts";
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
  assert.deepEqual(disposed, [1]);
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
