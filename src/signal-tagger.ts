#!/usr/bin/env bun

import { loadConfig } from "./lib/config.js";
import {
  isHookInput,
  detectHarness,
  createAdapter,
  buildSignalRecord,
  writeSignalRecord,
} from "./lib/tagger.js";

async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return;

  const parsed: unknown = JSON.parse(raw);
  if (!isHookInput(parsed)) return;

  const config = await loadConfig();
  const harness = detectHarness(parsed, config);
  if (!harness) return;

  const adapter = createAdapter(harness, config);
  if (!adapter) return;

  const events = await adapter.getSessionEvents(parsed.session_id);
  if (events.length === 0) return;

  const cwdFromEvents = parsed.cwd ?? events.find((e) => e.cwd)?.cwd;
  if (!cwdFromEvents && process.env["ROBOREV_DEBUG"]) {
    console.error("[signal-tagger] no cwd in hook input or events, falling back to process.cwd()");
  }
  const cwd = cwdFromEvents ?? process.cwd();
  const record = buildSignalRecord(parsed.session_id, events, config, cwd);

  await writeSignalRecord(record);
}

// Silent failure — never block the coding agent
main().catch((err) => {
  if (process.env["ROBOREV_DEBUG"]) {
    console.error("[signal-tagger]", err);
  }
});
