import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessType, NormalizedEvent, NormalizedEventType } from "../lib/types.js";
import type { HarnessAdapter } from "./types.js";

// ── Claude Code raw event shape ─────────────────────────────────────

interface ClaudeCodeRawEvent {
  session_id: string;
  hook_event_type: string;
  timestamp: string;
  payload?: Record<string, unknown>;
  source_app?: string;
}

// ── Tool name mapping ───────────────────────────────────────────────

const TOOL_NAME_MAP: Record<string, string> = {
  Edit: "file_edit",
  MultiEdit: "file_edit",
  Write: "file_write",
  Read: "file_read",
  Bash: "shell_exec",
  Grep: "file_search",
  Glob: "file_search",
  Task: "agent_spawn",
  WebSearch: "web_access",
  WebFetch: "web_access",
  NotebookEdit: "file_edit",
  NotebookRead: "file_read",
  LSP: "lsp",
  AskUserQuestion: "user_interaction",
  Skill: "skill",
};

function canonicalToolName(raw: string): string {
  return TOOL_NAME_MAP[raw] ?? raw.toLowerCase();
}

// ── Hook event type mapping ─────────────────────────────────────────

const HOOK_TYPE_MAP: Record<string, NormalizedEventType> = {
  PreToolUse: "tool_use",
  PostToolUse: "tool_result",
  UserPromptSubmit: "user_prompt",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  Stop: "session_end",
  SubagentStop: "session_end",
  Notification: "compaction", // compaction notifications
};

function mapHookType(hookType: string, payload?: Record<string, unknown>): NormalizedEventType | null {
  // Notification events may represent different things
  if (hookType === "Notification") {
    const notifType = payload?.["type"] as string | undefined;
    if (notifType === "compaction") return "compaction";
    // Generic notifications are not mapped to a standard event type
    return null;
  }
  return HOOK_TYPE_MAP[hookType] ?? null;
}

// ── Parsing helpers ─────────────────────────────────────────────────

function isClaudeCodeEvent(obj: unknown): obj is ClaudeCodeRawEvent {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o["session_id"] === "string" &&
    typeof o["hook_event_type"] === "string" &&
    typeof o["timestamp"] === "string"
  );
}

function extractToolName(event: ClaudeCodeRawEvent): string | undefined {
  const payload = event.payload;
  if (!payload) return undefined;

  // PreToolUse/PostToolUse store tool name in payload.tool_name
  const toolName = payload["tool_name"] as string | undefined;
  if (toolName) return toolName;

  // Some events store it at payload.name
  const name = payload["name"] as string | undefined;
  if (name) return name;

  return undefined;
}

function extractToolInput(event: ClaudeCodeRawEvent): Record<string, unknown> | undefined {
  const payload = event.payload;
  if (!payload) return undefined;

  const input = payload["tool_input"] as Record<string, unknown> | undefined;
  if (input) return input;

  const params = payload["input"] as Record<string, unknown> | undefined;
  if (params) return params;

  return undefined;
}

function extractToolResult(event: ClaudeCodeRawEvent): NormalizedEvent["tool_result"] {
  const payload = event.payload;

  if (payload) {
    const result = payload["tool_result"];
    if (typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      const out: { success: boolean; output?: string; error?: string } = {
        success: r["success"] !== false && r["error"] === undefined,
      };
      if (typeof r["output"] === "string") out.output = r["output"];
      if (typeof r["error"] === "string") out.error = r["error"];
      return out;
    }

    // PostToolUse may have an error string directly
    const error = payload["error"] as string | undefined;
    if (error) {
      return { success: false, error };
    }
  }

  // PostToolUse with no error/result (regardless of payload presence) means success
  if (event.hook_event_type === "PostToolUse") {
    return { success: true };
  }

  return undefined;
}

function extractMessage(event: ClaudeCodeRawEvent): string | undefined {
  const payload = event.payload;
  if (!payload) return undefined;

  // UserPromptSubmit stores user message
  const message = payload["message"] as string | undefined;
  if (message) return message;

  const prompt = payload["prompt"] as string | undefined;
  if (prompt) return prompt;

  return undefined;
}

function extractCwd(event: ClaudeCodeRawEvent): string | undefined {
  const payload = event.payload;
  if (!payload) return undefined;
  return payload["cwd"] as string | undefined;
}

function rawToNormalized(raw: ClaudeCodeRawEvent): NormalizedEvent | null {
  const eventType = mapHookType(raw.hook_event_type, raw.payload);
  if (eventType === null) return null;

  const rawToolName = extractToolName(raw);

  const event: NormalizedEvent = {
    id: randomUUID(),
    timestamp: raw.timestamp,
    harness: "claude_code",
    type: eventType,
    session_id: raw.session_id,
  };

  if (rawToolName) event.tool_name = canonicalToolName(rawToolName);

  const toolInput = extractToolInput(raw);
  if (toolInput) event.tool_input = toolInput;

  const toolResult = extractToolResult(raw);
  if (toolResult) event.tool_result = toolResult;

  const message = extractMessage(raw);
  if (message) event.message = message;

  const cwd = extractCwd(raw);
  if (cwd) event.cwd = cwd;

  event.metadata = { hook_event_type: raw.hook_event_type, source_app: raw.source_app };

  return event;
}

const FILE_READ_BATCH_SIZE = 20;

// ── Public API ──────────────────────────────────────────────────────

export interface ClaudeCodeAdapterOptions {
  eventsDir: string;
  warn?: (msg: string) => void;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  private readonly eventsDir: string;
  private readonly warn: (msg: string) => void;

  constructor(options: ClaudeCodeAdapterOptions) {
    this.eventsDir = options.eventsDir;
    this.warn = options.warn ?? console.warn;
  }

  getEventSource(): HarnessType {
    return "claude_code";
  }

  parseEvents(raw: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const lines = raw.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.warn(`claude-code adapter: skipping malformed JSONL at line ${i + 1}`);
        continue;
      }

      if (!isClaudeCodeEvent(parsed)) {
        this.warn(`claude-code adapter: skipping invalid event at line ${i + 1}`);
        continue;
      }

      const normalized = rawToNormalized(parsed);
      if (normalized) {
        events.push(normalized);
      }
    }

    return events;
  }

  async getSessionEvents(sessionId: string): Promise<NormalizedEvent[]> {
    const allEvents: NormalizedEvent[] = [];
    const jsonlFiles = await this.findJsonlFiles();

    for (let start = 0; start < jsonlFiles.length; start += FILE_READ_BATCH_SIZE) {
      const batch = jsonlFiles.slice(start, start + FILE_READ_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((file) => readFile(file, "utf-8")),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const filePath = batch[i]!;
        if (result.status === "rejected") {
          this.warn(`claude-code adapter: failed to read ${filePath}: ${result.reason}`);
          continue;
        }
        const events = this.parseEvents(result.value);
        for (const event of events) {
          if (event.session_id === sessionId) {
            allEvents.push(event);
          }
        }
      }
    }

    return allEvents.sort((a, b) => {
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      if (Number.isNaN(ta) || Number.isNaN(tb)) return a.timestamp.localeCompare(b.timestamp);
      return ta - tb;
    });
  }

  private async findJsonlFiles(): Promise<string[]> {
    const files: string[] = [];

    let topEntries: import("node:fs").Dirent[];
    try {
      topEntries = await readdir(this.eventsDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const topEntry of topEntries) {
      if (!topEntry.isDirectory()) continue;
      const monthDir = join(this.eventsDir, topEntry.name);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(monthDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith("_all-events.jsonl")) {
          files.push(join(monthDir, entry.name));
        }
      }
    }

    return files.sort();
  }
}
