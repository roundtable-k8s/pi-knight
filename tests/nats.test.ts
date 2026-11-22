import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTimeoutMs, parseTaskPayload } from "../src/nats.ts";

test("normalizeTimeoutMs keeps positive finite timeouts", () => {
  assert.equal(normalizeTimeoutMs(1800000), 1800000);
  assert.equal(normalizeTimeoutMs(1), 1);
});

test("normalizeTimeoutMs treats 0 and negatives as unset (the #30 instant-abort bug)", () => {
  assert.equal(normalizeTimeoutMs(0), undefined);
  assert.equal(normalizeTimeoutMs(-5), undefined);
});

test("normalizeTimeoutMs rejects non-finite and non-number inputs", () => {
  assert.equal(normalizeTimeoutMs(NaN), undefined);
  assert.equal(normalizeTimeoutMs(Infinity), undefined);
  assert.equal(normalizeTimeoutMs(undefined), undefined);
  assert.equal(normalizeTimeoutMs(null), undefined);
  assert.equal(normalizeTimeoutMs("1000"), undefined);
});

test("parseTaskPayload reads the operator's TaskPayload runId (#31)", () => {
  const raw = JSON.stringify({
    taskId: "chain-dev-plan.3f2a-1732280000000",
    chainName: "dev",
    stepName: "plan",
    runId: "3f2a9c1e-0000-4000-8000-000000000001",
    task: "Plan the change",
  });
  const parsed = parseTaskPayload(raw, "subject-id");
  assert.equal(parsed.runId, "3f2a9c1e-0000-4000-8000-000000000001");
  assert.equal(parsed.taskId, "chain-dev-plan.3f2a-1732280000000");
  assert.equal(parsed.task, "Plan the change");
});

test("parseTaskPayload accepts snake_case run_id and ignores empty/non-string run ids", () => {
  assert.equal(parseTaskPayload(JSON.stringify({ task: "x", run_id: "r1" }), "s").runId, "r1");
  assert.equal(parseTaskPayload(JSON.stringify({ task: "x", runId: "" }), "s").runId, undefined);
  assert.equal(parseTaskPayload(JSON.stringify({ task: "x", runId: "   " }), "s").runId, undefined);
  assert.equal(parseTaskPayload(JSON.stringify({ task: "x", runId: 42 }), "s").runId, undefined);
});

test("parseTaskPayload without runId (ad-hoc task) leaves it undefined", () => {
  const parsed = parseTaskPayload(JSON.stringify({ task_id: "t1", task: "hi" }), "s");
  assert.equal(parsed.runId, undefined);
  assert.equal(parsed.taskId, "t1");
});

test("parseTaskPayload treats non-JSON and non-object JSON as plain task text", () => {
  assert.deepEqual(parseTaskPayload("just do it", "sub"), { task: "just do it", taskId: "sub" });
  assert.deepEqual(parseTaskPayload("null", "sub"), { task: "null", taskId: "sub" });
  assert.deepEqual(parseTaskPayload('"quoted"', "sub"), { task: '"quoted"', taskId: "sub" });
});
