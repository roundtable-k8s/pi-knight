# Pi-Knight Skills System

## Overview

Pi-Knight uses the **Pi SDK's built-in agentskills.io loader** for skill discovery and prompt injection.
This is the same skill system that powers OpenClaw — no custom walker needed.

## How It Works

1. **Discovery**: `loadSkills()` from `@earendil-works/pi-coding-agent` recursively scans skill directories
2. **Parsing**: Reads SKILL.md files with YAML frontmatter (name, description)
3. **Prompt Injection**: `formatSkillsForPrompt()` generates XML `<available_skills>` block per [agentskills.io spec](https://agentskills.io/integrate-skills)
4. **Deduplication**: Canonicalizes each SKILL.md path (resolving symlinks) so a skill reached via two paths loads once; distinct skills with the same `name` are first-wins, reported as a collision diagnostic
5. **Validation**: Checks skill names (lowercase, hyphens only, ≤64 chars) and descriptions (required, ≤1024 chars)

## Skill Sources

Pi SDK loads skills from multiple locations (first-write-wins on name collisions):

| Source | Path | Description |
|--------|------|-------------|
| User skills | `/config/skills/` | From ConfigMap (agentDir) |
| Project skills | `/data/.pi/skills/` | From PVC workspace |
| Additional paths | `/skills/` | Merged arsenal skills (git-sync + skill-filter sidecars) |

## Arsenal Delivery

Skills come from one or more **arsenal** git repos, delivered by sidecars the
[roundtable operator](https://github.com/roundtable-k8s/roundtable) adds to the pod.
A Knight has `spec.arsenal` (default repo
[`roundtable-k8s/arsenal`](https://github.com/roundtable-k8s/arsenal)) plus optional
`spec.arsenals`, merged in order: `arsenal` first, then each `arsenals` entry.

```yaml
apiVersion: ai.roundtable.io/v1alpha1
kind: Knight
metadata:
  name: galahad
spec:
  skills: [shared, security]           # categories linked into /skills
  arsenal:
    repo: https://github.com/roundtable-k8s/arsenal   # name defaults to "arsenal"
  arsenals:
    - name: private                    # defaults to the repo basename
      repo: https://github.com/example/private-arsenal
      ref: main
      period: 300s
```

### git-sync sidecars

One git-sync sidecar per arsenal: `git-sync` for `spec.arsenal`, `git-sync-<name>` for
each `spec.arsenals` entry. Each syncs into its own root `/arsenal/.sync/<name>` and
exposes the current tree at `/arsenal/<name>`. The `arsenal` volume is mounted at
`/arsenal` (read-only in the pi-knight container), not `/skills`.

### skill-filter sidecar

The `skill-filter` sidecar builds `/skills/<category>/<skill>` symlinks for the
categories in `spec.skills`. Merging is **per skill**: the last arsenal that provides
`<category>/<skill>` wins, so `arsenals` entries override `arsenal`. `/skills/<category>`
is a real directory (older layouts symlinked the whole category). It re-runs every
60s, relinking changed skills and pruning skills removed upstream.

```
/arsenal/
├── .sync/                      # git-sync roots (one per arsenal)
├── arsenal -> .sync/arsenal/…  # current tree of spec.arsenal
└── private -> .sync/private/…  # current tree of spec.arsenals[name=private]

/skills/                        # built by skill-filter, read-only to pi-knight
├── security/
│   ├── opencti-intel -> /arsenal/arsenal/security/opencti-intel
│   └── shodan-recon  -> /arsenal/private/security/shodan-recon   # overridden
└── shared/
    ├── nats-comms    -> /arsenal/arsenal/shared/nats-comms
    └── web-search    -> /arsenal/arsenal/shared/web-search
```

pi-knight loads everything under `/skills` (`skillPaths` / `additionalSkillPaths: ["/skills"]`);
the Pi SDK loader follows the symlinked skill dirs and respects `.gitignore`.

## Startup Race Condition

git-sync and skill-filter may not have finished their first pass when pi-knight starts.
The startup code retries skill loading up to 20 times with 3s delays (~60s).

## Skill Reload

Pi SDK supports skill reload via `AgentSession.reload()` which re-discovers all skills,
rebuilds the system prompt, and picks up any changes the sidecars have linked into `/skills`.
This is triggered by the `/reload` slash command in interactive mode.

For headless knight operation, skills are loaded fresh per task (each task creates a new session).

## SKILL.md Format

Per [agentskills.io](https://agentskills.io) spec:

```markdown
---
name: opencti-intel
description: "Query OpenCTI threat intelligence platform for STIX objects, indicators, and threat data."
---

# OpenCTI Intelligence Skill

## Usage
...scripts and instructions...
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphens only, must match parent dir name |
| `description` | Yes | ≤1024 chars, injected into system prompt |
| `disable-model-invocation` | No | If true, skill only available via explicit `/skill:name` command |

## Category Filtering

Category filtering happens in the **skill-filter sidecar**, not in pi-knight:
only the categories listed in the Knight's `spec.skills` are linked into `/skills`,
and Pi SDK's `loadSkills()` then loads everything it finds there. The operator also
exposes the list as `KNIGHT_SKILLS` in the knight's ConfigMap; the runtime does not
read it.

The agent's system prompt and personality (SOUL.md) guide it to stay within its domain.
