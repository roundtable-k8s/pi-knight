import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResultPayload } from "../src/task-payload.js";
import type { TaskResult } from "../src/knight.js";

const base: TaskResult = {
  result: "r",
  success: false,
  cost: 0,
  tokens: { input: 1, output: 2, cacheRead: 3 },
  model: "p/m",
  toolCalls: 0,
};
const meta = { taskId: "t1", knight: "k", durationMs: 5, timestamp: "2026-01-01T00:00:00Z" };

test("buildResultPayload passes refused through to the published payload (#79)", () => {
  const p = buildResultPayload({ ...base, error: "402", refused: "credits" }, meta);
  assert.equal(p.refused, "credits");
  assert.equal(p.task_id, "t1");
  assert.equal(p.duration_ms, 5);
});

test("buildResultPayload omits optional fields when unset", () => {
  const p = buildResultPayload({ ...base, success: true }, meta);
  for (const k of ["refused", "error", "prs", "verdict"]) assert.ok(!(k in p), k);
});
