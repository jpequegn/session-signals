import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";

function jsonl(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => JSON.stringify(o)).join("\n");
}

const SESSION_ID = "sess-abc-123";

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    hook_event_type: "PreToolUse",
    timestamp: "2026-02-05T10:00:00.000Z",
    source_app: "claude-code",
    payload: { tool_name: "Edit", tool_input: { file_path: "/foo/bar.ts" } },
    ...overrides,
  };
}

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter({
    eventsDir: "/nonexistent",
    warn: () => {},
  });

  describe("getEventSource", () => {
    it("returns claude_code", () => {
      expect(adapter.getEventSource()).toBe("claude_code");
    });
  });

  describe("parseEvents", () => {
    it("parses a PreToolUse event into tool_use", () => {
      const raw = jsonl(makeEvent());
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("tool_use");
      expect(events[0]!.harness).toBe("claude_code");
      expect(events[0]!.session_id).toBe(SESSION_ID);
      expect(events[0]!.tool_name).toBe("file_edit");
    });

    it("parses a PostToolUse event into tool_result", () => {
      const raw = jsonl(makeEvent({
        hook_event_type: "PostToolUse",
        payload: { tool_name: "Bash", tool_result: { success: true, output: "hello" } },
      }));
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("tool_result");
      expect(events[0]!.tool_name).toBe("shell_exec");
      expect(events[0]!.tool_result?.success).toBe(true);
      expect(events[0]!.tool_result?.output).toBe("hello");
    });

    it("parses a PostToolUse error event", () => {
      const raw = jsonl(makeEvent({
        hook_event_type: "PostToolUse",
        payload: { tool_name: "Bash", error: "command failed" },
      }));
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(1);
      expect(events[0]!.tool_result?.success).toBe(false);
      expect(events[0]!.tool_result?.error).toBe("command failed");
    });

    it("parses a UserPromptSubmit event", () => {
      const raw = jsonl(makeEvent({
        hook_event_type: "UserPromptSubmit",
        payload: { message: "fix the bug" },
      }));
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("user_prompt");
      expect(events[0]!.message).toBe("fix the bug");
    });

    it("parses SessionStart and SessionEnd events", () => {
      const raw = jsonl(
        makeEvent({ hook_event_type: "SessionStart", payload: { cwd: "/home/user/project" } }),
        makeEvent({ hook_event_type: "SessionEnd", payload: {} }),
      );
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe("session_start");
      expect(events[0]!.cwd).toBe("/home/user/project");
      expect(events[1]!.type).toBe("session_end");
    });

    it("parses Stop event as session_end", () => {
      const raw = jsonl(makeEvent({ hook_event_type: "Stop", payload: {} }));
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("session_end");
    });

    it("parses SubagentStop event as session_end", () => {
      const raw = jsonl(makeEvent({ hook_event_type: "SubagentStop", payload: {} }));
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("session_end");
    });

    it("parses compaction Notification", () => {
      const raw = jsonl(makeEvent({
        hook_event_type: "Notification",
        payload: { type: "compaction" },
      }));
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("compaction");
    });

    it("skips non-compaction Notification events", () => {
      const raw = jsonl(makeEvent({
        hook_event_type: "Notification",
        payload: { type: "info", message: "something" },
      }));
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(0);
    });

    // ── Tool name mapping ─────────────────────────────────

    it("maps Edit to file_edit", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "Edit" } })));
      expect(events[0]!.tool_name).toBe("file_edit");
    });

    it("maps MultiEdit to file_edit", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "MultiEdit" } })));
      expect(events[0]!.tool_name).toBe("file_edit");
    });

    it("maps Write to file_write", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "Write" } })));
      expect(events[0]!.tool_name).toBe("file_write");
    });

    it("maps Read to file_read", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "Read" } })));
      expect(events[0]!.tool_name).toBe("file_read");
    });

    it("maps Bash to shell_exec", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "Bash" } })));
      expect(events[0]!.tool_name).toBe("shell_exec");
    });

    it("maps Grep to file_search", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "Grep" } })));
      expect(events[0]!.tool_name).toBe("file_search");
    });

    it("maps Glob to file_search", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "Glob" } })));
      expect(events[0]!.tool_name).toBe("file_search");
    });

    it("maps Task to agent_spawn", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "Task" } })));
      expect(events[0]!.tool_name).toBe("agent_spawn");
    });

    it("maps WebSearch to web_access", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "WebSearch" } })));
      expect(events[0]!.tool_name).toBe("web_access");
    });

    it("maps WebFetch to web_access", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "WebFetch" } })));
      expect(events[0]!.tool_name).toBe("web_access");
    });

    it("maps NotebookEdit to file_edit", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "NotebookEdit" } })));
      expect(events[0]!.tool_name).toBe("file_edit");
    });

    it("maps NotebookRead to file_read", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "NotebookRead" } })));
      expect(events[0]!.tool_name).toBe("file_read");
    });

    it("maps LSP to lsp", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "LSP" } })));
      expect(events[0]!.tool_name).toBe("lsp");
    });

    it("maps AskUserQuestion to user_interaction", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "AskUserQuestion" } })));
      expect(events[0]!.tool_name).toBe("user_interaction");
    });

    it("maps Skill to skill", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "Skill" } })));
      expect(events[0]!.tool_name).toBe("skill");
    });

    it("lowercases unknown tool names", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({ payload: { tool_name: "CustomTool" } })));
      expect(events[0]!.tool_name).toBe("customtool");
    });

    // ── Malformed input handling ──────────────────────────

    it("skips malformed JSON lines", () => {
      const warnings: string[] = [];
      const warnAdapter = new ClaudeCodeAdapter({
        eventsDir: "/nonexistent",
        warn: (msg) => warnings.push(msg),
      });

      const raw = `{bad json\n${JSON.stringify(makeEvent())}`;
      const events = warnAdapter.parseEvents(raw);
      expect(events).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("malformed JSONL");
    });

    it("skips events with missing required fields", () => {
      const warnings: string[] = [];
      const warnAdapter = new ClaudeCodeAdapter({
        eventsDir: "/nonexistent",
        warn: (msg) => warnings.push(msg),
      });

      const raw = jsonl(
        { timestamp: "2026-01-01T00:00:00Z" }, // missing session_id and hook_event_type
        makeEvent(),
      );
      const events = warnAdapter.parseEvents(raw);
      expect(events).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("invalid event");
    });

    it("skips empty lines", () => {
      const raw = `\n\n${JSON.stringify(makeEvent())}\n\n`;
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(1);
    });

    // ── Multiple events in a session ──────────────────────

    it("parses a full session flow", () => {
      const raw = jsonl(
        makeEvent({ hook_event_type: "SessionStart", timestamp: "2026-02-05T10:00:00.000Z", payload: { cwd: "/project" } }),
        makeEvent({ hook_event_type: "UserPromptSubmit", timestamp: "2026-02-05T10:00:01.000Z", payload: { message: "help me" } }),
        makeEvent({ hook_event_type: "PreToolUse", timestamp: "2026-02-05T10:00:02.000Z", payload: { tool_name: "Read", tool_input: { file_path: "/project/src/main.ts" } } }),
        makeEvent({ hook_event_type: "PostToolUse", timestamp: "2026-02-05T10:00:03.000Z", payload: { tool_name: "Read", tool_result: { success: true, output: "contents" } } }),
        makeEvent({ hook_event_type: "PreToolUse", timestamp: "2026-02-05T10:00:04.000Z", payload: { tool_name: "Edit", tool_input: { file_path: "/project/src/main.ts" } } }),
        makeEvent({ hook_event_type: "PostToolUse", timestamp: "2026-02-05T10:00:05.000Z", payload: { tool_name: "Edit", tool_result: { success: true } } }),
        makeEvent({ hook_event_type: "SessionEnd", timestamp: "2026-02-05T10:00:06.000Z", payload: {} }),
      );
      const events = adapter.parseEvents(raw);
      expect(events).toHaveLength(7);
      expect(events[0]!.type).toBe("session_start");
      expect(events[1]!.type).toBe("user_prompt");
      expect(events[2]!.type).toBe("tool_use");
      expect(events[2]!.tool_name).toBe("file_read");
      expect(events[3]!.type).toBe("tool_result");
      expect(events[4]!.type).toBe("tool_use");
      expect(events[4]!.tool_name).toBe("file_edit");
      expect(events[5]!.type).toBe("tool_result");
      expect(events[6]!.type).toBe("session_end");
    });

    // ── Metadata preservation ─────────────────────────────

    it("preserves metadata with hook_event_type and source_app", () => {
      const events = adapter.parseEvents(jsonl(makeEvent()));
      expect(events[0]!.metadata).toEqual({
        hook_event_type: "PreToolUse",
        source_app: "claude-code",
      });
    });

    // ── Alternative payload field names ────────────────────

    it("extracts tool name from payload.name fallback", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({
        payload: { name: "Bash" },
      })));
      expect(events[0]!.tool_name).toBe("shell_exec");
    });

    it("extracts message from payload.prompt fallback", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({
        hook_event_type: "UserPromptSubmit",
        payload: { prompt: "do something" },
      })));
      expect(events[0]!.message).toBe("do something");
    });

    it("extracts tool_input from payload.input fallback", () => {
      const events = adapter.parseEvents(jsonl(makeEvent({
        payload: { tool_name: "Edit", input: { file_path: "/a/b.ts" } },
      })));
      expect(events[0]!.tool_input).toEqual({ file_path: "/a/b.ts" });
    });
  });

  describe("getSessionEvents", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "cc-adapter-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("returns empty array when events dir does not exist", async () => {
      const events = await adapter.getSessionEvents("nonexistent-session");
      expect(events).toEqual([]);
    });

    it("reads and filters events by session ID", async () => {
      const monthDir = join(tmpDir, "2026-02");
      await mkdir(monthDir, { recursive: true });

      const content = jsonl(
        makeEvent({ session_id: "target-session", timestamp: "2026-02-05T10:00:00.000Z" }),
        makeEvent({ session_id: "other-session", timestamp: "2026-02-05T10:00:01.000Z" }),
        makeEvent({ session_id: "target-session", timestamp: "2026-02-05T10:00:02.000Z" }),
      );
      await writeFile(join(monthDir, "abc_all-events.jsonl"), content);

      const tmpAdapter = new ClaudeCodeAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("target-session");
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.session_id === "target-session")).toBe(true);
    });

    it("returns events sorted chronologically", async () => {
      const monthDir = join(tmpDir, "2026-02");
      await mkdir(monthDir, { recursive: true });

      const content = jsonl(
        makeEvent({ session_id: "s1", timestamp: "2026-02-05T10:00:03.000Z" }),
        makeEvent({ session_id: "s1", timestamp: "2026-02-05T10:00:01.000Z" }),
        makeEvent({ session_id: "s1", timestamp: "2026-02-05T10:00:02.000Z" }),
      );
      await writeFile(join(monthDir, "abc_all-events.jsonl"), content);

      const tmpAdapter = new ClaudeCodeAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("s1");
      expect(events).toHaveLength(3);
      expect(events[0]!.timestamp).toBe("2026-02-05T10:00:01.000Z");
      expect(events[1]!.timestamp).toBe("2026-02-05T10:00:02.000Z");
      expect(events[2]!.timestamp).toBe("2026-02-05T10:00:03.000Z");
    });

    it("reads events across multiple files and month directories", async () => {
      const month1 = join(tmpDir, "2026-01");
      const month2 = join(tmpDir, "2026-02");
      await mkdir(month1, { recursive: true });
      await mkdir(month2, { recursive: true });

      await writeFile(
        join(month1, "file1_all-events.jsonl"),
        jsonl(makeEvent({ session_id: "s1", timestamp: "2026-01-15T10:00:00.000Z" })),
      );
      await writeFile(
        join(month2, "file2_all-events.jsonl"),
        jsonl(makeEvent({ session_id: "s1", timestamp: "2026-02-05T10:00:00.000Z" })),
      );

      const tmpAdapter = new ClaudeCodeAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("s1");
      expect(events).toHaveLength(2);
      expect(events[0]!.timestamp).toBe("2026-01-15T10:00:00.000Z");
      expect(events[1]!.timestamp).toBe("2026-02-05T10:00:00.000Z");
    });

    it("skips malformed lines in JSONL files and still returns valid events", async () => {
      const monthDir = join(tmpDir, "2026-02");
      await mkdir(monthDir, { recursive: true });

      const content = `{bad json\n${JSON.stringify(makeEvent({ session_id: "s1", timestamp: "2026-02-05T10:00:00.000Z" }))}`;
      await writeFile(join(monthDir, "mixed_all-events.jsonl"), content);

      const warnings: string[] = [];
      const tmpAdapter = new ClaudeCodeAdapter({
        eventsDir: tmpDir,
        warn: (msg) => warnings.push(msg),
      });
      const events = await tmpAdapter.getSessionEvents("s1");
      expect(events).toHaveLength(1);
      expect(warnings.some((w) => w.includes("malformed JSONL"))).toBe(true);
    });
  });
});
