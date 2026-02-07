import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AutofixActionConfig, Pattern, Severity } from "../lib/types.js";

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────

export interface AutofixResult {
  pattern_id: string;
  action: "fixed" | "skipped";
  branch?: string;
  reason?: string;
}

export interface CleanupResult {
  branch: string;
  deleted: boolean;
  age_days: number;
  reason?: string;
}

// ── Git abstraction (injectable for testing) ────────────────────────

export interface GitOps {
  isClean(): Promise<boolean>;
  currentBranch(): Promise<string>;
  branchExists(name: string): Promise<boolean>;
  listBranches(prefix: string): Promise<string[]>;
  createAndCheckoutBranch(name: string): Promise<void>;
  checkoutBranch(name: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  branchAge(name: string, now?: Date): Promise<number>;
  hasNewCommits(branch: string, base: string): Promise<boolean>;
}

export interface AgentRunner {
  isAvailable(): Promise<boolean>;
  run(prompt: string, allowedTools: string[], cwd: string): Promise<void>;
}

// ── Default implementations ─────────────────────────────────────────

async function runGit(args: string[], cwd?: string): Promise<string> {
  const opts: { timeout: number; cwd?: string } = { timeout: 10_000 };
  if (cwd) opts.cwd = cwd;
  const { stdout } = await execFileAsync("git", args, opts);
  return stdout.trim();
}

export function createGitOps(cwd?: string): GitOps {
  return {
    async isClean(): Promise<boolean> {
      const status = await runGit(["status", "--porcelain"], cwd);
      return status === "";
    },

    async currentBranch(): Promise<string> {
      return runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    },

    async branchExists(name: string): Promise<boolean> {
      try {
        await runGit(["rev-parse", "--verify", name], cwd);
        return true;
      } catch {
        return false;
      }
    },

    async listBranches(prefix: string): Promise<string[]> {
      try {
        const output = await runGit(
          ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}*`],
          cwd,
        );
        if (!output) return [];
        return output.split("\n").filter((b) => b.trim() !== "");
      } catch {
        return [];
      }
    },

    async createAndCheckoutBranch(name: string): Promise<void> {
      await runGit(["checkout", "-b", name], cwd);
    },

    async checkoutBranch(name: string): Promise<void> {
      await runGit(["checkout", name], cwd);
    },

    async deleteBranch(name: string): Promise<void> {
      await runGit(["branch", "-D", name], cwd);
    },

    async branchAge(name: string, now?: Date): Promise<number> {
      const timestamp = await runGit(
        ["log", "-1", "--format=%ct", name],
        cwd,
      );
      const commitEpoch = parseInt(timestamp, 10);
      // Unparseable timestamp → Infinity so cleanup treats it as expired
      if (isNaN(commitEpoch)) return Infinity;
      const nowEpoch = Math.floor((now ?? new Date()).getTime() / 1000);
      return Math.floor((nowEpoch - commitEpoch) / 86400);
    },

    async hasNewCommits(branch: string, base: string): Promise<boolean> {
      const count = await runGit(
        ["rev-list", "--count", `${base}..${branch}`],
        cwd,
      );
      return parseInt(count, 10) > 0;
    },
  };
}

export function createAgentRunner(options?: { timeoutMs?: number }): AgentRunner {
  const timeout = options?.timeoutMs ?? 300_000;
  return {
    async isAvailable(): Promise<boolean> {
      try {
        await execFileAsync("claude", ["--version"], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    },

    async run(prompt: string, allowedTools: string[], cwd: string): Promise<void> {
      const args = ["-p", prompt, "--allowedTools", allowedTools.join(",")];
      await execFileAsync("claude", args, { cwd, timeout });
    },
  };
}

// ── Severity helpers ────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function meetsAutoFixThreshold(
  pattern: Pattern,
  config: AutofixActionConfig,
): boolean {
  return (
    pattern.auto_fixable === true &&
    SEVERITY_RANK[pattern.severity] >= SEVERITY_RANK[config.min_severity] &&
    pattern.frequency >= config.min_frequency
  );
}

// ── Fix prompt builder ──────────────────────────────────────────────

// Trust boundary: pattern fields are interpolated into the agent prompt.
// Backticks are stripped to prevent breaking out of the fenced code block.
// Callers should still ensure pattern data comes from trusted sources
// (e.g. local analysis), not from untrusted external input.

function sanitizeForFence(value: string): string {
  return value.replace(/`/g, "");
}

export function buildFixPrompt(pattern: Pattern): string {
  const lines = [
    "You are fixing a detected friction pattern in this codebase.",
    "",
    "## Pattern Details",
    "",
    "```",
    `Description: ${sanitizeForFence(pattern.description)}`,
    `Type: ${sanitizeForFence(pattern.type)}`,
    `Severity: ${sanitizeForFence(pattern.severity)}`,
    `Frequency: ${pattern.frequency} sessions affected`,
    `Trend: ${sanitizeForFence(pattern.trend)}`,
  ];

  if (pattern.root_cause_hypothesis) {
    lines.push(`Root cause hypothesis: ${sanitizeForFence(pattern.root_cause_hypothesis)}`);
  }
  if (pattern.suggested_fix) {
    lines.push(`Suggested fix: ${sanitizeForFence(pattern.suggested_fix)}`);
  }
  if (pattern.affected_files.length > 0) {
    lines.push(`Affected files: ${pattern.affected_files.map(sanitizeForFence).join(", ")}`);
  }

  lines.push("```");

  lines.push("");
  lines.push("## Instructions");
  lines.push("");
  lines.push("1. Read the affected files to understand the current state.");
  lines.push("2. Implement the suggested fix (or your best judgment if the suggestion is insufficient).");
  lines.push("3. Commit your changes with a descriptive message.");
  lines.push("4. Do NOT merge, push, or create a pull request. Only commit locally.");

  return lines.join("\n");
}

// ── Branch name builder ─────────────────────────────────────────────

export function buildBranchName(pattern: Pattern, prefix: string): string {
  return `${prefix}${pattern.id}`;
}

// ── Branch cleanup ──────────────────────────────────────────────────

export async function cleanupExpiredBranches(
  config: AutofixActionConfig,
  options?: {
    /** Provide a custom GitOps instance. When set, `cwd` is ignored. */
    git?: GitOps;
    warn?: (msg: string) => void;
    /** Working directory for the default GitOps. Ignored when `git` is provided. */
    cwd?: string;
  },
): Promise<CleanupResult[]> {
  const git = options?.git ?? createGitOps(options?.cwd);
  const warn = options?.warn ?? console.warn;
  const results: CleanupResult[] = [];

  const branches = await git.listBranches(config.branch_prefix);
  // Hoisted before loop: safe because no checkouts occur within the loop body.
  const currentBranch = await git.currentBranch();

  for (const branch of branches) {
    try {
      const ageDays = await git.branchAge(branch);

      if (ageDays === Infinity) {
        warn(`autofix cleanup: branch ${branch} has unparseable timestamp, treating as expired`);
      }

      if (ageDays >= config.branch_ttl_days) {
        // Don't delete if we're on this branch
        if (currentBranch === branch) {
          results.push({
            branch,
            deleted: false,
            age_days: ageDays,
            reason: "Currently checked out",
          });
          continue;
        }

        await git.deleteBranch(branch);
        warn(`autofix cleanup: deleted expired branch ${branch} (${ageDays} days old)`);
        results.push({ branch, deleted: true, age_days: ageDays });
      } else {
        results.push({ branch, deleted: false, age_days: ageDays });
      }
    } catch (err) {
      warn(`autofix cleanup: failed to process branch ${branch}: ${err}`);
      results.push({
        branch,
        deleted: false,
        age_days: 0,
        reason: `Error: ${err}`,
      });
    }
  }

  return results;
}

// ── Main action ─────────────────────────────────────────────────────

export async function executeAutofixAction(
  patterns: Pattern[],
  config: AutofixActionConfig,
  options?: {
    git?: GitOps;
    agent?: AgentRunner;
    warn?: (msg: string) => void;
    maxPerRun?: number;
    cwd?: string;
  },
): Promise<AutofixResult[]> {
  if (!config.enabled) return [];

  const cwd = options?.cwd ?? process.cwd();
  const git = options?.git ?? createGitOps(cwd);
  const agent = options?.agent ?? createAgentRunner();
  const warn = options?.warn ?? console.warn;
  const maxPerRun = options?.maxPerRun ?? 3;
  const results: AutofixResult[] = [];

  // Safety: skip if working tree is dirty
  const clean = await git.isClean();
  if (!clean) {
    warn("autofix action: working tree is dirty, skipping all fixes");
    return patterns.map((p) => ({
      pattern_id: p.id,
      action: "skipped" as const,
      reason: "Working tree is dirty",
    }));
  }

  // Check agent availability
  const available = await agent.isAvailable();
  if (!available) {
    warn("autofix action: claude CLI not available, skipping");
    return patterns.map((p) => ({
      pattern_id: p.id,
      action: "skipped" as const,
      reason: "claude CLI not available",
    }));
  }

  const originalBranch = await git.currentBranch();
  let fixCount = 0;

  for (const pattern of patterns) {
    if (!meetsAutoFixThreshold(pattern, config)) {
      results.push({
        pattern_id: pattern.id,
        action: "skipped",
        reason: `Below threshold (auto_fixable=${pattern.auto_fixable}, severity=${pattern.severity}, frequency=${pattern.frequency})`,
      });
      continue;
    }

    if (fixCount >= maxPerRun) {
      results.push({
        pattern_id: pattern.id,
        action: "skipped",
        reason: `Run limit reached (${maxPerRun})`,
      });
      continue;
    }

    const branchName = buildBranchName(pattern, config.branch_prefix);

    // Skip if branch already exists (already attempted)
    const exists = await git.branchExists(branchName);
    if (exists) {
      results.push({
        pattern_id: pattern.id,
        action: "skipped",
        branch: branchName,
        reason: "Branch already exists (previously attempted)",
      });
      continue;
    }

    try {
      // Create and switch to fix branch, then run agent
      await git.createAndCheckoutBranch(branchName);
      const prompt = buildFixPrompt(pattern);

      try {
        await agent.run(prompt, config.allowed_tools, cwd);
        fixCount++;
        results.push({
          pattern_id: pattern.id,
          action: "fixed",
          branch: branchName,
        });
      } catch (err) {
        warn(`autofix action: agent failed for pattern ${pattern.id}: ${err}`);
        // Assume commits exist on failure to avoid deleting work
        const hasCommits = await git.hasNewCommits(branchName, originalBranch).catch((e) => {
          warn(`autofix action: hasNewCommits failed, assuming commits exist to preserve work: ${e}`);
          return true;
        });
        // Return to original branch before any branch deletion
        let checkedOut = false;
        try {
          await git.checkoutBranch(originalBranch);
          checkedOut = true;
        } catch {
          warn("autofix action: failed to return to original branch after agent failure");
        }
        if (!hasCommits && checkedOut) {
          await git.deleteBranch(branchName).catch(() => {});
        }
        if (hasCommits) {
          results.push({
            pattern_id: pattern.id,
            action: "skipped",
            branch: branchName,
            reason: `Agent failed; branch retained (has partial commits): ${err}`,
          });
        } else if (checkedOut) {
          results.push({
            pattern_id: pattern.id,
            action: "skipped",
            reason: `Agent failed; branch deleted (no commits): ${err}`,
          });
        } else {
          results.push({
            pattern_id: pattern.id,
            action: "skipped",
            branch: branchName,
            reason: `Agent failed; branch retained (checkout failed): ${err}`,
          });
        }
        continue;
      }

      // Always return to original branch
      await git.checkoutBranch(originalBranch);
    } catch (err) {
      warn(`autofix action: git error for pattern ${pattern.id}: ${err}`);
      results.push({
        pattern_id: pattern.id,
        action: "skipped",
        reason: `Git error: ${err}`,
      });

      // Attempt to return to original branch
      try {
        await git.checkoutBranch(originalBranch);
      } catch {
        warn("autofix action: failed to return to original branch");
      }
    }
  }

  return results;
}
