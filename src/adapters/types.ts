import type { HarnessType, NormalizedEvent } from "../lib/types.js";

/**
 * Minimal interface that every harness adapter must implement.
 * Each adapter translates a harness's native event format into NormalizedEvents.
 */
export interface HarnessAdapter {
  /**
   * Parse raw event data (e.g. JSONL file contents) into normalized events.
   */
  parseEvents(raw: string): NormalizedEvent[];

  /**
   * Retrieve all normalized events for a specific session.
   * Implementations may read from files, databases, or APIs.
   */
  getSessionEvents(sessionId: string): NormalizedEvent[] | Promise<NormalizedEvent[]>;

  /**
   * Returns which harness this adapter handles.
   */
  getEventSource(): HarnessType;
}
