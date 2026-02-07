import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessType, NormalizedEvent } from "../lib/types.js";
import type { HarnessAdapter } from "./types.js";

// ── Gemini CLI raw session types ────────────────────────────────────

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

interface GeminiFunctionResponse {
  name: string;
  response: {
    name?: string;
    content?: unknown;
  };
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
}

interface GeminiContent {
  role: "user" | "model";
  parts?: GeminiPart[];
}

// ── Tool name mapping ───────────────────────────────────────────────

const TOOL_NAME_MAP: Record<string, string> = {
  run_shell_command: "shell_exec",
  write_file: "file_write",
  replace: "file_edit",
  read_file: "file_read",
  list_directory: "file_read",
  glob: "file_search",
  search_file_content: "file_search",
  grep_search: "file_search",
  web_fetch: "web_access",
  google_web_search: "web_access",
  save_memory: "memory",
  write_todos: "planning",
  codebase_investigator: "file_search",
  activate_skill: "skill",
};

function canonicalToolName(raw: string): string {
  return TOOL_NAME_MAP[raw] ?? raw.toLowerCase();
}

// ── Session file helpers ────────────────────────────────────────────

/** Extract session ID from filename like session-2025-09-18T02-45-3b44bc68.json */
function extractSessionId(filename: string): string | null {
  const match = filename.match(/^session-[\dT-]+-([a-f\d]+)\.json$/);
  return match?.[1] ?? null;
}

/** Extract a timestamp hint from session filename */
function extractTimestampFromFilename(filename: string): string | null {
  // session-2026-02-05T10-00-deadbeef.json → date=2026-02-05, time=10-00
  const match = filename.match(/^session-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-[a-f\d]+\.json$/);
  if (!match) return null;
  return `${match[1]}T${match[2]}:${match[3]}:00.000Z`;
}

// ── Content → NormalizedEvent conversion ────────────────────────────

function contentToEvents(
  content: GeminiContent,
  sessionId: string,
  baseTimestamp: string,
  contentIndex: number,
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const parts = content.parts ?? [];

  for (const part of parts) {
    if (part.text !== undefined) {
      if (content.role === "user") {
        events.push({
          id: randomUUID(),
          timestamp: baseTimestamp,
          harness: "gemini_cli",
          type: "user_prompt",
          session_id: sessionId,
          message: part.text,
          metadata: { content_index: contentIndex },
        });
      }
      // Model text responses are not mapped to a NormalizedEvent type
      // (they're LLM output, not tool/user events)
      continue;
    }

    if (part.functionCall) {
      const event: NormalizedEvent = {
        id: randomUUID(),
        timestamp: baseTimestamp,
        harness: "gemini_cli",
        type: "tool_use",
        session_id: sessionId,
        tool_name: canonicalToolName(part.functionCall.name),
        metadata: {
          content_index: contentIndex,
          raw_tool_name: part.functionCall.name,
        },
      };
      if (part.functionCall.args && Object.keys(part.functionCall.args).length > 0) {
        event.tool_input = part.functionCall.args;
      }
      events.push(event);
      continue;
    }

    if (part.functionResponse) {
      const resp = part.functionResponse.response;
      const hasError = resp.content !== undefined &&
        typeof resp.content === "object" &&
        resp.content !== null &&
        "error" in (resp.content as Record<string, unknown>);

      const event: NormalizedEvent = {
        id: randomUUID(),
        timestamp: baseTimestamp,
        harness: "gemini_cli",
        type: "tool_result",
        session_id: sessionId,
        tool_name: canonicalToolName(part.functionResponse.name),
        metadata: {
          content_index: contentIndex,
          raw_tool_name: part.functionResponse.name,
        },
      };

      const result: { success: boolean; output?: string; error?: string } = {
        success: !hasError,
      };
      if (hasError) {
        const errContent = resp.content as Record<string, unknown>;
        result.error = typeof errContent["error"] === "string"
          ? errContent["error"]
          : JSON.stringify(errContent["error"]);
      } else if (typeof resp.content === "string") {
        result.output = resp.content;
      } else if (resp.content !== undefined) {
        result.output = JSON.stringify(resp.content);
      }
      event.tool_result = result;

      events.push(event);
    }
  }

  return events;
}

const FILE_READ_BATCH_SIZE = 20;

// ── Public API ──────────────────────────────────────────────────────

export interface GeminiCliAdapterOptions {
  eventsDir: string;
  warn?: (msg: string) => void;
}

export class GeminiCliAdapter implements HarnessAdapter {
  private readonly eventsDir: string;
  private readonly warn: (msg: string) => void;

  constructor(options: GeminiCliAdapterOptions) {
    this.eventsDir = options.eventsDir;
    this.warn = options.warn ?? console.warn;
  }

  getEventSource(): HarnessType {
    return "gemini_cli";
  }

  /**
   * Parse a Gemini CLI session JSON string into NormalizedEvents.
   * Expects the JSON format: { history: Content[] }
   */
  parseEvents(raw: string): NormalizedEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.warn("gemini-cli adapter: failed to parse session JSON");
      return [];
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.warn("gemini-cli adapter: session data is not an object");
      return [];
    }

    const obj = parsed as Record<string, unknown>;
    const history = obj["history"];

    if (!Array.isArray(history)) {
      this.warn("gemini-cli adapter: session has no history array");
      return [];
    }

    return this.parseHistory(history, "unknown");
  }

  async getSessionEvents(sessionId: string): Promise<NormalizedEvent[]> {
    const sessionFiles = await this.findSessionFiles();

    for (let start = 0; start < sessionFiles.length; start += FILE_READ_BATCH_SIZE) {
      const batch = sessionFiles.slice(start, start + FILE_READ_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((f) => readFile(f.path, "utf-8")),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const file = batch[i]!;
        if (result.status === "rejected") {
          this.warn(`gemini-cli adapter: failed to read ${file.path}: ${result.reason}`);
          continue;
        }

        if (file.sessionId === sessionId) {
          return this.parseSessionFile(result.value, file.sessionId, file.timestamp);
        }
      }
    }

    return [];
  }

  private parseHistory(history: unknown[], sessionId: string, baseTimestamp?: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const ts = baseTimestamp ?? new Date().toISOString();

    // Synthesize session_start
    events.push({
      id: randomUUID(),
      timestamp: ts,
      harness: "gemini_cli",
      type: "session_start",
      session_id: sessionId,
    });

    for (let i = 0; i < history.length; i++) {
      const content = history[i] as GeminiContent;
      if (!content || typeof content !== "object") {
        this.warn(`gemini-cli adapter: skipping invalid content at index ${i}`);
        continue;
      }
      if (!content.role || !Array.isArray(content.parts)) continue;

      // Offset each content entry by 1ms to preserve ordering
      const entryTs = new Date(new Date(ts).getTime() + i + 1).toISOString();
      const normalized = contentToEvents(content, sessionId, entryTs, i);
      events.push(...normalized);
    }

    // Synthesize session_end
    const endTs = new Date(new Date(ts).getTime() + history.length + 1).toISOString();
    events.push({
      id: randomUUID(),
      timestamp: endTs,
      harness: "gemini_cli",
      type: "session_end",
      session_id: sessionId,
    });

    return events;
  }

  private parseSessionFile(raw: string, sessionId: string, baseTimestamp: string | null): NormalizedEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.warn(`gemini-cli adapter: failed to parse session file for ${sessionId}`);
      return [];
    }

    if (typeof parsed !== "object" || parsed === null) return [];
    const obj = parsed as Record<string, unknown>;
    const history = obj["history"];
    if (!Array.isArray(history)) return [];

    return this.parseHistory(history, sessionId, baseTimestamp ?? undefined);
  }

  private async findSessionFiles(): Promise<Array<{ path: string; sessionId: string; timestamp: string | null }>> {
    const files: Array<{ path: string; sessionId: string; timestamp: string | null }> = [];

    let projectDirs: import("node:fs").Dirent[];
    try {
      projectDirs = await readdir(this.eventsDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const chatsDir = join(this.eventsDir, projectDir.name, "chats");

      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(chatsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith(".json")) continue;
        const sessionId = extractSessionId(entry.name);
        if (!sessionId) continue;

        files.push({
          path: join(chatsDir, entry.name),
          sessionId,
          timestamp: extractTimestampFromFilename(entry.name),
        });
      }
    }

    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}
