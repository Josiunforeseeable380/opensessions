/**
 * opensessions watcher for Amp
 *
 * Watches ~/.local/share/amp/threads/ for JSON file changes and reports
 * agent status to the opensessions server.
 *
 * Run:
 *   bun run integrations/amp/watcher.ts
 *
 * Status mapping (from thread JSON last message):
 *   user message (no state)                          → running
 *   assistant + state.type missing                   → running  (streaming)
 *   assistant + state.type:"complete" + tool_use     → running
 *   assistant + state.type:"complete" + end_turn     → done
 *   assistant + state.type:"cancelled"               → interrupted
 */

import { appendFileSync, readdirSync, readFileSync, statSync, watch } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const SERVER_URL = process.env.OPENSESSIONS_URL ?? "http://127.0.0.1:7391/event";
const EVENTS_FILE = process.env.OPENSESSIONS_EVENTS_FILE ?? "/tmp/opensessions-events.jsonl";
const THREADS_DIR = join(homedir(), ".local", "share", "amp", "threads");
const POLL_MS = 2000;
const STALE_MS = 5 * 60 * 1000;

// -- Types ------------------------------------------------------------------

type AgentStatus = "idle" | "running" | "done" | "error" | "waiting" | "interrupted";

interface MessageState {
  type?: "complete" | "cancelled";
  stopReason?: "end_turn" | "tool_use";
}

interface Message {
  role?: string;
  messageId?: number;
  state?: MessageState;
}

interface ThreadFile {
  id?: string;
  title?: string;
  v?: number;
  messages?: Message[];
}

interface ThreadState {
  status: AgentStatus;
  version: number;
  title?: string;
}

// -- State ------------------------------------------------------------------

const threads = new Map<string, ThreadState>();
const sessionName = getSessionName();

// -- Helpers ----------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[amp-watcher] ${msg}\n`);
}

function getSessionName(): string {
  if (process.env.TMUX) {
    try {
      const result = Bun.spawnSync(["tmux", "display-message", "-p", "#S"]);
      const name = result.stdout.toString().trim();
      if (name) return name;
    } catch {}
  }
  if (process.env.ZELLIJ_SESSION_NAME) return process.env.ZELLIJ_SESSION_NAME;
  return "unknown";
}

function determineStatus(lastMsg: Message | null): AgentStatus {
  if (!lastMsg?.role) return "idle";

  if (lastMsg.role === "user") return "running";

  if (lastMsg.role === "assistant") {
    if (!lastMsg.state) return "running";
    if (lastMsg.state.type === "cancelled") return "interrupted";
    if (lastMsg.state.type === "complete") {
      if (lastMsg.state.stopReason === "tool_use") return "running";
      if (lastMsg.state.stopReason === "end_turn") return "done";
    }
    return "waiting";
  }

  return "idle";
}

async function writeEvent(status: AgentStatus, threadId?: string, threadName?: string): Promise<void> {
  const payload = JSON.stringify({
    agent: "amp",
    session: sessionName,
    status,
    ts: Date.now(),
    ...(threadId && { threadId }),
    ...(threadName && { threadName }),
  });

  try {
    await fetch(SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  } catch {
    try { appendFileSync(EVENTS_FILE, payload + "\n"); } catch {}
  }
}

// -- Thread file processing -------------------------------------------------

function processThread(filePath: string): void {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return;
  }

  const threadId = basename(filePath, ".json");
  const prev = threads.get(threadId);

  // Read the thread JSON — only the fields we need
  let thread: ThreadFile;
  try {
    const raw = readFileSync(filePath, "utf-8");
    thread = JSON.parse(raw);
  } catch {
    return;
  }

  const version = thread.v ?? 0;
  if (prev && version === prev.version) return;

  const messages = thread.messages ?? [];
  const lastMsg = messages.length > 0 ? messages[messages.length - 1]! : null;
  const status = determineStatus(lastMsg);
  const title = thread.title || undefined;

  const prevStatus = prev?.status;
  threads.set(threadId, { status, version, title });

  if (status !== prevStatus) {
    log(`${threadId}: ${prevStatus ?? "new"} → ${status}${title ? ` (${title})` : ""}`);
    writeEvent(status, threadId, title);
  }
}

// -- Scanning ---------------------------------------------------------------

function scanThreads(): void {
  let files: string[];
  try {
    files = readdirSync(THREADS_DIR);
  } catch {
    return;
  }

  const now = Date.now();

  for (const file of files) {
    if (!file.startsWith("T-") || !file.endsWith(".json")) continue;

    const filePath = join(THREADS_DIR, file);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }

    // Skip files not modified recently (avoid scanning thousands of old threads)
    if (now - stat.mtimeMs > STALE_MS) continue;

    processThread(filePath);
  }
}

// -- Watcher ----------------------------------------------------------------

let watcher: ReturnType<typeof watch> | null = null;

function setupWatcher(): void {
  try {
    watcher = watch(THREADS_DIR, (_eventType, filename) => {
      if (!filename?.startsWith("T-") || !filename.endsWith(".json")) return;
      processThread(join(THREADS_DIR, filename));
    });
  } catch {
    log(`Cannot watch ${THREADS_DIR}, falling back to polling only`);
  }
}

// -- Main -------------------------------------------------------------------

function shutdown(): void {
  log("Shutting down");
  try { watcher?.close(); } catch {}
  clearInterval(pollInterval);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`Watching ${THREADS_DIR}`);
log(`Session: ${sessionName}`);
log(`Server: ${SERVER_URL}`);

scanThreads();
setupWatcher();
const pollInterval = setInterval(scanThreads, POLL_MS);
