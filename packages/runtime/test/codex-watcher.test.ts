import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CodexAgentWatcher, determineStatus, isToolCallEntry } from "../src/agents/watchers/codex";
import type { AgentEvent } from "../src/contracts/agent";
import type { AgentWatcherContext } from "../src/contracts/agent-watcher";

// --- determineStatus ---

describe("Codex determineStatus", () => {
  // event_msg entries
  test("returns running for user_message event", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "user_message" } })).toBe("running");
  });

  test("returns running for task_started event", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "task_started" } })).toBe("running");
  });

  test("returns running for agent_message with commentary phase", () => {
    expect(determineStatus({
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary" },
    })).toBe("running");
  });

  test("returns running for agent_message with no phase", () => {
    expect(determineStatus({
      type: "event_msg",
      payload: { type: "agent_message" },
    })).toBe("running");
  });

  test("returns done for agent_message with final_answer phase", () => {
    expect(determineStatus({
      type: "event_msg",
      payload: { type: "agent_message", phase: "final_answer" },
    })).toBe("done");
  });

  test("returns done for task_complete event", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "task_complete" } })).toBe("done");
  });

  test("returns interrupted for turn_aborted event", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "turn_aborted" } })).toBe("interrupted");
  });

  test("returns null for token_count event (skip)", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "token_count" } })).toBeNull();
  });

  test("returns null for agent_reasoning event (skip)", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "agent_reasoning" } })).toBeNull();
  });

  test("returns null for entered_review_mode event (skip)", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "entered_review_mode" } })).toBeNull();
  });

  test("returns null for exited_review_mode event (skip)", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "exited_review_mode" } })).toBeNull();
  });

  test("returns null for thread_rolled_back event (skip)", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "thread_rolled_back" } })).toBeNull();
  });

  test("returns null for context_compacted event (skip)", () => {
    expect(determineStatus({ type: "event_msg", payload: { type: "context_compacted" } })).toBeNull();
  });

  // response_item entries
  test("returns running for response_item user message", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "message", role: "user" },
    })).toBe("running");
  });

  test("returns running for response_item assistant message with commentary", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "message", role: "assistant", phase: "commentary" },
    })).toBe("running");
  });

  test("returns done for response_item assistant message with final_answer", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "message", role: "assistant", phase: "final_answer" },
    })).toBe("done");
  });

  test("returns running for response_item assistant message with no phase", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "message", role: "assistant" },
    })).toBe("running");
  });

  test("returns null for response_item developer message (skip)", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "message", role: "developer" },
    })).toBeNull();
  });

  test("returns running for response_item function_call", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "function_call" },
    })).toBe("running");
  });

  test("returns running for response_item function_call_output", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "function_call_output" },
    })).toBe("running");
  });

  test("returns running for response_item reasoning", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "reasoning" },
    })).toBe("running");
  });

  test("returns running for response_item custom_tool_call", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "custom_tool_call" },
    })).toBe("running");
  });

  test("returns running for response_item custom_tool_call_output", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "custom_tool_call_output" },
    })).toBe("running");
  });

  test("returns running for response_item web_search_call", () => {
    expect(determineStatus({
      type: "response_item",
      payload: { type: "web_search_call" },
    })).toBe("running");
  });

  // Old format entries
  test("returns running for old format user message", () => {
    expect(determineStatus({ type: "message", role: "user" })).toBe("running");
  });

  test("returns running for old format assistant message", () => {
    expect(determineStatus({ type: "message", role: "assistant" })).toBe("running");
  });

  test("returns running for old format function_call", () => {
    expect(determineStatus({ type: "function_call", name: "shell" })).toBe("running");
  });

  test("returns running for old format function_call_output", () => {
    expect(determineStatus({ type: "function_call_output" })).toBe("running");
  });

  test("returns running for old format reasoning", () => {
    expect(determineStatus({ type: "reasoning" })).toBe("running");
  });

  // Control entries that should skip
  test("returns null for session_meta (skip)", () => {
    expect(determineStatus({ type: "session_meta", payload: { cwd: "/foo" } })).toBeNull();
  });

  test("returns null for turn_context (skip)", () => {
    expect(determineStatus({ type: "turn_context", payload: { cwd: "/foo" } })).toBeNull();
  });

  test("returns null for compacted (skip)", () => {
    expect(determineStatus({ type: "compacted" })).toBeNull();
  });

  test("returns null for empty object", () => {
    expect(determineStatus({})).toBeNull();
  });
});

// --- isToolCallEntry ---

describe("Codex isToolCallEntry", () => {
  test("returns true for response_item function_call", () => {
    expect(isToolCallEntry({
      type: "response_item",
      payload: { type: "function_call" },
    })).toBe(true);
  });

  test("returns true for old format function_call", () => {
    expect(isToolCallEntry({ type: "function_call", name: "shell" })).toBe(true);
  });

  test("returns false for function_call_output", () => {
    expect(isToolCallEntry({
      type: "response_item",
      payload: { type: "function_call_output" },
    })).toBe(false);
  });

  test("returns false for reasoning", () => {
    expect(isToolCallEntry({
      type: "response_item",
      payload: { type: "reasoning" },
    })).toBe(false);
  });

  test("returns false for user message", () => {
    expect(isToolCallEntry({
      type: "response_item",
      payload: { type: "message", role: "user" },
    })).toBe(false);
  });

  test("returns false for empty entry", () => {
    expect(isToolCallEntry({})).toBe(false);
  });
});

// --- CodexAgentWatcher integration ---

describe("CodexAgentWatcher", () => {
  let tmpDir: string;
  let watcher: CodexAgentWatcher;
  let events: AgentEvent[];
  let ctx: AgentWatcherContext;
  let sessionFile: string;
  const threadId = "019d2e1e-c764-773e-8e63-894331c70b6b";

  beforeEach(() => {
    tmpDir = join(tmpdir(), `codex-watcher-test-${Date.now()}`);
    const sessionsDayDir = join(tmpDir, "sessions", "2026", "03", "27");
    mkdirSync(sessionsDayDir, { recursive: true });

    sessionFile = join(sessionsDayDir, `rollout-2026-03-27T12-00-00-${threadId}.jsonl`);
    writeFileSync(sessionFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/myapp" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions>" }] } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the auth bug" }] } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Fix the auth bug" } }) + "\n",
    );

    writeFileSync(join(tmpDir, "session_index.jsonl"),
      JSON.stringify({ id: threadId, thread_name: "Fix auth bug", updated_at: "2026-03-27T12:00:00.000Z" }) + "\n",
    );

    events = [];
    ctx = {
      resolveSession: (dir) => dir === "/projects/myapp" ? "myapp-session" : null,
      emit: (event) => events.push(event),
    };

    watcher = new CodexAgentWatcher();
    (watcher as any).sessionsDir = join(tmpDir, "sessions");
    (watcher as any).sessionIndexFile = join(tmpDir, "session_index.jsonl");
  });

  afterEach(() => {
    watcher.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("seed scan emits events for non-idle sessions", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(events).toHaveLength(1);
    expect(events[0]!.agent).toBe("codex");
    expect(events[0]!.status).toBe("running");
    expect(events[0]!.session).toBe("myapp-session");
    expect(events[0]!.threadName).toBe("Fix auth bug");
  });

  test("emits done when Codex writes a final answer", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seedCount = events.length;

    appendFileSync(sessionFile,
      JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer" } }) + "\n" +
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Fixed it." }] },
      }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const postSeed = events.slice(seedCount);
    expect(postSeed.length).toBeGreaterThanOrEqual(1);
    const last = postSeed[postSeed.length - 1]!;
    expect(last.agent).toBe("codex");
    expect(last.session).toBe("myapp-session");
    expect(last.status).toBe("done");
    expect(last.threadId).toBe(threadId);
    expect(last.threadName).toBe("Fix auth bug");
  });

  test("emits interrupted for turn_aborted", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seedCount = events.length;

    appendFileSync(sessionFile,
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>" }] } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const postSeed = events.slice(seedCount);
    expect(postSeed.length).toBeGreaterThanOrEqual(1);
    const last = postSeed[postSeed.length - 1]!;
    expect(last.status).toBe("interrupted");
  });

  test("skips token_count and agent_reasoning without changing status", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seedCount = events.length;

    // Append only control entries — should not change running status
    appendFileSync(sessionFile,
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "agent_reasoning" } }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    // No new events should fire (status stayed "running")
    const postSeed = events.slice(seedCount);
    expect(postSeed.length).toBe(0);
  });

  test("skips developer messages without changing status", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seedCount = events.length;

    appendFileSync(sessionFile,
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions>" }] } }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const postSeed = events.slice(seedCount);
    expect(postSeed.length).toBe(0);
  });

  test("keeps running through tool use cycle", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seedCount = events.length;

    // Simulate: reasoning → commentary → function_call → token_count → function_call_output → turn_context
    appendFileSync(sessionFile,
      JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "commentary" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "function_call" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output" } }) + "\n" +
      JSON.stringify({ type: "turn_context", payload: { cwd: "/projects/myapp" } }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Status stayed "running" throughout — no done events
    const postSeed = events.slice(seedCount);
    const doneEvents = postSeed.filter((e) => e.status === "done");
    expect(doneEvents.length).toBe(0);

    const interruptedEvents = postSeed.filter((e) => e.status === "interrupted");
    expect(interruptedEvents.length).toBe(0);
  });

  test("detects stuck running and promotes to done (process death)", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seedCount = events.length;

    // Backdate lastGrowthAt to simulate process killed 16s ago
    const snapshot = (watcher as any).sessions.get(threadId);
    snapshot.lastGrowthAt = Date.now() - 16_000;

    // Wait for next poll cycle to detect stuck
    await new Promise((r) => setTimeout(r, 2500));

    const doneEvents = events.slice(seedCount).filter((e) => e.status === "done");
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
  }, 10_000);

  test("promotes tool_use running to waiting after timeout", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seedCount = events.length;

    // Append a function_call (tool invocation)
    appendFileSync(sessionFile,
      JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "function_call" } }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Should still be running
    const runningCount = events.slice(seedCount).filter((e) => e.status === "running").length;

    // Wait for the promotion threshold (TOOL_USE_WAIT_MS = 3s) + poll cycles
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const waitingEvents = events.slice(seedCount).filter((e) => e.status === "waiting");
    expect(waitingEvents.length).toBeGreaterThanOrEqual(1);
    expect(waitingEvents[0]!.agent).toBe("codex");
    expect(waitingEvents[0]!.session).toBe("myapp-session");
  }, 10_000);

  test("extracts project dir from session_meta", async () => {
    const sessionsDayDir = join(tmpDir, "sessions", "2026", "03", "28");
    mkdirSync(sessionsDayDir, { recursive: true });
    const newThreadId = "019d3333-aaaa-bbbb-cccc-000000000001";
    const newFile = join(sessionsDayDir, `rollout-2026-03-28T10-00-00-${newThreadId}.jsonl`);

    writeFileSync(newFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/myapp" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Test prompt" } }) + "\n",
    );

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const event = events.find((e) => e.threadId === newThreadId);
    expect(event).toBeDefined();
    expect(event!.session).toBe("myapp-session");
    expect(event!.status).toBe("running");
  });

  test("extracts project dir from turn_context when session_meta missing", async () => {
    const sessionsDayDir = join(tmpDir, "sessions", "2026", "03", "28");
    mkdirSync(sessionsDayDir, { recursive: true });
    const newThreadId = "019d3333-aaaa-bbbb-cccc-000000000002";
    const newFile = join(sessionsDayDir, `rollout-2026-03-28T10-00-00-${newThreadId}.jsonl`);

    writeFileSync(newFile,
      JSON.stringify({ type: "turn_context", payload: { cwd: "/projects/myapp" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Test prompt" } }) + "\n",
    );

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const event = events.find((e) => e.threadId === newThreadId);
    expect(event).toBeDefined();
    expect(event!.session).toBe("myapp-session");
  });

  test("does not emit for idle threads", async () => {
    const sessionsDayDir = join(tmpDir, "sessions", "2026", "03", "28");
    mkdirSync(sessionsDayDir, { recursive: true });
    const newThreadId = "019d3333-aaaa-bbbb-cccc-000000000003";
    const newFile = join(sessionsDayDir, `rollout-2026-03-28T10-00-00-${newThreadId}.jsonl`);

    // Only metadata — no status-changing entries
    writeFileSync(newFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/myapp" } }) + "\n",
    );

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const event = events.find((e) => e.threadId === newThreadId);
    expect(event).toBeUndefined();
  });

  test("does not emit when session cannot be resolved", async () => {
    const sessionsDayDir = join(tmpDir, "sessions", "2026", "03", "28");
    mkdirSync(sessionsDayDir, { recursive: true });
    const newThreadId = "019d3333-aaaa-bbbb-cccc-000000000004";
    const newFile = join(sessionsDayDir, `rollout-2026-03-28T10-00-00-${newThreadId}.jsonl`);

    writeFileSync(newFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/unknown/dir" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } }) + "\n",
    );

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const event = events.find((e) => e.threadId === newThreadId);
    expect(event).toBeUndefined();
  });

  test("uses session_index thread name over extracted name", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The session_index has "Fix auth bug" while the user message says "Fix the auth bug"
    const event = events.find((e) => e.threadId === threadId);
    expect(event).toBeDefined();
    expect(event!.threadName).toBe("Fix auth bug");
  });

  test("extracts thread name from user_message when not in index", async () => {
    const sessionsDayDir = join(tmpDir, "sessions", "2026", "03", "28");
    mkdirSync(sessionsDayDir, { recursive: true });
    const newThreadId = "019d3333-aaaa-bbbb-cccc-000000000005";
    const newFile = join(sessionsDayDir, `rollout-2026-03-28T10-00-00-${newThreadId}.jsonl`);

    writeFileSync(newFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/myapp" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Refactor the database layer" } }) + "\n",
    );

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const event = events.find((e) => e.threadId === newThreadId);
    expect(event).toBeDefined();
    expect(event!.threadName).toBe("Refactor the database layer");
  });

  test("skips codex reminder messages for thread name", async () => {
    const sessionsDayDir = join(tmpDir, "sessions", "2026", "03", "28");
    mkdirSync(sessionsDayDir, { recursive: true });
    const newThreadId = "019d3333-aaaa-bbbb-cccc-000000000006";
    const newFile = join(sessionsDayDir, `rollout-2026-03-28T10-00-00-${newThreadId}.jsonl`);

    writeFileSync(newFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/myapp" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "<codex reminder>You are in text only mode." } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "The real prompt" } }) + "\n",
    );

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const event = events.find((e) => e.threadId === newThreadId);
    expect(event).toBeDefined();
    expect(event!.threadName).toBe("The real prompt");
  });

  test("full lifecycle: simple text response", async () => {
    // Rewrite the seed file to be the full lifecycle test
    writeFileSync(sessionFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/myapp" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "What is 2+2?" }] } }) + "\n" +
      JSON.stringify({ type: "turn_context", payload: { cwd: "/projects/myapp" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "What is 2+2?" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) + "\n",
    );

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Seed should emit 1 event (running from user_message)
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]!.status).toBe("running");
    const seedCount = events.length;

    // Phase 2: Model responds with final answer
    appendFileSync(sessionFile,
      JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const postSeed = events.slice(seedCount);
    expect(postSeed.length).toBeGreaterThanOrEqual(1);
    expect(postSeed[postSeed.length - 1]!.status).toBe("done");
  });

  test("full lifecycle: tool use then final answer", async () => {
    // Rewrite the seed file for this test
    writeFileSync(sessionFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/myapp" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Read /etc/hosts" }] } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Read /etc/hosts" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) + "\n",
    );

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seedCount = events.length;

    // Phase 2: Reasoning + commentary + tool call
    appendFileSync(sessionFile,
      JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "commentary" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "function_call" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output" } }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Should still be running — no done events
    const midEvents = events.slice(seedCount);
    expect(midEvents.filter((e) => e.status === "done").length).toBe(0);

    // Phase 3: Final answer
    appendFileSync(sessionFile,
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const finalEvents = events.slice(seedCount);
    const doneEvents = finalEvents.filter((e) => e.status === "done");
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});
