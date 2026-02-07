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
      const { stdout } = await runBd(["search", query]);
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
  return `${prefix} ${pattern.description}`;
}

export function findExistingIssue(searchOutput: string, prefix: string): string | null {
  // Search output from `bd search` is line-based, each line represents an issue
  // Look for lines containing the prefix that indicate an open issue
  const lines = searchOutput.split("\n").filter((l) => l.trim() !== "");

  for (const line of lines) {
    if (!line.includes(prefix)) continue;

    // Extract issue ID — typically the first token (e.g. "SS-1", "PROJ-42")
    const match = line.match(/^([A-Z]+-\d+|[a-z]+-\d+|\S+)/);
    if (match?.[1]) return match[1];
  }

  return null;
}

// ── Comment builders ────────────────────────────────────────────────

export function buildUpdateComment(pattern: Pattern): string {
  const lines = [
    `**Signal update** (${new Date().toISOString().slice(0, 10)})`,
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

export function buildTrendComment(pattern: Pattern): string {
  if (pattern.trend === "decreasing") {
    return `**Trend improving** (${new Date().toISOString().slice(0, 10)}): This pattern is decreasing in frequency (${pattern.frequency} sessions). May resolve on its own.`;
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
      reason: "bd CLI not available",
    }));
  }

  for (const pattern of patterns) {
    if (!meetsThreshold(pattern, config)) {
      results.push({
        pattern_id: pattern.id,
        action: "skipped",
        reason: `Below threshold (severity=${pattern.severity}, frequency=${pattern.frequency})`,
      });
      continue;
    }

    const title = buildIssueTitle(pattern, config.title_prefix);

    try {
      // Check for existing issue
      const searchResult = await cli.search(pattern.description);
      const existingId = findExistingIssue(searchResult, config.title_prefix);

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
      warn(`beads action: failed for pattern ${pattern.id}: ${err}`);
      results.push({
        pattern_id: pattern.id,
        action: "skipped",
        reason: `Error: ${err}`,
      });
    }
  }

  return results;
}
