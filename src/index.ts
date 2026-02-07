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
export { GeminiCliAdapter } from "./adapters/gemini-cli.js";
export type { GeminiCliAdapterOptions } from "./adapters/gemini-cli.js";
export { PiCodingAgentAdapter } from "./adapters/pi-coding-agent.js";
export type { PiCodingAgentAdapterOptions } from "./adapters/pi-coding-agent.js";

export { loadConfig } from "./lib/config.js";

export type { HookInput } from "./lib/tagger.js";
export {
  isHookInput,
  detectHarness,
  createAdapter,
  resolveScope,
  collectSignals,
  buildSignalRecord,
  signalsOutputDir,
  signalsFilePath,
  writeSignalRecord,
} from "./lib/tagger.js";

export {
  levenshteinRatio,
  detectRephraseStorm,
  detectToolFailureCascade,
  detectContextChurn,
  detectPermissionFriction,
  detectAbandonSignal,
  detectLongStall,
  detectRetryLoop,
  inferLanguages,
  classifyOutcome,
  extractFacets,
} from "./lib/heuristics.js";
