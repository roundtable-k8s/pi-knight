/**
 * Session lifecycle helpers: per-chain-run session keying and on-disk retention.
 *
 * A knight holds exactly one live AgentSession in memory. Chain tasks carry the
 * operator-assigned run id (TaskPayload.RunID, JSON `runId`); a task from a new run
 * gets a fresh session so context never bleeds between runs (#31). Every fresh
 * session the pi SDK persists becomes a JSONL file under <agentDir>/sessions, so
 * per-run sessions would grow the PVC without bound — pruneSessionFiles caps that.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

// Root of the persisted per-session JSONL files (pi SDK writes under
// <agentDir>/sessions; knights use agentDir "/data"). Overridable for tests.
export const SESSIONS_ROOT = process.env.KNIGHT_SESSIONS_ROOT ?? "/data/sessions";

export type RunSessionAction =
  /** Keep using the current session (same run, no run id, or no session yet). */
  | "reuse"
  /** New run, but the current session was never prompted — take it over as-is. */
  | "adopt"
  /** New run with a used session — dispose it and start a fresh one. */
  | "reset";

/**
 * Decide what to do with the live session when a task arrives.
 *
 * - No runId (ad-hoc/mission tasks, older operators): reuse — the pre-#31 behaviour.
 * - Same runId as the current session: reuse — steps of one chain run share context.
 * - Different runId: reset, unless the session is pristine (never prompted, no
 *   history), in which case adopting it is equivalent and keeps startup pre-warm useful.
 */
export function decideRunSession(opts: {
  runId: string | undefined;
  currentRunId: string | undefined;
  hasSession: boolean;
  sessionPristine: boolean;
}): RunSessionAction {
  const { runId, currentRunId, hasSession, sessionPristine } = opts;
  if (!runId || runId === currentRunId || !hasSession) return "reuse";
  return sessionPristine ? "adopt" : "reset";
}

export interface SessionFile {
  id: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

// A persisted session's public id is the uuid embedded in its filename
// (`<iso-timestamp>_<uuid>.jsonl`).
export function sessionIdFromFilename(name: string): string {
  const stem = name.replace(/\.jsonl$/, "");
  const us = stem.lastIndexOf("_");
  return us >= 0 ? stem.slice(us + 1) : stem;
}

/**
 * List every persisted session file under `root` (one subdir per cwd), newest
 * first by mtime. Returns [] if the dir doesn't exist yet.
 */
export async function listSessionFiles(root: string = SESSIONS_ROOT): Promise<SessionFile[]> {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = dirents.filter((d) => d.isDirectory()).map((d) => join(root, d.name));
  // Defensive: also consider .jsonl files sitting directly in the root.
  if (dirents.some((d) => d.isFile() && d.name.endsWith(".jsonl"))) dirs.push(root);

  const files: SessionFile[] = [];
  for (const dir of dirs) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = await stat(path);
        files.push({ id: sessionIdFromFilename(name), path, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // file vanished between readdir and stat — skip
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

export interface RetentionPolicy {
  /** Keep at most this many session files (newest first). 0 disables the count cap. */
  maxFiles: number;
  /** Delete session files not modified for this long. 0 disables the age cap. */
  maxAgeMs: number;
}

/**
 * Pure selection of which session files to delete under `policy`.
 * `files` must be sorted newest first; paths in `keep` (the live session) are never
 * selected and count toward `maxFiles` first, so the cap includes the live session.
 */
export function selectSessionsToPrune(
  files: SessionFile[],
  policy: RetentionPolicy,
  keep: ReadonlySet<string>,
  now: number,
): SessionFile[] {
  const out: SessionFile[] = [];
  let kept = files.filter((f) => keep.has(f.path)).length;
  for (const f of files) {
    if (keep.has(f.path)) continue;
    const tooOld = policy.maxAgeMs > 0 && now - f.mtimeMs > policy.maxAgeMs;
    const overCount = policy.maxFiles > 0 && kept >= policy.maxFiles;
    if (tooOld || overCount) out.push(f);
    else kept++;
  }
  return out;
}

/** Apply `policy` to the session files under `root`. Returns the deleted paths. */
export async function pruneSessionFiles(
  policy: RetentionPolicy,
  keep: ReadonlySet<string> = new Set(),
  root: string = SESSIONS_ROOT,
  now: number = Date.now(),
): Promise<string[]> {
  if (policy.maxFiles <= 0 && policy.maxAgeMs <= 0) return [];
  const victims = selectSessionsToPrune(await listSessionFiles(root), policy, keep, now);
  const removed: string[] = [];
  for (const v of victims) {
    try {
      await unlink(v.path);
      removed.push(v.path);
    } catch {
      // already gone or unreadable — not worth failing a task over
    }
  }
  return removed;
}
