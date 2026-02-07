import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiCodingAgentAdapter } from "../src/adapters/pi-coding-agent.js";

function jsonl(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => JSON.stringify(o)).join("\n");
}

function userMessage(id: string, parentId: string | null, content: string, ts?: string): Record<string, unknown> {
  return { type: "message", id, parentId, timestamp: ts ?? "2026-02-05T10:00:00.000Z", role: "user", content };
}

function assistantToolCall(id: string, parentId: string, toolName: string, toolInput: Record<string, unknown> = {}, ts?: string): Record<string, unknown> {
  return { type: "message", id, parentId, timestamp: ts ?? "2026-02-05T10:00:01.000Z", role: "assistant", toolName, toolInput };
}

function toolResult(id: string, parentId: string, toolName: string, content: string, ts?: string): Record<string, unknown> {
  return { type: "message", id, parentId, timestamp: ts ?? "2026-02-05T10:00:02.000Z", role: "user", toolName, content };
}

function toolResultError(id: string, parentId: string, toolName: string, error: string, ts?: string): Record<string, unknown> {
  return { type: "message", id, parentId, timestamp: ts ?? "2026-02-05T10:00:02.000Z", role: "user", toolName, toolResult: { error } };
}

describe("PiCodingAgentAdapter", () => {
  const adapter = new PiCodingAgentAdapter({
    eventsDir: "/nonexistent",
    warn: () => {},
  });

  describe("getEventSource", () => {
    it("returns pi_coding_agent", () => {
      expect(adapter.getEventSource()).toBe("pi_coding_agent");
    });
  });

  describe("parseEvents", () => {
    it("parses user message as user_prompt", () => {
      const raw = jsonl(userMessage("1", null, "fix the bug"));
      const events = adapter.parseEvents(raw, "sess-1");
      const prompts = events.filter((e) => e.type === "user_prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.message).toBe("fix the bug");
      expect(prompts[0]!.harness).toBe("pi_coding_agent");
      expect(prompts[0]!.session_id).toBe("sess-1");
    });

    it("synthesizes session_start and session_end", () => {
      const raw = jsonl(userMessage("1", null, "hello"));
      const events = adapter.parseEvents(raw, "sess-1");
      expect(events[0]!.type).toBe("session_start");
      expect(events[events.length - 1]!.type).toBe("session_end");
    });

    it("parses assistant tool call as tool_use", () => {
      const raw = jsonl(
        userMessage("1", null, "read main.ts"),
        assistantToolCall("2", "1", "read", { path: "/src/main.ts" }),
      );
      const events = adapter.parseEvents(raw, "sess-1");
      const toolUse = events.filter((e) => e.type === "tool_use");
      expect(toolUse).toHaveLength(1);
      expect(toolUse[0]!.tool_name).toBe("file_read");
      expect(toolUse[0]!.tool_input).toEqual({ path: "/src/main.ts" });
    });

    it("parses tool result as tool_result", () => {
      const raw = jsonl(
        userMessage("1", null, "read it"),
        assistantToolCall("2", "1", "read"),
        toolResult("3", "2", "read", "file contents here"),
      );
      const events = adapter.parseEvents(raw, "sess-1");
      const results = events.filter((e) => e.type === "tool_result");
      expect(results).toHaveLength(1);
      expect(results[0]!.tool_result?.success).toBe(true);
      expect(results[0]!.tool_result?.output).toBe("file contents here");
    });

    it("detects tool result error", () => {
      const raw = jsonl(
        userMessage("1", null, "run it"),
        assistantToolCall("2", "1", "bash"),
        toolResultError("3", "2", "bash", "command not found"),
      );
      const events = adapter.parseEvents(raw, "sess-1");
      const results = events.filter((e) => e.type === "tool_result");
      expect(results[0]!.tool_result?.success).toBe(false);
      expect(results[0]!.tool_result?.error).toBe("command not found");
    });

    it("parses compaction entry", () => {
      const raw = jsonl(
        { type: "compaction", id: "c1", parentId: null, timestamp: "2026-02-05T10:00:00.000Z", content: "summary" },
      );
      const events = adapter.parseEvents(raw, "sess-1");
      const compactions = events.filter((e) => e.type === "compaction");
      expect(compactions).toHaveLength(1);
    });

    // ── Tool name mapping ─────────────────────────────────

    it("maps read to file_read", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "read")), "s");
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_read");
    });

    it("maps write to file_write", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "write")), "s");
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_write");
    });

    it("maps edit to file_edit", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "edit")), "s");
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_edit");
    });

    it("maps bash to shell_exec", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "bash")), "s");
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("shell_exec");
    });

    it("maps grep to file_search", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "grep")), "s");
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_search");
    });

    it("maps find to file_search", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "find")), "s");
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_search");
    });

    it("maps ls to file_read", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "ls")), "s");
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_read");
    });

    it("lowercases unknown tool names", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "CustomTool")), "s");
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("customtool");
    });

    // ── Tree linearization ────────────────────────────────

    it("follows the main branch in a tree structure", () => {
      const raw = jsonl(
        userMessage("1", null, "first", "2026-02-05T10:00:00.000Z"),
        assistantToolCall("2", "1", "read", {}, "2026-02-05T10:00:01.000Z"),
        // Branch: fork from "1" (alternate branch, latest child)
        userMessage("3", "1", "branch msg", "2026-02-05T10:00:02.000Z"),
      );
      const events = adapter.parseEvents(raw, "sess-1");
      // Latest branch: root "1" → last child "3" (skips "2" which is on older branch)
      const prompts = events.filter((e) => e.type === "user_prompt");
      expect(prompts).toHaveLength(2);
      expect(prompts[0]!.message).toBe("first");
      expect(prompts[1]!.message).toBe("branch msg");
      // "2" (read tool call) should NOT appear since it's on the older branch
      const toolUses = events.filter((e) => e.type === "tool_use");
      expect(toolUses).toHaveLength(0);
    });

    // ── Malformed input handling ──────────────────────────

    it("skips malformed JSONL lines", () => {
      const warnings: string[] = [];
      const warnAdapter = new PiCodingAgentAdapter({
        eventsDir: "/nonexistent",
        warn: (msg) => warnings.push(msg),
      });
      const raw = `{bad json\n${JSON.stringify(userMessage("1", null, "valid"))}`;
      const events = warnAdapter.parseEvents(raw, "s");
      const prompts = events.filter((e) => e.type === "user_prompt");
      expect(prompts).toHaveLength(1);
      expect(warnings.some((w) => w.includes("malformed JSONL"))).toBe(true);
    });

    it("skips entries without required fields", () => {
      const warnings: string[] = [];
      const warnAdapter = new PiCodingAgentAdapter({
        eventsDir: "/nonexistent",
        warn: (msg) => warnings.push(msg),
      });
      const raw = jsonl(
        { notAType: true }, // missing type and id
        userMessage("1", null, "valid"),
      );
      const events = warnAdapter.parseEvents(raw, "s");
      const prompts = events.filter((e) => e.type === "user_prompt");
      expect(prompts).toHaveLength(1);
      expect(warnings.some((w) => w.includes("invalid entry"))).toBe(true);
    });

    it("uses 'unknown' as session_id when not provided", () => {
      const events = adapter.parseEvents(jsonl(userMessage("1", null, "hello")));
      expect(events[0]!.session_id).toBe("unknown");
    });

    // ── Full session flow ─────────────────────────────────

    it("parses a complete session flow", () => {
      const raw = jsonl(
        userMessage("1", null, "fix the bug", "2026-02-05T10:00:00.000Z"),
        assistantToolCall("2", "1", "read", { path: "/src/main.ts" }, "2026-02-05T10:00:01.000Z"),
        toolResult("3", "2", "read", "export default {}", "2026-02-05T10:00:02.000Z"),
        assistantToolCall("4", "3", "edit", { path: "/src/main.ts" }, "2026-02-05T10:00:03.000Z"),
        toolResult("5", "4", "edit", "ok", "2026-02-05T10:00:04.000Z"),
      );
      const events = adapter.parseEvents(raw, "sess-1");
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "session_start",
        "user_prompt",
        "tool_use",
        "tool_result",
        "tool_use",
        "tool_result",
        "session_end",
      ]);
    });

    it("does not include tool_input when empty", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "read", {})), "s");
      const toolUse = events.filter((e) => e.type === "tool_use")[0]!;
      expect(toolUse.tool_input).toBeUndefined();
    });

    it("preserves raw tool name in metadata", () => {
      const events = adapter.parseEvents(jsonl(assistantToolCall("1", null as unknown as string, "bash")), "s");
      const toolUse = events.filter((e) => e.type === "tool_use")[0]!;
      expect(toolUse.metadata?.["raw_tool_name"]).toBe("bash");
    });
  });

  describe("getSessionEvents", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "pi-adapter-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("returns empty when events dir does not exist", async () => {
      const events = await adapter.getSessionEvents("nonexistent");
      expect(events).toEqual([]);
    });

    it("reads and returns events for matching session", async () => {
      const cwdDir = join(tmpDir, "--home--user--project--");
      await mkdir(cwdDir, { recursive: true });

      await writeFile(
        join(cwdDir, "20260205_120000_abc-def-123.jsonl"),
        jsonl(userMessage("1", null, "hello from pi")),
      );

      const tmpAdapter = new PiCodingAgentAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("abc-def-123");
      expect(events.length).toBeGreaterThan(0);
      const prompt = events.find((e) => e.type === "user_prompt");
      expect(prompt?.message).toBe("hello from pi");
    });

    it("returns empty for non-matching session", async () => {
      const cwdDir = join(tmpDir, "--home--user--project--");
      await mkdir(cwdDir, { recursive: true });

      await writeFile(
        join(cwdDir, "20260205_120000_abc-def-123.jsonl"),
        jsonl(userMessage("1", null, "hello")),
      );

      const tmpAdapter = new PiCodingAgentAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("other-session");
      expect(events).toEqual([]);
    });
  });
});
