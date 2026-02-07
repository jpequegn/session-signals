import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BeadsActionConfig, Pattern, Severity } from "../lib/types.js";

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────

export interface BeadsActionResult {
  pattern_id: string;
  action: "created" | "updated" | "skipped";
  issue_title?: string;
  reason?: string;
}

// ── Severity helpers ────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function meetsThreshold(
  pattern: Pattern,
  config: BeadsActionConfig,
): boolean {
  return (
    SEVERITY_RANK[pattern.severity] >= SEVERITY_RANK[config.min_severity] &&
    pattern.frequency >= config.min_frequency
  );
}

export function mapPriority(severity: Severity): number {
  switch (severity) {
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
  }
}

// ── CLI wrapper ─────────────────────────────────────────────────────

export interface BeadsCli {
  isAvailable(): Promise<boolean>;
  search(query: string): Promise<string>;
  create(title: string, type: string, priority: number): Promise<string>;
  addComment(issueId: string, comment: string): Promise<string>;
}

async function runBd(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("bd", args, { timeout: 10_000 });
}

export function createBeadsCli(): BeadsCli {
  return {
    async isAvailable(): Promise<boolean> {
      try {
        await runBd(["--version"]);
        return true;
      } catch {
        return false;
      }
    },

    async search(query: string): Promise<string> {
      const { stdout } = await runBd(["search", "--", query]);
      return stdout;
    },

    async create(title: string, type: string, priority: number): Promise<string> {
      const { stdout } = await runBd(["create", "--title", title, "--type", type, "--priority", String(priority)]);
      return stdout;
    },

    async addComment(issueId: string, comment: string): Promise<string> {
      const { stdout } = await runBd(["comments", "add", issueId, comment]);
      return stdout;
    },
  };
}

// ── Issue title helpers ─────────────────────────────────────────────

export function buildIssueTitle(pattern: Pattern, prefix: string): string {
  if (!prefix) return pattern.description;
  return `${prefix} ${pattern.description}`;
}

export function findExistingIssue(searchOutput: string, title: string): string | null {
  const lines = searchOutput.split("\n").filter((l) => l.trim() !== "");

  for (const line of lines) {
    // Extract issue ID — typically the first token (e.g. "SS-1", "PROJ-42")
    const match = line.match(/^(\w+-\d+)/);
    if (!match?.[1]) continue;

    let rest = line.slice(match[0].length).trim();

    // Skip closed issues: check for "closed" status between ID and title,
    // not the whole line (avoids false positives if the title contains "closed")
    if (/^closed\b/i.test(rest)) continue;

    // Strip a single status word between the ID and title (e.g. "open", "in_progress")
    // so that lines like "SS-1  open  [signals] Shell failures" still match.
    // Instead of a hardcoded list, strip any single non-bracket word followed by
    // whitespace when the title starts with '[' — this handles any bd status.
    if (title.startsWith("[")) {
      const statusMatch = rest.match(/^[a-z_]+\b\s+/i);
      if (statusMatch) rest = rest.slice(statusMatch[0].length);
    } else {
      // For titles without brackets, use a known-status list to avoid
      // accidentally stripping part of the title.
      const statusMatch = rest.match(/^(open|in_progress|pending|active|new|backlog|todo|blocked|wontfix|resolved)\b\s*/i);
      if (statusMatch) rest = rest.slice(statusMatch[0].length);
    }

    // Match title at start of remaining text (after issue ID).
    // Exact match, or match ignoring trailing whitespace (e.g. single trailing space).
    if (rest === title || rest.trimEnd() === title) return match[1];
    // Tolerate trailing columns (status, labels, etc.) separated by tab or
    // double-space. Require a non-word char (or end of string) right after the
    // title to avoid partial-word matches like "Foo" matching "Foozy".
    if (rest.startsWith(title)) {
      const after = rest.charAt(title.length);
      if (after === "" || after === "\t" || (after === " " && rest.charAt(title.length + 1) === " ")) return match[1];
    }
  }

  return null;
}

// ── Comment builders ────────────────────────────────────────────────

export function buildUpdateComment(pattern: Pattern, date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10);
  const lines = [
    `**Signal update** (${d})`,
    "",
    `- **Severity:** ${pattern.severity}`,
    `- **Frequency:** ${pattern.frequency} sessions`,
    `- **Trend:** ${pattern.trend}`,
  ];

  if (pattern.root_cause_hypothesis) {
    lines.push(`- **Root cause hypothesis:** ${pattern.root_cause_hypothesis}`);
  }
  if (pattern.suggested_fix) {
    lines.push(`- **Suggested fix:** ${pattern.suggested_fix}`);
  }

  return lines.join("\n");
}

export function buildTrendComment(pattern: Pattern, date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10);
  if (pattern.trend === "decreasing") {
    const lines = [
      `**Trend improving** (${d}): This pattern is decreasing in frequency (${pattern.frequency} sessions). May resolve on its own.`,
    ];
    if (pattern.root_cause_hypothesis) {
      lines.push(`- **Root cause hypothesis:** ${pattern.root_cause_hypothesis}`);
    }
    if (pattern.suggested_fix) {
      lines.push(`- **Suggested fix:** ${pattern.suggested_fix}`);
    }
    return lines.join("\n");
  }
  return buildUpdateComment(pattern);
}

// ── Main action ─────────────────────────────────────────────────────

export async function executeBeadsAction(
  patterns: Pattern[],
  config: BeadsActionConfig,
  options?: {
    cli?: BeadsCli;
    warn?: (msg: string) => void;
  },
): Promise<BeadsActionResult[]> {
  if (!config.enabled) return [];

  const cli = options?.cli ?? createBeadsCli();
  const warn = options?.warn ?? console.warn;
  const results: BeadsActionResult[] = [];

  const available = await cli.isAvailable();
  if (!available) {
    warn("beads action: bd CLI not available, skipping");
    return patterns.map((p) => ({
      pattern_id: p.id,
      action: "skipped" as const,
      issue_title: buildIssueTitle(p, config.title_prefix),
      reason: "bd CLI not available",
    }));
  }

  for (const pattern of patterns) {
    const title = buildIssueTitle(pattern, config.title_prefix);

    if (!meetsThreshold(pattern, config)) {
      results.push({
        pattern_id: pattern.id,
        action: "skipped",
        issue_title: title,
        reason: `Below threshold (severity=${pattern.severity}, frequency=${pattern.frequency})`,
      });
      continue;
    }

    try {
      // Search by description only to avoid bracket syntax issues in bd search.
      // This may return broader results than a full-title search, but
      // findExistingIssue performs exact client-side matching to compensate.
      const searchResult = await cli.search(pattern.description);
      const existingId = findExistingIssue(searchResult, title);

      if (existingId) {
        // Update existing issue with comment
        const comment = buildTrendComment(pattern);
        await cli.addComment(existingId, comment);
        results.push({
          pattern_id: pattern.id,
          action: "updated",
          issue_title: title,
        });
      } else {
        // Create new issue
        const priority = mapPriority(pattern.severity);
        await cli.create(title, "bug", priority);
        results.push({
          pattern_id: pattern.id,
          action: "created",
          issue_title: title,
        });
      }
    } catch (err) {
      const isTimeout = err instanceof Error && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
      const msg = isTimeout ? "bd CLI timed out" : `${err}`;
      warn(`beads action: failed for pattern ${pattern.id}: ${msg}`);
      results.push({
        pattern_id: pattern.id,
        action: "skipped",
        issue_title: title,
        reason: `Error: ${msg}`,
      });
    }
  }

  return results;
}
