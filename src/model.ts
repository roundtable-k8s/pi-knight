/**
 * Shared model + auth resolution for knight and sub-agent sessions.
 *
 * One place resolves a "provider/model" string into a usable Model plus the
 * ModelRuntime to pass to createAgentSession — so the knight and
 * its sub-agents never drift apart on model selection or auth handling.
 */
import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.js";

// Custom-model catalog read by the SDK ModelRuntime. Defaults to the workspace PVC;
// override (e.g. to a read-only ConfigMap mount like /config/models.json) via env so a
// fleet can ship a declarative local-model catalog instead of the per-knight env triplet.
const MODELS_JSON = process.env.MODELS_JSON_PATH || "/data/models.json";

/**
 * Default max output tokens (max_tokens per request) for any model.
 *
 * OpenRouter reserves credit for the FULL max_tokens up front — a request that
 * allows hundreds of thousands of output tokens needs that much credit available
 * even if the reply is small, which stalls knights that still have plenty of credit
 * for normal-sized replies (#79). So we cap max_tokens on EVERY resolved model —
 * registry models included, not just custom ones — with MODEL_MAX_TOKENS overriding
 * this default, and never exceeding the model's own limit.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

/** One-time startup log guard so the effective cap is logged once per distinct provider/model. */
const loggedMaxOutputTokens = new Set<string>();
let warnedBadMaxTokens = false;

/**
 * Effective per-request output-token cap for a model: MODEL_MAX_TOKENS if set,
 * otherwise DEFAULT_MAX_OUTPUT_TOKENS, and never above the model's own limit.
 */
export function outputTokenCap(modelLimit?: number): number {
  let configured = DEFAULT_MAX_OUTPUT_TOKENS;
  const raw = process.env.MODEL_MAX_TOKENS;
  if (raw) {
    // Strict integer parse: "32k"/"abc" must not become NaN (which would silently drop
    // max_tokens from requests and re-open #79) or a truncated "32".
    const parsed = /^\s*\d+\s*$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      configured = parsed;
    } else if (!warnedBadMaxTokens) {
      warnedBadMaxTokens = true;
      log.warn("Invalid MODEL_MAX_TOKENS; falling back to default", { value: raw, fallback: DEFAULT_MAX_OUTPUT_TOKENS });
    }
  }
  return typeof modelLimit === "number" && Number.isFinite(modelLimit) && modelLimit > 0
    ? Math.min(configured, modelLimit)
    : configured;
}

/**
 * Default base URLs for known local OpenAI-compatible providers, keyed by the
 * provider segment of a "provider/model" string. Mirrors the SDK's convention of
 * letting the provider *name* drive endpoint/compat selection (see openai-completions
 * detectCompat). Ollama serves an OpenAI-compatible API at /v1, so mapping the
 * provider name "ollama" here means `KNIGHT_MODEL=ollama/<tag>` works with no extra
 * env. An explicit OPENAI_BASE_URL still wins (e.g. a non-localhost cluster service).
 */
const LOCAL_PROVIDER_BASE_URLS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
};

export interface ResolvedModel {
  model: Model<Api>;
  provider: string;
  modelName: string;
  modelRuntime: ModelRuntime;
}

/**
 * Build a SettingsManager that explicitly trusts the knight's project directory.
 *
 * pi gates project-local settings, resources, instructions and context files on project
 * trust. The ask/never resolution lives in the CLI app/mode layer we bypass, so we state
 * the posture explicitly: knights run fully autonomous on their own PVC, so "trusted" is
 * the intended posture.
 *
 * We use the create-time `projectTrusted` option (a write-free read of the settings dir) and
 * deliberately NOT setDefaultProjectTrust(), which persists to /data on every call — the
 * runtime avoids /data writes for SIGKILL lock safety (cf. in-memory credential store below), and
 * `defaultProjectTrust` is only consulted by the CLI app layer we don't run.
 */
export function createTrustedSettingsManager(cwd: string, agentDir: string): SettingsManager {
  return SettingsManager.create(cwd, agentDir, { projectTrusted: true });
}

/** Parse "provider/model" → { provider, modelName }. Defaults provider to anthropic. */
export function parseModelStr(modelStr: string): { provider: string; modelName: string } {
  const slashIdx = modelStr.indexOf("/");
  return slashIdx > 0
    ? { provider: modelStr.slice(0, slashIdx), modelName: modelStr.slice(slashIdx + 1) }
    : { provider: "anthropic", modelName: modelStr };
}

/**
 * OpenRouter routing-variant suffixes. These pick a routing strategy/variant
 * (e.g. cheapest provider) without changing which catalog model runs, so the
 * registry has no exact catalog entry for the suffixed slug. We strip them for
 * the catalog lookup (to keep baseUrl + pricing) but send the full slug to the
 * API so OpenRouter still applies the variant.
 * https://openrouter.ai/docs/features/provider-routing
 *
 * Cost-tracking accuracy varies by suffix (pricing always comes from the base
 * catalog entry):
 *  - `:floor` / `:nitro` — same model, just provider selection. Accurate. This
 *    is the intended use case.
 *  - `:free` — routes to a $0 variant priced as paid → reported cost is an
 *    over-estimate. (Some community models exist *only* as `:free` with no paid
 *    base; those miss the stripped lookup and land in the localhost fallback.)
 *  - `:online` — adds OpenRouter's web-search plugin (per-request fee on top of
 *    the base) → reported cost is an under-estimate.
 * Genuine model-variant suffixes (`:thinking`, `:extended`, `:beta`) are
 * deliberately *not* listed: they are distinct catalog entries with their own
 * pricing, so they should fall through to an exact match, not be stripped.
 */
const ROUTING_SUFFIXES = new Set(["floor", "nitro", "free", "online", "exacto"]);

/** Split a trailing routing suffix (e.g. ":floor") off a model name for catalog lookup. */
export function splitRoutingSuffix(modelName: string): { base: string; suffix?: string } {
  const colonIdx = modelName.lastIndexOf(":");
  if (colonIdx === -1) return { base: modelName };
  const suffix = modelName.slice(colonIdx + 1);
  return ROUTING_SUFFIXES.has(suffix) ? { base: modelName.slice(0, colonIdx), suffix } : { base: modelName };
}

/**
 * Resolve a model + auth for a "provider/model" string.
 *
 * An in-memory credential store (and in-memory models store) avoids /data/auth.json and
 * models-store.json lock deadlocks/writes on SIGKILL. The ModelRuntime reads models.json
 * (custom providers/models) and resolves API keys via the correct per-provider env vars
 * (e.g. GEMINI_API_KEY for google, ANTHROPIC_OAUTH_TOKEN/ANTHROPIC_API_KEY for anthropic).
 *
 * Falls back to a hand-built openai-completions model for env-driven local endpoints
 * (LiteLLM/Ollama) with no models.json entry. When no auth is configured anywhere, a
 * dummy runtime key is set so the SDK reaches keyless local endpoints instead of bailing.
 *
 * With `strict`, a model missing from the catalog/models.json throws instead of falling
 * back to that local endpoint — used for per-task overrides, where a typo must be a task
 * error rather than a silent request to the wrong endpoint.
 */
export async function resolveModel(
  modelStr: string,
  opts: { strict?: boolean } = {},
): Promise<ResolvedModel> {
  const { provider, modelName } = parseModelStr(modelStr);
  // Strip any routing-variant suffix for the catalog lookup; the full slug
  // (with suffix) is still what we send to the API via model.id below.
  const { base: lookupName, suffix: routingSuffix } = splitRoutingSuffix(modelName);

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: MODELS_JSON,
    modelsStore: new InMemoryModelsStore(),
  });
  const runtimeError = modelRuntime.getError();
  if (runtimeError) {
    log.warn("models.json failed to load; using built-in models only", { error: runtimeError });
  }

  // Built-in catalog + custom models.json.
  let model = modelRuntime.getModel(provider, lookupName);

  // Catalog hit on the base slug: clone (the registry returns a shared reference)
  // and restore the routing suffix on the id so OpenRouter applies the variant
  // while pricing/baseUrl come from the catalog entry.
  if (model && routingSuffix) {
    log.info("Applying routing suffix to resolved model", { model: lookupName, suffix: routingSuffix });
    model = { ...model, id: modelName } as Model<Api>;
  }

  if (!model && opts.strict) {
    throw new Error(`Unknown model "${modelStr}": not in the model catalog or models.json`);
  }

  if (!model) {
    const baseUrl =
      process.env.OPENAI_BASE_URL ||
      process.env.OPENAI_API_BASE ||
      LOCAL_PROVIDER_BASE_URLS[provider] ||
      "http://localhost:4000/v1";
    const contextWindow = parseInt(process.env.MODEL_CONTEXT_WINDOW ?? "131072", 10);
    // Output cap for custom models: MODEL_MAX_TOKENS if set (and valid), otherwise the
    // shared default. pi-ai clamps max_tokens to remaining context room per request (#79).
    const maxTokens = outputTokenCap();
    // Reasoning is off by default (most local chat models), but opt-in for reasoning
    // models served locally (e.g. gpt-oss) so pi surfaces their thinking instead of
    // letting it ride along in an unparsed side field. Set MODEL_REASONING=true.
    const reasoning = process.env.MODEL_REASONING === "true";
    log.info("Model not in registry, creating custom openai-completions model", {
      provider, model: modelName, baseUrl, contextWindow, maxTokens, reasoning,
    });
    // Register the endpoint as a provider on the runtime so request auth, headers and
    // streaming resolve through it like any catalog model.
    modelRuntime.registerProvider(provider, {
      baseUrl,
      api: "openai-completions",
      models: [
        {
          id: modelName,
          name: modelName,
          reasoning,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsStrictMode: false,
            supportsStore: false,
            maxTokensField: "max_tokens",
          },
        },
      ],
    });
    model = modelRuntime.getModel(provider, modelName);
    if (!model) throw new Error(`Failed to register custom model ${provider}/${modelName}`);
  }

  // Dummy key only when no auth is configured anywhere — hasConfiguredAuth() uses the
  // runtime's correct provider→env-var map, so real keys are never clobbered.
  if (!modelRuntime.hasConfiguredAuth(model.provider)) {
    await modelRuntime.setRuntimeApiKey(model.provider, "ollama");
  }

  // Cap max_tokens on EVERY model — registry models included. OpenRouter reserves
  // credit for the full max_tokens up front, so a registry model with a huge output
  // limit (e.g. 900k) made every call unaffordable while small replies were fine (#79).
  const modelLimit = (model as { maxTokens?: number }).maxTokens;
  const effectiveMaxTokens = outputTokenCap(modelLimit);
  const capKey = `${provider}/${model.id}`;
  if (!loggedMaxOutputTokens.has(capKey)) {
    loggedMaxOutputTokens.add(capKey);
    log.info("Effective max_tokens for model", {
      model: `${provider}/${model.id}`,
      maxTokens: effectiveMaxTokens,
      configured: process.env.MODEL_MAX_TOKENS ?? null,
      modelLimit: modelLimit ?? null,
    });
  }
  if (typeof modelLimit === "number" && modelLimit !== effectiveMaxTokens) {
    model = { ...model, maxTokens: effectiveMaxTokens } as Model<Api>;
  }

  return { model, provider, modelName, modelRuntime };
}
