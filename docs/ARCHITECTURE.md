# Pi-Knight Architecture

> Universal base agent runtime for the Knights of the Round Table, built on the [Pi SDK](https://github.com/earendil-works/pi-mono).

## Overview

Pi-Knight is a purpose-built agent harness built on Pi's layered SDK. Every knight runs the same image — differentiation comes from configuration, not code.

```
┌────────────────────────────────────────────────────────────────────┐
│                          Pi-Knight Pod                             │
│                                                                    │
│  ┌────────────┐  ┌──────────────────┐  ┌──────────────┐  ┌───────┐ │
│  │ pi-knight  │  │ git-sync         │  │ skill-filter │  │chrome │ │
│  │ container  │  │ git-sync-<name>… │  │   sidecar    │  │(opt.) │ │
│  └─────┬──────┘  └────────┬─────────┘  └──────┬───────┘  └───────┘ │
│        │                  │ writes            │ reads /arsenal     │
│        │                  ▼                   │ writes /skills     │
│   ┌────┴────┐      ┌─────────────┐      ┌─────┴──────┐             │
│   │  /data  │      │  /arsenal   │      │  /skills   │◄── pi-knight│
│   │  (PVC)  │      │ (emptyDir)  │      │ (emptyDir) │    (ro)     │
│   └─────────┘      └─────────────┘      └────────────┘             │
└────────────────────────────────────────────────────────────────────┘
         │                                         │
    NATS JetStream                           Shared Vault
   (database ns)                          (CephFS /vault)
```

## Design

| Concern | Approach |
|---------|----------|
| LLM Access | Direct API calls via `pi-ai` — any provider |
| Tool Execution | Native tool loop in `pi-agent-core` |
| Session Persistence | Built-in JSONL sessions |
| Context Management | Built-in context compaction |
| Skill System | Pi's native agentskills.io loader (built-in) |
| Model Flexibility | OpenRouter, Anthropic, OpenAI, Gemini, Ollama, 2000+ models |
| Extension System | Pi extensions for lifecycle hooks |
| Cost | Cheap fleet default, right-size per knight via `KNIGHT_MODEL` |

## Layer Map

```
┌─────────────────────────────────────────┐
│            pi-knight (this repo)         │
│  NATS integration, skill bridge,         │
│  observability, knight lifecycle         │
├────────────────────┬────────────────────┤
│  pi-coding-agent   │   custom tools     │
│  File I/O, bash,   │   nats-publish,    │
│  sessions, skills, │   vault-access,    │
│  agentskills.io    │   mcp-bridge       │
├────────────────────┴────────────────────┤
│            pi-agent-core                 │
│  Agent loop, tool execution, events      │
├─────────────────────────────────────────┤
│               pi-ai                      │
│  Unified LLM API, streaming, cost track  │
└─────────────────────────────────────────┘
```

## Pod Architecture

Each knight runs as a Kubernetes pod with the main container, one git-sync sidecar per arsenal, the skill-filter sidecar, and optionally Chrome:

### pi-knight (main container)
- The agent runtime
- Subscribes to NATS JetStream for task dispatch
- Executes tasks using Pi's agent loop
- Publishes results back to NATS
- Exposes health/metrics endpoints

### git-sync (one sidecar per arsenal)
- One sidecar per arsenal repo: `git-sync` for `spec.arsenal` (default [`roundtable-k8s/arsenal`](https://github.com/roundtable-k8s/arsenal)), `git-sync-<name>` for each `spec.arsenals` entry
- Each syncs into its own root `/arsenal/.sync/<name>` and exposes the current tree at `/arsenal/<name>` (name defaults to the repo basename)
- The `arsenal` volume is mounted at `/arsenal`, not `/skills`

### skill-filter (sidecar)
- Builds `/skills/<category>/<skill>` symlinks for the categories in the Knight's `spec.skills`
- Merges per skill across arsenals: the **last** arsenal (order: `arsenal`, then `arsenals`) that provides `<category>/<skill>` wins
- Re-runs every 60s and prunes skills removed upstream
- pi-knight loads everything under `/skills`; the Pi SDK loader follows the symlinked skill dirs

### chrome (optional sidecar)
- Headless Chrome for web research tasks
- Available to knights that need browser access

## Key Design Principles

1. **One image, many knights** — Configuration via ConfigMap (SOUL.md, IDENTITY.md, TOOLS.md) + env vars
2. **Model flexibility** — Each knight can use a different LLM provider/model via `KNIGHT_MODEL`
3. **Native skill support** — Pi SDK's built-in agentskills.io loader discovers arsenal skills directly
4. **Immediate NATS ack** — At-most-once delivery, ack before execution
5. **Observable** — Structured logging, Prometheus metrics, cost tracking per task
6. **Fail gracefully** — Task timeouts, circuit breakers, health checks, backpressure
