import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { HarnessType, NormalizedEvent } from "../lib/types.js";
import type { HarnessAdapter } from "./types.js";

// ── Pi coding agent raw entry types ─────────────────────────────────

interface PiEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  role?: "user" | "assistant";
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  model?: string;
  sessionName?: string;
}

// ── Tool name mapping ───────────────────────────────────────────────

const TOOL_NAME_MAP: Record<string, string> = {
  read: "file_read",
  write: "file_write",
  edit: "file_edit",
  bash: "shell_exec",
  grep: "file_search",
  find: "file_search",
  ls: "file_read",
};

function canonicalToolName(raw: string): string {
  return TOOL_NAME_MAP[raw] ?? raw.toLowerCase();
}

// ── Entry validation ────────────────────────────────────────────────

function deterministicId(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 32);
}

function isPiEntry(obj: unknown): obj is PiEntry {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o["type"] === "string" && typeof o["id"] === "string";
}

// ── Entry → NormalizedEvent conversion ──────────────────────────────

function entryToEvents(entry: PiEntry, sessionId: string): NormalizedEvent[] {
  const ts = entry.timestamp ?? new Date(0).toISOString();

  if (entry.type === "message") {
    // User message → user_prompt
    if (entry.role === "user" && entry.content && !entry.toolName) {
      return [{
        id: deterministicId(sessionId, entry.id, "user_prompt"),
        timestamp: ts,
        harness: "pi_coding_agent",
        type: "user_prompt",
        session_id: sessionId,
        message: entry.content,
        metadata: { entry_id: entry.id },
      }];
    }

    // Tool call from assistant
    if (entry.role === "assistant" && entry.toolName) {
      const event: NormalizedEvent = {
        id: deterministicId(sessionId, entry.id, "tool_use"),
        timestamp: ts,
        harness: "pi_coding_agent",
        type: "tool_use",
        session_id: sessionId,
        tool_name: canonicalToolName(entry.toolName),
        metadata: { entry_id: entry.id, raw_tool_name: entry.toolName },
      };
      if (entry.toolInput && Object.keys(entry.toolInput).length > 0) {
        event.tool_input = entry.toolInput;
      }
      return [event];
    }

    // Tool result (user role with toolName = result being returned to model)
    if (entry.role === "user" && entry.toolName) {
      const hasError = entry.toolResult !== undefined &&
        typeof entry.toolResult === "object" &&
        entry.toolResult !== null &&
        "error" in (entry.toolResult as Record<string, unknown>);

      const result: { success: boolean; output?: string; error?: string } = {
        success: !hasError,
      };

      if (hasError) {
        const errObj = entry.toolResult as Record<string, unknown>;
        result.error = typeof errObj["error"] === "string"
          ? errObj["error"]
          : JSON.stringify(errObj["error"]);
      } else if (typeof entry.content === "string") {
        result.output = entry.content;
      } else if (entry.toolResult !== undefined) {
        result.output = typeof entry.toolResult === "string"
          ? entry.toolResult
          : JSON.stringify(entry.toolResult);
      }

      const event: NormalizedEvent = {
        id: deterministicId(sessionId, entry.id, "tool_result"),
        timestamp: ts,
        harness: "pi_coding_agent",
        type: "tool_result",
        session_id: sessionId,
        tool_name: canonicalToolName(entry.toolName),
        metadata: { entry_id: entry.id, raw_tool_name: entry.toolName },
      };
      event.tool_result = result;
      return [event];
    }

    return [];
  }

  if (entry.type === "compaction") {
    return [{
      id: deterministicId(sessionId, entry.id, "compaction"),
      timestamp: ts,
      harness: "pi_coding_agent",
      type: "compaction",
      session_id: sessionId,
      metadata: { entry_id: entry.id },
    }];
  }

  // Other entry types (branch_summary, label, model_change, etc.) are not mapped
  return [];
}

// ── Session file helpers ────────────────────────────────────────────

/** Walk the tree from root to build a linear event sequence following the main branch. */
function linearizeEntries(entries: PiEntry[], warn?: (msg: string) => void): PiEntry[] {
  if (entries.length === 0) return [];

  // Build child lookup: parentId → children[]
  const childrenOf = new Map<string | null, PiEntry[]>();
  for (const entry of entries) {
    const pid = entry.parentId ?? null;
    const list = childrenOf.get(pid);
    if (list) {
      list.push(entry);
    } else {
      childrenOf.set(pid, [entry]);
    }
  }

  // Walk from root (parentId: null), always taking the last child (latest branch)
  const result: PiEntry[] = [];
  const roots = childrenOf.get(null);
  if (!roots || roots.length === 0) {
    warn?.("pi-coding-agent adapter: no root entries found (parentId: null), returning entries in original order");
    return entries;
  }

  let current: PiEntry | undefined = roots[roots.length - 1];
  while (current) {
    result.push(current);
    const children = childrenOf.get(current.id);
    current = children?.[children.length - 1];
  }

  return result;
}

// ── Public API ──────────────────────────────────────────────────────

export interface PiCodingAgentAdapterOptions {
  eventsDir: string;
  warn?: (msg: string) => void;
}

export class PiCodingAgentAdapter implements HarnessAdapter {
  private readonly eventsDir: string;
  private readonly warn: (msg: string) => void;

  constructor(options: PiCodingAgentAdapterOptions) {
    this.eventsDir = options.eventsDir;
    this.warn = options.warn ?? console.warn;
  }

  getEventSource(): HarnessType {
    return "pi_coding_agent";
  }

  parseEvents(raw: string, sessionId?: string): NormalizedEvent[] {
    const sid = sessionId ?? "unknown";
    const entries: PiEntry[] = [];
    const lines = raw.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.warn(`pi-coding-agent adapter: skipping malformed JSONL at line ${i + 1}`);
        continue;
      }

      if (!isPiEntry(parsed)) {
        this.warn(`pi-coding-agent adapter: skipping invalid entry at line ${i + 1}`);
        continue;
      }

      entries.push(parsed);
    }

    const linear = linearizeEntries(entries, this.warn);
    const events: NormalizedEvent[] = [];

    // Synthesize session_start
    const firstTs = linear[0]?.timestamp ?? new Date(0).toISOString();
    events.push({
      id: deterministicId(sid, "session_start"),
      timestamp: firstTs,
      harness: "pi_coding_agent",
      type: "session_start",
      session_id: sid,
    });

    for (const entry of linear) {
      events.push(...entryToEvents(entry, sid));
    }

    // Synthesize session_end
    const lastTs = linear[linear.length - 1]?.timestamp ?? firstTs;
    events.push({
      id: deterministicId(sid, "session_end"),
      timestamp: lastTs,
      harness: "pi_coding_agent",
      type: "session_end",
      session_id: sid,
    });

    return events;
  }

  async getSessionEvents(sessionId: string): Promise<NormalizedEvent[]> {
    const files = await this.findSessionFiles();
    const match = files.find((f) => f.sessionId === sessionId);
    if (!match) return [];

    let raw: string;
    try {
      raw = await readFile(match.path, "utf-8");
    } catch (err) {
      this.warn(`pi-coding-agent adapter: failed to read ${match.path}: ${err}`);
      return [];
    }

    return this.parseEvents(raw, match.sessionId);
  }

  private async findSessionFiles(): Promise<Array<{ path: string; sessionId: string }>> {
    const files: Array<{ path: string; sessionId: string }> = [];

    let cwdDirs: import("node:fs").Dirent[];
    try {
      cwdDirs = await readdir(this.eventsDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const cwdDir of cwdDirs) {
      if (!cwdDir.isDirectory()) continue;
      const sessionDir = join(this.eventsDir, cwdDir.name);

      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(sessionDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        // Filename: <timestamp>_<uuid>.jsonl → sessionId = uuid portion
        const match = entry.name.match(/^[\d_T-]+_([a-f\d-]+)\.jsonl$/i);
        if (!match?.[1]) continue;
        files.push({
          path: join(sessionDir, entry.name),
          sessionId: match[1],
        });
      }
    }

    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}
