// ── Types ────────────────────────────────────────────────────────────

export interface OllamaGenerateOptions {
  model?: string;
  format?: "json";
}

export interface OllamaClient {
  generate(prompt: string, options?: OllamaGenerateOptions): Promise<string>;
  generateJSON<T>(prompt: string, options?: { model?: string }): Promise<T>;
  isAvailable(): Promise<boolean>;
}

export interface OllamaClientOptions {
  baseUrl: string;
  defaultModel: string;
  timeoutMs?: number;
  maxRetries?: number;
}

// ── Error types ─────────────────────────────────────────────────────

export class OllamaError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

export class OllamaConnectionError extends OllamaError {
  constructor(cause?: unknown) {
    super("Ollama is not reachable", cause);
    this.name = "OllamaConnectionError";
  }
}

export class OllamaParseError extends OllamaError {
  constructor(
    public readonly rawResponse: string,
    cause?: unknown,
  ) {
    super("Failed to parse Ollama JSON response", cause);
    this.name = "OllamaParseError";
  }
}

// ── Implementation ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOllamaClient(options: OllamaClientOptions): OllamaClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const defaultModel = options.defaultModel;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function generate(prompt: string, options?: OllamaGenerateOptions): Promise<string> {
    const model = options?.model ?? defaultModel;
    const body: Record<string, unknown> = {
      model,
      prompt,
      stream: false,
    };
    if (options?.format === "json") {
      body["format"] = "json";
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
      }

      try {
        const response = await fetchWithTimeout(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new OllamaError(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as Record<string, unknown>;
        const text = data["response"];
        if (typeof text !== "string") {
          throw new OllamaError("Ollama response missing 'response' field");
        }

        return text;
      } catch (err) {
        lastError = err;

        // Don't retry on non-retryable errors
        if (err instanceof OllamaError && !(err instanceof OllamaConnectionError)) {
          // HTTP errors that aren't connection issues — retry
        }

        // Connection errors — check if it's a fetch/abort issue
        if (err instanceof TypeError || (err instanceof DOMException && err.name === "AbortError")) {
          lastError = new OllamaConnectionError(err);
        }
      }
    }

    throw lastError instanceof OllamaError
      ? lastError
      : new OllamaConnectionError(lastError);
  }

  async function generateJSON<T>(prompt: string, options?: { model?: string }): Promise<T> {
    const opts: OllamaGenerateOptions = { format: "json" };
    if (options?.model) opts.model = options.model;

    const raw = await generate(prompt, opts);

    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      // Retry once for JSON parse failures
      try {
        const retry = await generate(prompt, opts);
        return JSON.parse(retry) as T;
      } catch (retryErr) {
        throw new OllamaParseError(raw, retryErr);
      }
    }
  }

  async function isAvailable(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/tags`, {
        method: "GET",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return { generate, generateJSON, isAvailable };
}
