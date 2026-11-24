import type { TaskResult } from "./knight.js";
import { refusalCode } from "./result-extraction.js";

/** TaskResult for a task that threw out of executeTask, so it publishes the same shape as an in-band failure. */
export function failedTaskResult(errMsg: string, model: string): TaskResult {
  const refused = refusalCode(errMsg);
  return {
    result: `Task failed: ${errMsg}`,
    success: false,
    error: errMsg,
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0 },
    model,
    toolCalls: 0,
    ...(refused ? { refused } : {}),
  };
}

/**
 * Build the NATS task-result payload from an executeTask result. Optional fields
 * (error, prs, verdict, refused) are only present when set, so the published shape
 * stays additive. Pure so tests can assert nothing is dropped on the way out (#79).
 */
export function buildResultPayload(
  result: TaskResult,
  meta: { taskId: string; knight: string; durationMs: number; timestamp?: string },
): Record<string, unknown> {
  return {
    task_id: meta.taskId,
    knight: meta.knight,
    success: result.success,
    result: result.result,
    ...(result.error ? { error: result.error } : {}),
    duration_ms: meta.durationMs,
    cost: result.cost,
    tokens: result.tokens,
    model: result.model,
    tool_calls: result.toolCalls,
    ...(result.prs ? { prs: result.prs } : {}),
    ...(result.verdict ? { verdict: result.verdict } : {}),
    ...(result.refused ? { refused: result.refused } : {}),
    timestamp: meta.timestamp ?? new Date().toISOString(),
  };
}
