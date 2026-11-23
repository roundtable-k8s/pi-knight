# Configuration

> How knights are differentiated through configuration, not code.

## Principle

Every knight runs the **same Docker image**. Identity, personality, capabilities, and model selection are injected via Kubernetes ConfigMaps, Secrets, and environment variables. Skill filtering is managed by the operator's sidecars (git-sync + skill-filter) — the runtime loads all skills from mounted paths.

## Configuration Layers

```
┌─────────────────────────────────┐
│  Environment Variables           │  Model, timeouts, NATS config
├─────────────────────────────────┤
│  ConfigMap (personality files)   │  SOUL.md, IDENTITY.md
├─────────────────────────────────┤
│  ExternalSecret (credentials)    │  API keys, tokens
├─────────────────────────────────┤
│  Image Defaults                  │  AGENTS.md, base TOOLS.md
└─────────────────────────────────┘
```

### File Overlay Priority
1. **PVC** (`/data`) — Knight's own edits (highest priority, persists across restarts)
2. **ConfigMap** (`/config`) — Injected personality files (SOUL.md, IDENTITY.md)
3. **Image Defaults** (`/app/defaults`) — Base operational contract (fallback)

Pi SDK's `DefaultResourceLoader` handles this natively:
- `cwd=/data` — project-local discovery (PVC workspace)
- `agentDir=/config` — global config (ConfigMap personality files, AGENTS.md)
- `additionalSkillPaths=["/skills"]` — merged arsenal skills built by the skill-filter sidecar

Knights can evolve their own files over time — ConfigMap seeds the initial state, the knight's own modifications on PVC take priority.

## Environment Variables

### Required
| Variable | Description | Example |
|----------|-------------|---------|
| `KNIGHT_NAME` | Knight identifier | `galahad` |
| `SUBSCRIBE_TOPICS` | NATS subject filter (comma-separated) | `fleet-a.tasks.security.>` |

### LLM Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `KNIGHT_MODEL` | LLM provider/model | `openrouter/deepseek/deepseek-v3.2` |
| `KNIGHT_THINKING` | Thinking level (off/minimal/low/medium/high) | `off` |
| `PI_MODELS_JSON` | Raw `/data/models.json` content to write at startup | unset |
| `PI_MODELS_JSON_B64` | Base64-encoded `/data/models.json` content | unset |
| `OPENROUTER_API_KEY` | OpenRouter key — covers the default + most upgrade models | From ExternalSecret |
| `ANTHROPIC_API_KEY` | Anthropic API key (only for native `anthropic/...` models) | From ExternalSecret |
| `OPENAI_API_KEY` | OpenAI API key (only for native `openai/...` models) | From ExternalSecret |
| `GEMINI_API_KEY` | Google API key (only for native `google/...` models) | From ExternalSecret |

### NATS Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `NATS_URL` | NATS server URL | `nats://nats.database.svc.cluster.local:4222` |
| `TASK_TIMEOUT_MS` | Default task timeout (ms) | `1800000` (30 min) |
| `MAX_CONCURRENT_TASKS` | Max parallel task execution | `2` |

### Sessions
Each chain run gets its own agent session: tasks carrying the operator's `runId`
(`TaskPayload.RunID`) share one session per run, and a new `runId` starts a fresh
session so context never bleeds between runs. Tasks without a `runId` (ad-hoc,
missions) keep reusing the current session. Every session is persisted as a JSONL
file under `/data/sessions`; old files are pruned at startup and on each run change.

| Variable | Description | Default |
|----------|-------------|---------|
| `SESSION_RETENTION_MAX_FILES` | Max persisted session files kept on the PVC (`0` = no cap) | `100` |
| `SESSION_RETENTION_DAYS` | Delete session files not modified for this many days (`0` = no cap) | `30` |

### Observability
| Variable | Description | Default |
|----------|-------------|---------|
| `METRICS_PORT` | Health/metrics HTTP port | `3000` |
| `LOG_LEVEL` | Log verbosity (debug/info/warn/error) | `info` |

## Skill Filtering

Skill filtering is managed at the **deployment layer**, not in pi-knight code:

- **git-sync** sidecars (one per arsenal in `spec.arsenal` + `spec.arsenals`) sync each repo to `/arsenal/<name>`
- **skill-filter** links the categories in the Knight's `spec.skills` into `/skills/<category>/<skill>`; when several arsenals provide the same skill, the last one wins
- Pi SDK's `loadSkills()` loads everything from `/skills` — no runtime filtering

See [Skills](SKILLS.md#arsenal-delivery) for the layout and an example.

This keeps the runtime simple and lets GitOps control what each knight can do.

## Native Tools

Pi-knight registers custom tools alongside Pi SDK's built-in coding tools:

| Tool | Description | Source |
|------|-------------|--------|
| `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | File I/O and shell | Pi SDK built-in |
| `nats_publish` | Fire-and-forget NATS message | pi-knight custom |
| `nats_request` | Cross-knight collaboration (send + wait) | pi-knight custom |

## Session Persistence

Knights maintain persistent sessions across tasks:
- Session state stored as JSONL on PVC (`/data`)
- Pi SDK auto-compacts when context grows too large
- Knights remember previous tasks within their session lifetime
- Survives pod restarts (PVC-backed)

## Thinking Level

`KNIGHT_THINKING` can also be overridden per-task by the dispatching agent via the NATS message metadata. This lets Tim request deeper reasoning for complex tasks without changing the knight's default.

## ConfigMap Structure

Each knight gets a ConfigMap with personality files:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: galahad-config
  namespace: roundtable
data:
  SOUL.md: |
    # Galahad — The Shield of the Realm
    ...
  IDENTITY.md: |
    - Name: Sir Galahad
    - Domain: Security & Threat Intelligence
    ...
```

## Secrets Management

API keys and tokens managed via Infisical → ExternalSecret → K8s Secret:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: galahad-secret
  namespace: roundtable
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: infisical
  target:
    name: galahad-secret
  dataFrom:
    - find:
        name:
          regexp: "^ANTHROPIC_.*"
```

### GitHub credentials

GitHub App installation tokens expire after an hour, but env vars are frozen at
pod start. When the Knight (or its RoundTable) sets `spec.github.tokenSecretRef`,
the operator mounts that Secret read-only and sets
`GITHUB_TOKEN_FILE=/var/run/secrets/roundtable/github/token`. The kubelet
rewrites the file when the Secret rotates. With it set, the entrypoint:

- configures git to use `/usr/local/bin/git-credential-roundtable`, which reads
  the file on every call and answers `username=x-access-token` for
  `https://github.com`
- puts `/opt/roundtable/bin` first on `PATH`, where a `gh` shim exports
  `GH_TOKEN` from the file per invocation and then execs the real `gh`

Neither script logs the token. Without `GITHUB_TOKEN_FILE` the old behaviour is
kept: `gh auth git-credential` as the git helper when `gh` is installed, else a
static store written from `GH_TOKEN`.

## Model Selection Strategy

**Cheap by default, upgrade per knight.** The whole fleet runs the default
`KNIGHT_MODEL` (`openrouter/deepseek/deepseek-v3.2`) unless a knight sets its own
`KNIGHT_MODEL`. Routing everything through OpenRouter means one `OPENROUTER_API_KEY`
secret covers the default *and* the upgrade models — no per-provider key sprawl.

The default was chosen for running many agents cheaply: it's a competent tool-caller
(important — weak tool models loop and retry, which costs more per finished task) and
it supports prompt caching, which matters because each knight reuses a persistent
session with a large stable prefix (preamble + AGENTS.md/SOUL.md + skills).

To upgrade an individual knight, set `KNIGHT_MODEL` on its pod:

| Need | Suggested `KNIGHT_MODEL` | Why |
|------|--------------------------|-----|
| Fleet default (cheap) | `openrouter/deepseek/deepseek-v3.2` | Cheap, good tools, cached |
| Cheapest viable | `openrouter/google/gemini-2.5-flash-lite` | Lowest cost, 1M context |
| Hard reasoning / writing | `openrouter/anthropic/claude-sonnet-4.6` | Strongest general model |
| Reliable cheap tier | `openrouter/anthropic/claude-haiku-4.5` | Best tool reliability under $1/M in |
| Long-context research | `openrouter/google/gemini-2.5-pro` | 1M+ context, strong synthesis |

```yaml
# Upgrade just this knight; the rest of the fleet stays on the default.
env:
  - name: KNIGHT_MODEL
    value: "openrouter/anthropic/claude-sonnet-4.6"
```

These are starting points — adjust based on observed task quality and cost. The
`/model` cost columns in `pi-ai`'s registry (input/output/cacheRead per M tokens)
are the source of truth when comparing options.

## Native Provider Override

For experiments where Pi SDK should use a native provider config instead of only
`KNIGHT_MODEL`, inject a Pi models file at startup:

```yaml
env:
  - name: KNIGHT_MODEL
    value: "local/gemma4-26b"
  - name: PI_MODELS_JSON_B64
    valueFrom:
      secretKeyRef:
        name: galahad-secret
        key: PI_MODELS_JSON_B64
```

At startup, `entrypoint.sh` writes the provided content to:

```text
/data/models.json
```

This is the runtime's `agentDir`, so the pi `ModelRuntime` loads it automatically.
It is intended for canary deployments such as native Ollama experiments,
without changing the default fleet path.

> **Note:** in `models.json`, `apiKey`/`headers` values are treated as
> literals. To read from an environment variable, use explicit syntax —
> `"apiKey": "$OPENROUTER_API_KEY"` (or `"${OPENROUTER_API_KEY}"`), not the bare
> variable name.
