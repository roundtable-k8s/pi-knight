import { readFileSync } from "node:fs";

/** Where the operator's config ConfigMap (including the KNIGHT_SKILLS key) is mounted. */
export const SKILLS_CONFIG_FILE = "/config/KNIGHT_SKILLS";

/**
 * Whether the operator expects any skills on this knight.
 *
 * KNIGHT_SKILLS is the comma-joined `spec.skills` list the operator writes into
 * the knight's ConfigMap (mounted at /config; env var takes precedence if set).
 * Returns false only when the value is present and empty — i.e. no categories
 * configured, so the skill-filter will never link anything into /skills.
 * Returns true when the signal is missing (older operator) so behaviour is unchanged.
 */
export function skillsExpected(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): boolean {
  let raw = env["KNIGHT_SKILLS"];
  if (raw === undefined) {
    try {
      raw = readFile(SKILLS_CONFIG_FILE);
    } catch {
      return true;
    }
  }
  return raw.split(",").some((s) => s.trim() !== "");
}

export interface WaitForSkillsOptions {
  /** Poll attempts before giving up. */
  maxAttempts: number;
  /** Delay between attempts. */
  intervalMs: number;
  /** Returns the number of skills currently loadable. */
  load: () => number;
  /** False when no skills are configured, which skips the wait. */
  expected: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  info?: (msg: string, data?: Record<string, unknown>) => void;
}

/** Poll for skills (git-sync / skill-filter race at start-up); returns the skill count. */
export async function waitForSkills(opts: WaitForSkillsOptions): Promise<number> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const info = opts.info ?? (() => {});
  const start = now();
  if (!opts.expected) {
    const count = opts.load();
    info("Skill wait skipped: no skills configured", { count, waitedMs: now() - start });
    return count;
  }
  let count = 0;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    count = opts.load();
    if (count > 0) break;
    if (attempt < opts.maxAttempts - 1) {
      info("No skills found, waiting for git-sync...", { attempt: attempt + 1 });
      await sleep(opts.intervalMs);
    }
  }
  info("Skill wait finished", { count, waitedMs: now() - start });
  return count;
}
