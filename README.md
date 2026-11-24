# Pi-Knight 🛡️

> Universal base agent runtime for the Knights of the Round Table, built on [Pi SDK](https://github.com/earendil-works/pi-mono).

## What Is This?

Pi-Knight is a Kubernetes-native AI agent runtime that turns a single Docker image into any specialized agent. Each knight runs the same image — personality, capabilities, and model selection are all configuration.

Built on the same Pi SDK that powers [OpenClaw](https://github.com/openclaw/openclaw).

## Architecture

```
Pi-Knight Pod (Kubernetes)
├── pi-knight          → Agent runtime (Pi SDK + NATS + custom tools)
├── git-sync[-<name>]  → One per arsenal repo (spec.arsenal + spec.arsenals) → /arsenal/<name>
├── skill-filter       → Merges the arsenals into /skills/<category>/<skill> for spec.skills
└── chrome (optional)  → Headless browser for research tasks
```

**Communication:** NATS JetStream (async, durable, auditable)  
**Skills:** agentskills.io format, filtered per knight by category (`spec.skills`) in the operator's skill-filter sidecar  
**Models:** Any LLM via `pi-ai` — Claude, GPT, Gemini, Ollama, etc.  
**Observability:** Structured JSON logs, Prometheus metrics, cost tracking

For provider experiments, the runtime can optionally write
`/data/models.json` from `PI_MODELS_JSON` or `PI_MODELS_JSON_B64`
at startup, which makes native-provider canaries possible without a custom image.

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](docs/ARCHITECTURE.md) | System design, layer map, pod structure |
| [NATS](docs/NATS.md) | Message format, streams, consumer config |
| [Observability](docs/OBSERVABILITY.md) | Logging, metrics, health checks, alerting |
| [Skills](docs/SKILLS.md) | Skill system, arsenal bridge, tool policies |
| [Configuration](docs/CONFIGURATION.md) | Per-knight config, model selection, env vars |
| [Security](docs/SECURITY.md) | Isolation model, threat model, OWASP LLM mitigations |

## Quick Start

```bash
# Install dependencies
npm install

# Set API key — the default model routes through OpenRouter
export OPENROUTER_API_KEY=sk-or-...
# For a native-provider model instead, set its key + KNIGHT_MODEL:
#   export ANTHROPIC_API_KEY=sk-ant-... && export KNIGHT_MODEL=anthropic/claude-sonnet-4.6

# Run locally (requires NATS)
npm run dev
```

### Pinned toolchain (Nix)

`flake.nix` pins nixpkgs and provides the same Node 22, npm, git, gh and jq
that CI and the knight tools image use:

```bash
nix develop                          # shell with node/npm/git/gh/jq on PATH
nix build .#knight-tools             # buildEnv of the same tools (result/bin)
nix flake check                      # knight-tools has every tool and node 22
```

Inside `nix develop`, the CI steps are `npm ci`, `npx tsc --noEmit`, `npm test`
and `npm run build`.

## Knights

| Knight | Domain | Skills |
|--------|--------|--------|
| Galahad | Security & Threat Intel | security |
| Percival | Finance & Tax | finance |
| Lancelot | Career & Professional | career |
| Tristan | Infrastructure & HomeLab | infra |
| Bedivere | Household & Life Admin | home |
| Kay | Research & Entertainment | research, intel |
| Patsy | Vault Curator | vault |

The model is per-knight configuration via `KNIGHT_MODEL`; the fleet default is
`openrouter/deepseek/deepseek-v3.2`. See [Configuration](docs/CONFIGURATION.md).

## Why Pi?

Pi-Knight uses Pi's SDK directly — native API calls, no CLI subprocess, no provider lock-in:
- **Direct LLM access** — native API calls, no subprocess spawning
- **Multi-provider** — any model via `pi-ai` (OpenRouter, Anthropic, OpenAI, Gemini, Ollama, …)
- **Built-in skill system** — sessions, compaction, extensions
- **Small footprint** — just the packages
- **Hackable** — TypeScript, well-documented

## License

MIT

## Draining on rollout

On `SIGTERM` the knight stops fetching new tasks, `/ready` returns 503 (`"status": "draining"`) so the pod
leaves Service endpoints, and in-flight tasks keep heartbeating until they publish their result and ack.
It then exits. The wait is bounded by `DRAIN_TIMEOUT_MS` (default `TASK_TIMEOUT_MS` + 60s, matching the
operator's `terminationGracePeriodSeconds`); the kubelet SIGKILLs after the pod grace period regardless.
