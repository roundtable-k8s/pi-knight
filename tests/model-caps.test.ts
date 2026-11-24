import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * max_tokens cap tests (#79): registry (models.json) models must be capped too,
 * not just env-fallback custom models — OpenRouter reserves credit for the full
 * max_tokens up front, so a huge registry limit made every call unaffordable.
 *
 * src/model.ts reads MODELS_JSON_PATH at module load, so the env var and the
 * models.json fixture must be in place BEFORE the dynamic import below.
 * (node:test runs each file in its own process, so this is isolated.)
 */

const model = (id: string, maxTokens: number) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens,
});

const dir = mkdtempSync(join(tmpdir(), "pk79-models-"));
writeFileSync(join(dir, "models.json"), JSON.stringify({
  providers: {
    testprov: {
      baseUrl: "http://localhost:4000/v1",
      api: "openai-completions",
      models: [model("big-model", 937632), model("small-model", 4096)],
    },
  },
}));
process.env.MODELS_JSON_PATH = join(dir, "models.json");

const { outputTokenCap, resolveModel, DEFAULT_MAX_OUTPUT_TOKENS } = await import("../src/model.js");

const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("outputTokenCap defaults to the shared default, honoring MODEL_MAX_TOKENS and the model's own limit", async () => {
  await withEnv({ MODEL_MAX_TOKENS: undefined }, async () => {
    assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 32768);
    assert.equal(outputTokenCap(937632), 32768, "huge model limit capped to default");
    assert.equal(outputTokenCap(undefined), 32768, "no model limit → default cap");
    assert.equal(outputTokenCap(4096), 4096, "never above the model's own limit");
  });
  await withEnv({ MODEL_MAX_TOKENS: "8192" }, async () => {
    assert.equal(outputTokenCap(937632), 8192, "MODEL_MAX_TOKENS wins over a huge model limit");
    assert.equal(outputTokenCap(4096), 4096, "never above the model's own limit even when configured higher");
  });
});

test("resolveModel caps a registry (models.json) model with a huge maxTokens to the configured value (#79)", async () => {
  await withEnv({ MODEL_MAX_TOKENS: "32768" }, async () => {
    const { model: m, provider } = await resolveModel("testprov/big-model");
    assert.equal(provider, "testprov");
    assert.equal((m as { maxTokens?: number }).maxTokens, 32768, "937632 → 32768");
  });
});

test("resolveModel caps a registry model to the default cap when MODEL_MAX_TOKENS is unset", async () => {
  await withEnv({ MODEL_MAX_TOKENS: undefined }, async () => {
    const { model: m } = await resolveModel("testprov/big-model");
    assert.equal((m as { maxTokens?: number }).maxTokens, 32768, "default cap applies without env");
  });
});

test("resolveModel leaves a registry model below the cap untouched", async () => {
  await withEnv({ MODEL_MAX_TOKENS: undefined }, async () => {
    const { model: m } = await resolveModel("testprov/small-model");
    assert.equal((m as { maxTokens?: number }).maxTokens, 4096, "model's own smaller limit preserved");
  });
});

test("outputTokenCap falls back to the default for a malformed MODEL_MAX_TOKENS (never NaN)", async () => {
  for (const bad of ["32k", "abc", "0", "-5", "1.5"]) {
    await withEnv({ MODEL_MAX_TOKENS: bad }, async () => {
      assert.equal(outputTokenCap(937632), 32768, `${bad} → default`);
      assert.equal(outputTokenCap(undefined), 32768, `${bad} → default, no model limit`);
      assert.equal(outputTokenCap(4096), 4096, `${bad} → still bounded by the model limit`);
    });
  }
});
