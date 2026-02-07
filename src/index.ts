export type {
  HarnessType,
  NormalizedEventType,
  NormalizedEvent,
  FrictionSignalType,
  Severity,
  FrictionSignal,
  SessionOutcome,
  SessionFacets,
  Scope,
  SignalRecord,
  PatternTrend,
  PatternType,
  Pattern,
  DelightPattern,
  PatternAnalysis,
  TaggerConfig,
  AnalyzerConfig,
  BeadsActionConfig,
  DigestActionConfig,
  AutofixActionConfig,
  ActionsConfig,
  HarnessConfig,
  HarnessesConfig,
  ScopeRulesConfig,
  Config,
} from "./lib/types.js";

export type { HarnessAdapter } from "./adapters/types.js";
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export type { ClaudeCodeAdapterOptions } from "./adapters/claude-code.js";

export { loadConfig } from "./lib/config.js";
