/**
 * Structured TaskResult fields `prs` and `verdict` (roundtable docs/knight-task-contract.md,
 * roundtable-k8s/roundtable#258). Consumers fall back to parsing prose, so these are
 * best-effort and conservative: when nothing is found the fields are omitted.
 */

export type PRAction = "opened" | "updated";
export interface PRRef {
  repo?: string;
  number: number;
  url?: string;
  action?: PRAction;
}
export type Verdict = "ship_it" | "needs_changes";
export interface Structured {
  prs: PRRef[];
  verdict?: Verdict;
}

const PR_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
const VERDICT_RE = /^[\s>*_#-]*verdict[\s*_]*[:=-][\s*_`]*(ship[ _-]?it|needs[ _-]?changes)\b/gim;

export function parseVerdict(text: string): Verdict | undefined {
  const ms = [...text.matchAll(VERDICT_RE)];
  if (ms.length === 0) return undefined;
  return ms[ms.length - 1][1].toLowerCase().startsWith("ship") ? "ship_it" : "needs_changes";
}

function prUrls(text: string): PRRef[] {
  return [...text.matchAll(PR_URL_RE)].map((m) => ({ repo: m[1], number: Number(m[2]), url: m[0] }));
}

/** Pull `{command, output}` pairs for successful bash calls out of session messages. */
export function bashCalls(messages: unknown[]): Array<{ command: string; output: string }> {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of messages as Array<Record<string, any>>) {
    if (m?.role !== "toolResult" || !m.toolCallId) continue;
    const text = Array.isArray(m.content)
      ? m.content.map((p: any) => (p?.type === "text" ? p.text ?? "" : "")).join("\n")
      : typeof m.content === "string" ? m.content : "";
    results.set(m.toolCallId, { text, isError: Boolean(m.isError) });
  }
  const calls: Array<{ command: string; output: string }> = [];
  for (const m of messages as Array<Record<string, any>>) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p?.type !== "toolCall" || p.name !== "bash") continue;
      const command = p.arguments?.command;
      const res = results.get(p.id);
      if (typeof command !== "string" || !res || res.isError) continue;
      calls.push({ command, output: res.text });
    }
  }
  return calls;
}

/** Split a shell script into rough simple commands (good enough to spot gh/git invocations). */
function segments(command: string): string[] {
  return command.split(/&&|\|\||;|\n|\|/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Collect PRs from the gh/git commands the agent ran, falling back to PR URLs in the
 * final message, and the verdict from a final `Verdict:` line.
 *
 * @param messages only the messages of THIS task (sessions are shared across a run).
 */
export function extractStructured(messages: unknown[], finalText: string): Structured {
  const byKey = new Map<string, PRRef>();
  const add = (ref: PRRef) => {
    const key = `${ref.repo ?? ""}#${ref.number}`;
    const prev = byKey.get(key);
    // "opened" wins over a later "updated" of the same PR.
    if (!prev) byKey.set(key, ref);
    else if (prev.action !== "opened" && ref.action === "opened") byKey.set(key, ref);
  };

  let pushed = false;
  for (const { command, output } of bashCalls(messages)) {
    for (const seg of segments(command)) {
      if (/^(?:\S+=\S*\s+)*git\s+(?:-\S+\s+(?:\S+\s+)?)*push\b/.test(seg)) pushed = true;
      const gh = /^(?:\S+=\S*\s+)*gh\s+pr\s+(create|edit)\b/.exec(seg);
      if (!gh) continue;
      const action: PRAction = gh[1] === "create" ? "opened" : "updated";
      const urls = prUrls(output);
      if (urls.length > 0) {
        // gh prints the PR URL last on success.
        add({ ...urls[urls.length - 1], action });
        continue;
      }
      if (action === "updated") {
        const repo = /(?:-R|--repo)[ =]+(\S+)/.exec(seg)?.[1];
        const num = /\bedit\s+(?:-\S+\s+\S+\s+)*#?(\d+)\b/.exec(seg)?.[1];
        if (repo && num) {
          add({ repo, number: Number(num), url: `https://github.com/${repo}/pull/${num}`, action });
        }
      }
    }
  }

  // Fallback: PR URLs in the final message. A push implies the PR was updated.
  if (byKey.size === 0) {
    for (const ref of prUrls(finalText)) add(pushed ? { ...ref, action: "updated" } : ref);
  }

  return { prs: [...byKey.values()], verdict: parseVerdict(finalText) };
}
