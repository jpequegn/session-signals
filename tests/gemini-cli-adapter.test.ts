import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeminiCliAdapter } from "../src/adapters/gemini-cli.js";

function makeSession(history: Record<string, unknown>[]): string {
  return JSON.stringify({ history });
}

function userText(text: string): Record<string, unknown> {
  return { role: "user", parts: [{ text }] };
}

function modelText(text: string): Record<string, unknown> {
  return { role: "model", parts: [{ text }] };
}

function modelFunctionCall(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "model", parts: [{ functionCall: { name, args } }] };
}

function userFunctionResponse(name: string, content: unknown): Record<string, unknown> {
  return { role: "user", parts: [{ functionResponse: { name, response: { name, content } } }] };
}

describe("GeminiCliAdapter", () => {
  const adapter = new GeminiCliAdapter({
    eventsDir: "/nonexistent",
    warn: () => {},
  });

  describe("getEventSource", () => {
    it("returns gemini_cli", () => {
      expect(adapter.getEventSource()).toBe("gemini_cli");
    });
  });

  describe("parseEvents", () => {
    it("parses user text as user_prompt", () => {
      const raw = makeSession([userText("help me fix this bug")]);
      const events = adapter.parseEvents(raw);
      const prompts = events.filter((e) => e.type === "user_prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.message).toBe("help me fix this bug");
      expect(prompts[0]!.harness).toBe("gemini_cli");
    });

    it("synthesizes session_start and session_end", () => {
      const raw = makeSession([userText("hello")]);
      const events = adapter.parseEvents(raw);
      expect(events[0]!.type).toBe("session_start");
      expect(events[events.length - 1]!.type).toBe("session_end");
    });

    it("parses functionCall as tool_use", () => {
      const raw = makeSession([
        modelFunctionCall("read_file", { target_file: "/src/main.ts" }),
      ]);
      const events = adapter.parseEvents(raw);
      const toolUse = events.filter((e) => e.type === "tool_use");
      expect(toolUse).toHaveLength(1);
      expect(toolUse[0]!.tool_name).toBe("file_read");
      expect(toolUse[0]!.tool_input).toEqual({ target_file: "/src/main.ts" });
    });

    it("parses functionResponse as tool_result", () => {
      const raw = makeSession([
        userFunctionResponse("read_file", "file contents here"),
      ]);
      const events = adapter.parseEvents(raw);
      const toolResult = events.filter((e) => e.type === "tool_result");
      expect(toolResult).toHaveLength(1);
      expect(toolResult[0]!.tool_name).toBe("file_read");
      expect(toolResult[0]!.tool_result?.success).toBe(true);
      expect(toolResult[0]!.tool_result?.output).toBe("file contents here");
    });

    it("detects error in functionResponse", () => {
      const raw = makeSession([
        userFunctionResponse("run_shell_command", { error: "command not found" }),
      ]);
      const events = adapter.parseEvents(raw);
      const toolResult = events.filter((e) => e.type === "tool_result");
      expect(toolResult[0]!.tool_result?.success).toBe(false);
      expect(toolResult[0]!.tool_result?.error).toBe("command not found");
    });

    it("JSON-stringifies non-string error in functionResponse", () => {
      const raw = makeSession([
        userFunctionResponse("run_shell_command", { error: { code: 404, message: "not found" } }),
      ]);
      const events = adapter.parseEvents(raw);
      const toolResult = events.filter((e) => e.type === "tool_result");
      expect(toolResult[0]!.tool_result?.success).toBe(false);
      expect(toolResult[0]!.tool_result?.error).toBe(JSON.stringify({ code: 404, message: "not found" }));
    });

    it("handles object content in functionResponse", () => {
      const raw = makeSession([
        userFunctionResponse("list_directory", { files: ["a.ts", "b.ts"] }),
      ]);
      const events = adapter.parseEvents(raw);
      const toolResult = events.filter((e) => e.type === "tool_result");
      expect(toolResult[0]!.tool_result?.success).toBe(true);
      expect(toolResult[0]!.tool_result?.output).toBe(JSON.stringify({ files: ["a.ts", "b.ts"] }));
    });

    // ── Tool name mapping ─────────────────────────────────

    it("maps run_shell_command to shell_exec", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("run_shell_command")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("shell_exec");
    });

    it("maps write_file to file_write", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("write_file")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_write");
    });

    it("maps replace to file_edit", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("replace")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_edit");
    });

    it("maps read_file to file_read", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("read_file")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_read");
    });

    it("maps list_directory to file_read", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("list_directory")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_read");
    });

    it("maps glob to file_search", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("glob")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_search");
    });

    it("maps search_file_content to file_search", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("search_file_content")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_search");
    });

    it("maps grep_search to file_search", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("grep_search")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_search");
    });

    it("maps web_fetch to web_access", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("web_fetch")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("web_access");
    });

    it("maps google_web_search to web_access", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("google_web_search")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("web_access");
    });

    it("maps save_memory to memory", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("save_memory")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("memory");
    });

    it("maps write_todos to planning", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("write_todos")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("planning");
    });

    it("maps codebase_investigator to file_search", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("codebase_investigator")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("file_search");
    });

    it("maps activate_skill to skill", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("activate_skill")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("skill");
    });

    it("lowercases unknown tool names", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("CustomTool")]));
      expect(events.filter((e) => e.type === "tool_use")[0]!.tool_name).toBe("customtool");
    });

    // ── Full session flow ─────────────────────────────────

    it("parses a complete tool use cycle", () => {
      const raw = makeSession([
        userText("read main.ts"),
        modelFunctionCall("read_file", { target_file: "/src/main.ts" }),
        userFunctionResponse("read_file", "export default {}"),
        modelText("The file exports a default empty object."),
      ]);
      const events = adapter.parseEvents(raw);
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "session_start",
        "user_prompt",
        "tool_use",
        "tool_result",
        // model text is not mapped
        "session_end",
      ]);
    });

    it("handles multiple tool calls in one model turn", () => {
      const raw = makeSession([{
        role: "model",
        parts: [
          { functionCall: { name: "read_file", args: { target_file: "/a.ts" } } },
          { functionCall: { name: "read_file", args: { target_file: "/b.ts" } } },
        ],
      }]);
      const events = adapter.parseEvents(raw);
      const toolUses = events.filter((e) => e.type === "tool_use");
      expect(toolUses).toHaveLength(2);
    });

    // ── Metadata preservation ─────────────────────────────

    it("stores raw tool name in metadata", () => {
      const events = adapter.parseEvents(makeSession([
        modelFunctionCall("run_shell_command", { command: "ls" }),
      ]));
      const toolUse = events.filter((e) => e.type === "tool_use")[0]!;
      expect(toolUse.metadata?.["raw_tool_name"]).toBe("run_shell_command");
    });

    // ── Error handling ────────────────────────────────────

    it("warns on malformed JSON", () => {
      const warnings: string[] = [];
      const warnAdapter = new GeminiCliAdapter({
        eventsDir: "/nonexistent",
        warn: (msg) => warnings.push(msg),
      });
      warnAdapter.parseEvents("{bad json");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("failed to parse");
    });

    it("warns on missing history array", () => {
      const warnings: string[] = [];
      const warnAdapter = new GeminiCliAdapter({
        eventsDir: "/nonexistent",
        warn: (msg) => warnings.push(msg),
      });
      warnAdapter.parseEvents(JSON.stringify({ nohistory: true }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("no history array");
    });

    it("returns empty for non-object JSON", () => {
      const warnings: string[] = [];
      const warnAdapter = new GeminiCliAdapter({
        eventsDir: "/nonexistent",
        warn: (msg) => warnings.push(msg),
      });
      const events = warnAdapter.parseEvents('"just a string"');
      expect(events).toHaveLength(0);
    });

    it("skips content entries without parts", () => {
      const raw = makeSession([
        { role: "user" }, // no parts
        userText("real message"),
      ]);
      const events = adapter.parseEvents(raw);
      const prompts = events.filter((e) => e.type === "user_prompt");
      expect(prompts).toHaveLength(1);
    });

    it("skips null and non-object entries in history", () => {
      const raw = JSON.stringify({ history: [null, 42, "string", userText("valid")] });
      const warnings: string[] = [];
      const warnAdapter = new GeminiCliAdapter({
        eventsDir: "/nonexistent",
        warn: (msg) => warnings.push(msg),
      });
      const events = warnAdapter.parseEvents(raw);
      const prompts = events.filter((e) => e.type === "user_prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.message).toBe("valid");
      expect(warnings.length).toBeGreaterThanOrEqual(2); // null and 42 trigger warnings
    });

    it("does not include tool_input when args is empty", () => {
      const events = adapter.parseEvents(makeSession([modelFunctionCall("read_file", {})]));
      const toolUse = events.filter((e) => e.type === "tool_use")[0]!;
      expect(toolUse.tool_input).toBeUndefined();
    });

    it("uses 'unknown' as session_id when no sessionId is provided", () => {
      const events = adapter.parseEvents(makeSession([userText("hello")]));
      expect(events[0]!.session_id).toBe("unknown");
    });

    it("uses provided sessionId when given", () => {
      const events = adapter.parseEvents(makeSession([userText("hello")]), "my-session");
      expect(events[0]!.session_id).toBe("my-session");
    });
  });

  describe("getSessionEvents", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "gemini-adapter-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("returns empty array when events dir does not exist", async () => {
      const events = await adapter.getSessionEvents("nonexistent");
      expect(events).toEqual([]);
    });

    it("reads session file matching session ID", async () => {
      const projectDir = join(tmpDir, "abc123");
      const chatsDir = join(projectDir, "chats");
      await mkdir(chatsDir, { recursive: true });

      await writeFile(
        join(chatsDir, "session-2026-02-05T10-00-deadbeef.json"),
        makeSession([userText("hello from Gemini")]),
      );

      const tmpAdapter = new GeminiCliAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("session-2026-02-05T10-00-deadbeef");
      expect(events.length).toBeGreaterThan(0);
      const prompt = events.find((e) => e.type === "user_prompt");
      expect(prompt?.message).toBe("hello from Gemini");
    });

    it("derives timestamps from the session filename", async () => {
      const projectDir = join(tmpDir, "abc123");
      const chatsDir = join(projectDir, "chats");
      await mkdir(chatsDir, { recursive: true });

      await writeFile(
        join(chatsDir, "session-2026-02-05T10-00-deadbeef.json"),
        makeSession([userText("hello")]),
      );

      const tmpAdapter = new GeminiCliAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("session-2026-02-05T10-00-deadbeef");
      const sessionStart = events.find((e) => e.type === "session_start");
      expect(sessionStart?.timestamp).toBe("2026-02-05T10:00:00.000Z");
    });

    it("returns empty for non-matching session ID", async () => {
      const projectDir = join(tmpDir, "abc123");
      const chatsDir = join(projectDir, "chats");
      await mkdir(chatsDir, { recursive: true });

      await writeFile(
        join(chatsDir, "session-2026-02-05T10-00-deadbeef.json"),
        makeSession([userText("hello")]),
      );

      const tmpAdapter = new GeminiCliAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("session-2026-02-05T10-00-aaaaaaaa");
      expect(events).toEqual([]);
    });

    it("reads session file with seconds in the timestamp", async () => {
      const projectDir = join(tmpDir, "abc123");
      const chatsDir = join(projectDir, "chats");
      await mkdir(chatsDir, { recursive: true });

      await writeFile(
        join(chatsDir, "session-2025-09-18T02-45-30-3b44bc68.json"),
        makeSession([userText("hello with seconds")]),
      );

      const tmpAdapter = new GeminiCliAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("session-2025-09-18T02-45-30-3b44bc68");
      expect(events.length).toBeGreaterThan(0);
      const prompt = events.find((e) => e.type === "user_prompt");
      expect(prompt?.message).toBe("hello with seconds");
      const sessionStart = events.find((e) => e.type === "session_start");
      expect(sessionStart?.timestamp).toBe("2025-09-18T02:45:30.000Z");
    });

    it("ignores session files with malformed stems", async () => {
      const projectDir = join(tmpDir, "abc123");
      const chatsDir = join(projectDir, "chats");
      await mkdir(chatsDir, { recursive: true });

      // Missing hex suffix
      await writeFile(
        join(chatsDir, "session-2026-02-05T10-00.json"),
        makeSession([userText("no hex")]),
      );
      // Hex suffix too short (< 8 chars)
      await writeFile(
        join(chatsDir, "session-2026-02-05T10-00-abc.json"),
        makeSession([userText("short hex")]),
      );
      // Uppercase hex (not valid lowercase hex)
      await writeFile(
        join(chatsDir, "session-2026-02-05T10-00-DEADBEEF.json"),
        makeSession([userText("upper hex")]),
      );
      // Degenerate timestamp
      await writeFile(
        join(chatsDir, "session-T-a.json"),
        makeSession([userText("degenerate")]),
      );

      const tmpAdapter = new GeminiCliAdapter({ eventsDir: tmpDir, warn: () => {} });

      // None of these malformed files should be discoverable
      for (const badId of [
        "session-2026-02-05T10-00",
        "session-2026-02-05T10-00-abc",
        "session-2026-02-05T10-00-DEADBEEF",
        "session-T-a",
      ]) {
        const events = await tmpAdapter.getSessionEvents(badId);
        expect(events).toEqual([]);
      }
    });

    it("returns empty for session file with invalid JSON", async () => {
      const projectDir = join(tmpDir, "abc123");
      const chatsDir = join(projectDir, "chats");
      await mkdir(chatsDir, { recursive: true });

      await writeFile(
        join(chatsDir, "session-2026-02-05T10-00-deadbeef.json"),
        "{corrupted json!!!",
      );

      const warnings: string[] = [];
      const tmpAdapter = new GeminiCliAdapter({ eventsDir: tmpDir, warn: (msg) => warnings.push(msg) });
      const events = await tmpAdapter.getSessionEvents("session-2026-02-05T10-00-deadbeef");
      expect(events).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("failed to parse");
    });

    it("ignores non-session files", async () => {
      const projectDir = join(tmpDir, "abc123");
      const chatsDir = join(projectDir, "chats");
      await mkdir(chatsDir, { recursive: true });

      await writeFile(join(chatsDir, "checkpoint-save1.json"), makeSession([userText("checkpoint")]));
      await writeFile(join(chatsDir, "logs.json"), "{}");

      const tmpAdapter = new GeminiCliAdapter({ eventsDir: tmpDir, warn: () => {} });
      const events = await tmpAdapter.getSessionEvents("save1");
      expect(events).toEqual([]);
    });
  });
});
