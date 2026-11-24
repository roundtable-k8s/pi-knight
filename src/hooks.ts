/**
 * Tool call hooks for pi-knight — safety, observability, and metrics.
 *
 * Implemented as an inline pi extension (`tool_call`, `tool_result` and
 * `tool_execution_end` events) loaded through the session's resource loader. In pi 1.x
 * AgentSession owns the agent's beforeToolCall/afterToolCall hooks to drive the extension
 * runner, so extensions are the supported way to intercept tool execution.
 */
import { isToolCallEventType, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.js";
import { toolCallsTotal, toolCallDuration, toolCallErrors, toolCallsBlocked } from "./metrics.js";

// ─── Dangerous operation patterns ───────────────────────────────────

/** Bash commands that should be blocked outright */
const BLOCKED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(?:\s|$|\*)/, reason: "Recursive delete at root level" },
  // Match the flag as a whole token: not a branch like `fix-f`, and --force-with-lease stays allowed.
  // Known residual false positive: the same text as a quoted argument (e.g. inside `echo`) also matches.
  // The short-flag check (`-f` anywhere in the flag cluster) is deliberately broad; it fails safe.
  { pattern: /\bgit\s+push\b[^;&|\n]*\s--force(?=\s|$)/, reason: "Force push without lease (use --force-with-lease or new commits)" },
  { pattern: /\bgit\s+push\b[^;&|\n]*\s-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)/, reason: "Force push (use new commits instead)" },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, reason: "World-writable permissions" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "Direct device write" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "Filesystem format" },
];

/** Patterns that indicate secrets in tool output */
const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+=]{20,}/gi,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi,
  /ghp_[A-Za-z0-9_]{36,}/g,     // GitHub PATs
  /ghs_[A-Za-z0-9_]{36,}/g,     // GitHub app tokens
  /sk-[A-Za-z0-9]{40,}/g,       // OpenAI keys
  /xoxb-[A-Za-z0-9\-]+/g,       // Slack bot tokens
  /AKIA[A-Z0-9]{16}/g,          // AWS access keys
];

// ─── Pure helpers ──────────────────────────────────────────────────

/** Reason a bash command must be blocked, or undefined when it is allowed. */
export function findBlockedBashReason(command: string): string | undefined {
  return BLOCKED_BASH_PATTERNS.find(({ pattern }) => pattern.test(command))?.reason;
}

/** True when text matches any known secret pattern. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0; // global patterns are stateful across test() calls
    return pattern.test(text);
  });
}

/** Replace every known secret pattern in text with [REDACTED]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

function truncateArgs(args: unknown): string {
  const str = JSON.stringify(args);
  return str.length > 200 ? str.slice(0, 200) + "…" : str;
}

// ─── Extension ─────────────────────────────────────────────────────

/**
 * Safety guardrails (block dangerous bash / secret writes), secret redaction of tool
 * results, and tool-call logging + metrics. Pass to DefaultResourceLoader `extensionFactories`.
 */
export const toolHooksExtension: ExtensionFactory = (pi) => {
  pi.on("tool_call", (event) => {
    log.debug("Tool call started", {
      tool: event.toolName,
      toolCallId: event.toolCallId,
      argsPreview: truncateArgs(event.input),
    });

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      const reason = findBlockedBashReason(command);
      if (reason) {
        log.warn("Blocked dangerous bash command", {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          reason,
          command: command.slice(0, 200),
        });
        toolCallsBlocked.inc({ tool: event.toolName, reason });
        return {
          block: true,
          reason: `🛡️ Blocked: ${reason}. This operation is not allowed for safety. Use a safer alternative.`,
        };
      }
    }

    if (isToolCallEventType("write", event) && containsSecret(event.input.content ?? "")) {
      log.warn("Blocked secret write", { tool: event.toolName, toolCallId: event.toolCallId });
      toolCallsBlocked.inc({ tool: event.toolName, reason: "secret_in_content" });
      return {
        block: true,
        reason: "🛡️ Blocked: Content appears to contain secrets/credentials. Never write secrets to files.",
      };
    }

    return undefined;
  });

  // Redact secrets before the result enters the agent's context window.
  pi.on("tool_result", (event) => {
    let changed = false;
    const content = event.content.map((block) => {
      if (block.type === "text" && containsSecret(block.text)) {
        changed = true;
        return { ...block, text: redactSecrets(block.text) };
      }
      return block;
    });
    if (!changed) return undefined;
    log.warn("Sanitized secrets from tool result", { tool: event.toolName, toolCallId: event.toolCallId });
    return { content };
  });

  // Log model/token metadata for each LLM call (payload is passed through unmodified).
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const p = event.payload as any;
      log.info("LLM request payload", {
        model: ctx.model?.id ?? "unknown",
        provider: ctx.model?.provider ?? "unknown",
        messageCount: Array.isArray(p?.messages) ? p.messages.length : undefined,
        toolCount: Array.isArray(p?.tools) ? p.tools.length : 0,
        toolNames: Array.isArray(p?.tools) ? p.tools.map((t: any) => t?.function?.name ?? t?.name).filter(Boolean) : [],
        hasToolChoice: p?.tool_choice !== undefined,
        maxTokens: p?.max_tokens ?? p?.max_completion_tokens,
        stream: p?.stream,
      });
      log.debug("LLM request payload (full)", { payload: p });
    } catch (err) {
      log.warn("before_provider_request hook threw", { error: String(err) });
    }
    return undefined;
  });

  // Fires for every finalized call (including blocked ones), with a monotonic duration.
  pi.on("tool_execution_end", (event) => {
    const duration = event.durationMs ?? 0;
    const tool = event.toolName;
    toolCallsTotal.inc({ tool, status: event.isError ? "error" : "success" });
    toolCallDuration.observe({ tool }, duration / 1000);
    if (event.isError) toolCallErrors.inc({ tool });
    log.info("Tool call completed", {
      tool,
      toolCallId: event.toolCallId,
      duration,
      isError: event.isError,
      resultSize: JSON.stringify(event.result?.content ?? null).length,
    });
  });
};
