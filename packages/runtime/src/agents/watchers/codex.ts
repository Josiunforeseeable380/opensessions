/**
 * Codex agent watcher
 *
 * Watches Codex transcript files under ~/.codex/sessions/ (or $CODEX_HOME/sessions),
 * determines agent status from the latest transcript events, and emits events
 * mapped to mux sessions via the working directory from session_meta or turn_context.
 *
 * Also reads ~/.codex/session_index.jsonl (or $CODEX_HOME/session_index.jsonl)
 * for human-readable thread names.
 *
 * Detection uses a recursive fs.watch when available plus a periodic poll to
 * catch missed writes and new files.
 *
 * ## Codex JSONL Lifecycle (observed v0.117.0, codex_cli_rs)
 *
 * Each transcript file is a JSONL file at:
 *   ~/.codex/sessions/<year>/<month>/<day>/rollout-<datetime>-<uuid>.jsonl
 *
 * ### Data format generations
 *
 * **New format (v0.41+, response_item wrapper):**
 *   session_meta, event_msg, response_item, turn_context, compacted
 *
 * **Old format (pre-v0.41, top-level entries):**
 *   message, function_call, function_call_output, reasoning
 *
 * Both formats may coexist across different files. All 2026+ files use the
 * new format.
 *
 * ### Entry types (new format)
 *
 * **session_meta** — First entry. Contains cwd, cli_version, originator, etc.
 * **event_msg** — Lifecycle events with payload.type:
 *   - `task_started`         → "running" (session beginning)
 *   - `user_message`         → "running" (user prompt submitted)
 *   - `agent_message`        → depends on payload.phase:
 *       - phase=commentary   → "running" (model streaming)
 *       - phase=final_answer → "done" (model finished)
 *       - no phase           → "running" (intermediate response)
 *   - `agent_reasoning`      → "running" (model reasoning, skip — no status change)
 *   - `token_count`          → skip (metadata, no status change)
 *   - `task_complete`        → "done" (session finished)
 *   - `turn_aborted`         → "interrupted" (always reason=interrupted)
 *   - `entered_review_mode`  → skip (review mode lifecycle)
 *   - `exited_review_mode`   → skip (review mode lifecycle)
 *   - `thread_rolled_back`   → skip (context management)
 *   - `context_compacted`    → skip (context management)
 *
 * **response_item** — Model interaction entries with payload.type:
 *   - `message` role=user      → "running" (user prompt or context injection)
 *   - `message` role=assistant → depends on payload.phase:
 *       - phase=commentary     → "running"
 *       - phase=final_answer   → "done"
 *       - no phase             → "running" (intermediate)
 *   - `message` role=developer → skip (system/permissions prompts)
 *   - `function_call`          → "running" (tool invocation)
 *   - `function_call_output`   → "running" (tool result)
 *   - `reasoning`              → "running" (model reasoning)
 *   - `custom_tool_call`       → "running" (MCP/custom tool)
 *   - `custom_tool_call_output`→ "running" (custom tool result)
 *   - `web_search_call`        → "running" (web search)
 *
 * **turn_context** — Per-turn metadata with cwd. Skip for status.
 * **compacted** — Context compaction. Skip for status.
 *
 * ### Entry types (old format)
 *   - `message` role=user      → "running"
 *   - `message` role=assistant → "running" (no phase in old format)
 *   - `function_call`          → "running"
 *   - `function_call_output`   → "running"
 *   - `reasoning`              → "running"
 *
 * ### Lifecycle flow (observed in headless `codex exec`)
 *   1. session_meta (cwd)
 *   2. event_msg task_started
 *   3. response_item message role=developer (system prompts) — SKIP
 *   4. response_item message role=user (user prompt)
 *   5. turn_context (cwd)
 *   6. response_item message role=user (actual prompt)
 *   7. event_msg user_message
 *   8. event_msg token_count — SKIP
 *   9. response_item reasoning
 *   10. event_msg agent_message (phase=commentary|final_answer)
 *   11. response_item message role=assistant (phase=commentary|final_answer)
 *   12. [if tool use: response_item function_call → token_count → function_call_output → turn_context → repeat from 9]
 *   13. event_msg token_count — SKIP
 *   14. event_msg task_complete
 *
 * ### Interrupt (Ctrl+C / SIGINT)
 *   - response_item message role=user (text contains <turn_aborted>)
 *   - event_msg turn_aborted reason=interrupted
 *
 * ### Process death / stuck detection
 *   Codex uses a client-server architecture. Killing the CLI (SIGKILL)
 *   does NOT stop the server — the task continues and the file keeps
 *   growing. However, if the server itself crashes or the network
 *   connection is lost, the file stops growing while the last entry
 *   is mid-stream (function_call, reasoning, commentary, or token_count).
 *   Many historical sessions show this pattern — permanently stuck with
 *   no task_complete or turn_aborted.
 *   After STUCK_MS (15s) of no file growth while in a "running" state,
 *   we promote the status to "done".
 *
 * ### Permission prompt detection
 *   When Codex awaits tool approval (approval_policy != never), the last
 *   entry is a function_call and the file stops growing. After
 *   TOOL_USE_WAIT_MS (3s) we promote "running" → "waiting".
 *
 * ### Thread naming
 *   Thread names come from session_index.jsonl (preferred) or from
 *   the first user_message event_msg payload.message or first
 *   response_item message role=user with input_text content.
 *   System prompts (starting with <, { or # AGENTS.md) are excluded.
 *
 * ### Project directory
 *   Extracted from session_meta.payload.cwd (first entry, always present)
 *   or turn_context.payload.cwd (per-turn, always matches session_meta).
 */

import { watch, type FSWatcher } from "fs";
import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import { basename, join } from "path";
import type { AgentStatus } from "../../contracts/agent";
import type { AgentWatcher, AgentWatcherContext } from "../../contracts/agent-watcher";

// --- Types ---

interface CodexEntry {
  type?: string;
  // New format: response_item, event_msg, turn_context, session_meta, compacted
  payload?: {
    type?: string;
    role?: string;
    phase?: string;
    cwd?: string;
    message?: string;
    reason?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  // Old format: top-level message
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  // Old format: top-level function_call
  name?: string;
}

interface SessionSnapshot {
  status: AgentStatus;
  fileSize: number;
  projectDir?: string;
  threadName?: string;
  /** Timestamp when status first became "running" from a function_call entry */
  toolUseSeenAt?: number;
  /** Timestamp when the file was last observed to have grown (for stuck detection) */
  lastGrowthAt?: number;
}

const POLL_MS = 2000;
const STALE_MS = 5 * 60 * 1000;
const THREAD_NAME_MAX = 80;
/** How long to wait before promoting function_call "running" → "waiting" (permission prompt heuristic) */
const TOOL_USE_WAIT_MS = 3000;
/** How long a "running" session can go without file growth before we assume the process died */
const STUCK_MS = 15_000;

// --- Status detection ---

/**
 * Determine the agent status from a single JSONL entry.
 *
 * Returns the status implied by the entry, or `null` if the entry is
 * metadata/control that should not change the current status (token_count,
 * turn_context, session_meta, compacted, agent_reasoning, developer messages,
 * review mode, thread rollback, context compaction).
 */
export function determineStatus(entry: CodexEntry): AgentStatus | null {
  const t = entry.type;

  // --- New format: event_msg ---
  if (t === "event_msg") {
    const pt = entry.payload?.type;
    switch (pt) {
      case "task_complete":
        return "done";
      case "turn_aborted":
        return "interrupted";
      case "task_started":
      case "user_message":
        return "running";
      case "agent_message": {
        const phase = entry.payload?.phase;
        return phase === "final_answer" ? "done" : "running";
      }
      // Skip: token_count, agent_reasoning, entered/exited_review_mode,
      // thread_rolled_back, context_compacted
      default:
        return null;
    }
  }

  // --- New format: response_item ---
  if (t === "response_item") {
    const pt = entry.payload?.type;

    if (pt === "message") {
      const role = entry.payload?.role;
      // Developer messages are system prompts — skip
      if (role === "developer") return null;
      if (role === "user") return "running";
      if (role === "assistant") {
        const phase = entry.payload?.phase;
        return phase === "final_answer" ? "done" : "running";
      }
      return null;
    }

    // All tool/reasoning entries mean the agent is actively working
    if (
      pt === "function_call" || pt === "function_call_output" ||
      pt === "reasoning" ||
      pt === "custom_tool_call" || pt === "custom_tool_call_output" ||
      pt === "web_search_call"
    ) {
      return "running";
    }

    return null;
  }

  // --- Old format: top-level message ---
  if (t === "message") {
    if (entry.role === "user") return "running";
    if (entry.role === "assistant") return "running";
    return null;
  }

  // --- Old format: top-level function_call / function_call_output / reasoning ---
  if (t === "function_call" || t === "function_call_output" || t === "reasoning") {
    return "running";
  }

  // session_meta, turn_context, compacted, unknown → skip
  return null;
}

/** Returns true if the entry is a function_call that may need permission approval */
export function isToolCallEntry(entry: CodexEntry): boolean {
  if (entry.type === "response_item" && entry.payload?.type === "function_call") return true;
  if (entry.type === "function_call") return true;
  return false;
}

// --- Thread ID / name extraction ---

function parseThreadId(filePath: string): string {
  const name = basename(filePath, ".jsonl");
  return name.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)?.[0] ?? name;
}

function normalizeThreadName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, THREAD_NAME_MAX) : undefined;
}

function extractThreadName(entry: CodexEntry): string | undefined {
  // event_msg user_message has the cleanest prompt text
  if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
    const msg = entry.payload.message;
    if (!msg) return undefined;
    // Skip system/internal messages
    if (msg.startsWith("<codex reminder>") || msg.startsWith("<")) return undefined;
    return normalizeThreadName(msg);
  }

  // response_item message role=user with input_text content
  if (entry.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "user") {
    const content = entry.payload.content;
    if (!Array.isArray(content)) return undefined;
    const text = content
      .filter((item) => item?.type === "input_text")
      .map((item) => item.text ?? "")
      .join("\n");
    const candidate = normalizeThreadName(text);
    if (!candidate) return undefined;
    // Skip system/context injections
    if (
      candidate.startsWith("# AGENTS.md") ||
      candidate.startsWith("<environment_context>") ||
      candidate.startsWith("<codex reminder>") ||
      candidate.startsWith("<permissions ") ||
      candidate.startsWith("<app-context>") ||
      candidate.startsWith("<collaboration_mode>") ||
      candidate.startsWith("<turn_aborted>")
    ) return undefined;
    return candidate;
  }

  // Old format: top-level message role=user
  if (entry.type === "message" && entry.role === "user") {
    const content = entry.content;
    if (!Array.isArray(content)) return undefined;
    const text = content
      .filter((item) => item?.type === "input_text")
      .map((item) => item.text ?? "")
      .join("\n");
    const candidate = normalizeThreadName(text);
    if (!candidate) return undefined;
    if (candidate.startsWith("<") || candidate.startsWith("{") || candidate.startsWith("# AGENTS.md")) return undefined;
    return candidate;
  }

  return undefined;
}

// --- Project directory extraction ---

function extractProjectDir(entry: CodexEntry): string | undefined {
  if (entry.type === "session_meta" || entry.type === "turn_context") {
    const cwd = entry.payload?.cwd;
    return typeof cwd === "string" ? cwd : undefined;
  }
  return undefined;
}

// --- Entry processing ---

function applyEntries(text: string, base: SessionSnapshot, indexedThreadName?: string): SessionSnapshot {
  let status = base.status;
  let projectDir = base.projectDir;
  // Indexed thread name (from session_index.jsonl) takes priority over extracted name
  let threadName = indexedThreadName ?? base.threadName;
  let lastEntryIsToolCall = false;

  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim()) continue;

    let entry: CodexEntry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }

    if (!projectDir) {
      const dir = extractProjectDir(entry);
      if (dir) projectDir = dir;
    }

    // Only extract thread name from entries if we don't have an indexed name
    if (!threadName) {
      threadName = extractThreadName(entry);
    }

    const nextStatus = determineStatus(entry);
    if (nextStatus) {
      status = nextStatus;
      lastEntryIsToolCall = isToolCallEntry(entry);
    }
  }

  return {
    ...base, status, projectDir, threadName,
    toolUseSeenAt: lastEntryIsToolCall && status === "running" ? Date.now() : undefined,
    lastGrowthAt: (status === "running" || status === "waiting") ? Date.now() : undefined,
  };
}

// --- File collection ---

async function collectSessionFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSessionFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

// --- Watcher implementation ---

export class CodexAgentWatcher implements AgentWatcher {
  readonly name = "codex";

  private sessions = new Map<string, SessionSnapshot>();
  private threadNames = new Map<string, string>();
  private fsWatcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ctx: AgentWatcherContext | null = null;
  private sessionsDir: string;
  private sessionIndexFile: string;
  private scanning = false;
  private seeded = false;

  constructor() {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.sessionsDir = join(codexHome, "sessions");
    this.sessionIndexFile = join(codexHome, "session_index.jsonl");
  }

  start(ctx: AgentWatcherContext): void {
    this.ctx = ctx;
    this.setupWatch();
    setTimeout(() => this.scan(), 50);
    this.pollTimer = setInterval(() => this.scan(), POLL_MS);
  }

  stop(): void {
    if (this.fsWatcher) { try { this.fsWatcher.close(); } catch {} this.fsWatcher = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.ctx = null;
  }

  /** Emit a status change event if we have a valid session mapping */
  private emitStatus(threadId: string, snapshot: SessionSnapshot): void {
    if (!this.ctx || !this.seeded || !snapshot.projectDir) return;
    const session = this.ctx.resolveSession(snapshot.projectDir);
    if (!session) return;
    this.ctx.emit({
      agent: "codex",
      session,
      status: snapshot.status,
      ts: Date.now(),
      threadId,
      ...(snapshot.threadName && { threadName: snapshot.threadName }),
    });
  }

  private async loadThreadIndex(): Promise<void> {
    let text: string;
    try {
      text = await Bun.file(this.sessionIndexFile).text();
    } catch {
      return;
    }

    const names = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { id?: string; thread_name?: string };
        if (entry.id && entry.thread_name) {
          names.set(entry.id, entry.thread_name);
        }
      } catch {
      }
    }

    this.threadNames = names;
  }

  private async processFile(filePath: string): Promise<void> {
    if (!this.ctx) return;

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return;
    }

    const threadId = parseThreadId(filePath);
    const prev = this.sessions.get(threadId);

    // --- File unchanged ---
    if (prev && fileStat.size === prev.fileSize) {
      const now = Date.now();

      // Promote tool_use "running" → "waiting" (permission prompt heuristic)
      if (prev.status === "running" && prev.toolUseSeenAt && now - prev.toolUseSeenAt >= TOOL_USE_WAIT_MS) {
        prev.status = "waiting";
        prev.toolUseSeenAt = undefined;
        this.emitStatus(threadId, prev);
      }

      // Stuck detection: no file growth while running/waiting → assume process died
      if ((prev.status === "running" || prev.status === "waiting") && prev.lastGrowthAt && now - prev.lastGrowthAt >= STUCK_MS) {
        prev.status = "done";
        prev.toolUseSeenAt = undefined;
        prev.lastGrowthAt = undefined;
        this.emitStatus(threadId, prev);
      }

      return;
    }

    const indexedThreadName = this.threadNames.get(threadId);
    let nextSnapshot: SessionSnapshot;

    if (prev && fileStat.size > prev.fileSize) {
      // Incremental read: only new bytes
      let text: string;
      try {
        const buf = await Bun.file(filePath).arrayBuffer();
        text = new TextDecoder().decode(new Uint8Array(buf).subarray(prev.fileSize, fileStat.size));
      } catch {
        return;
      }

      nextSnapshot = applyEntries(text, { ...prev, fileSize: fileStat.size }, indexedThreadName);
    } else {
      // Full read: new file or size shrank (unlikely but defensive)
      let text: string;
      try {
        text = await Bun.file(filePath).text();
      } catch {
        return;
      }

      nextSnapshot = applyEntries(text, { status: "idle", fileSize: fileStat.size }, indexedThreadName);
    }

    this.sessions.set(threadId, nextSnapshot);

    if (!this.seeded) return;

    const prevStatus = prev?.status;
    if (nextSnapshot.status === prevStatus) return;

    if (!prev && nextSnapshot.status === "idle") return;

    this.emitStatus(threadId, nextSnapshot);
  }

  private async scan(): Promise<void> {
    if (this.scanning || !this.ctx) return;
    this.scanning = true;

    try {
      await this.loadThreadIndex();

      const files = await collectSessionFiles(this.sessionsDir);
      const now = Date.now();

      for (const filePath of files) {
        let fileStat;
        try {
          fileStat = await stat(filePath);
        } catch {
          continue;
        }

        if (now - fileStat.mtimeMs > STALE_MS) continue;
        await this.processFile(filePath);
      }
    } finally {
      if (!this.seeded) {
        this.seeded = true;
        // Emit seeded sessions with non-idle status
        // Apply indexed thread names that may not have been available during initial processFile
        for (const [threadId, snapshot] of this.sessions) {
          if (snapshot.status === "idle" || !snapshot.projectDir) continue;
          const indexedName = this.threadNames.get(threadId);
          if (indexedName) snapshot.threadName = indexedName;
          this.emitStatus(threadId, snapshot);
        }
      }
      this.scanning = false;
    }
  }

  private setupWatch(): void {
    try {
      this.fsWatcher = watch(this.sessionsDir, { recursive: true }, (_eventType, filename) => {
        if (!filename?.endsWith(".jsonl")) return;
        this.processFile(join(this.sessionsDir, filename));
      });
    } catch {
    }
  }
}
