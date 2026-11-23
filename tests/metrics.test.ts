import { test } from "node:test";
import assert from "node:assert/strict";
import { recordLostTask, registry } from "../src/metrics.js";

test("recordLostTask increments tasks_total with status=lost, not error", async () => {
  recordLostTask("galahad");
  const text = await registry.metrics();
  assert.match(text, /pi_knight_tasks_total\{knight="galahad",status="lost"\} 1/);
  assert.doesNotMatch(text, /pi_knight_tasks_total\{knight="galahad",status="error"\}/);
});
