#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./lib/config.js";
import { createOllamaClient } from "./lib/ollama-client.js";
import { runAnalysis } from "./lib/pattern-analyzer.js";

async function main(): Promise<void> {
  // Belt-and-suspenders: recreate the log directory if it was deleted after
  // install. Note that launchd sets up stdout/stderr file descriptors *before*
  // the process starts, so if the directory is missing at launch time the
  // redirects will already have failed. This only helps when launchd manages
  // to start the process despite the missing directory (observed on some macOS
  // versions). The install script is the primary creator of this directory.
  mkdirSync(join(homedir(), "Library", "Logs", "session-signals"), { recursive: true });

  const config = await loadConfig();

  const client = createOllamaClient({
    baseUrl: config.analyzer.ollama_url,
    defaultModel: config.analyzer.model,
  });

  const results = await runAnalysis(config, client, {
    warn: console.warn,
  });

  // Output results as JSON to stdout for downstream consumption
  const output = {
    timestamp: new Date().toISOString(),
    results: results.map((r) => ({
      scope: r.scope,
      skipped: r.skipped,
      patterns_count: r.analysis.patterns.length,
      analysis: r.analysis,
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error("pattern-analyzer failed:", err);
  process.exit(1);
});
