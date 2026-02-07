#!/usr/bin/env bun

import { loadConfig } from "./lib/config.js";
import { createOllamaClient } from "./lib/ollama-client.js";
import { runAnalysis } from "./lib/pattern-analyzer.js";

async function main(): Promise<void> {
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
