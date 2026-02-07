import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createOllamaClient,
  OllamaConnectionError,
  OllamaParseError,
  OllamaError,
} from "../src/lib/ollama-client.js";

// ── Mock HTTP server ────────────────────────────────────────────────

type Handler = (req: Request) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve> | null = null;
let handler: Handler = () => new Response("not configured", { status: 500 });

function startServer(h: Handler): string {
  handler = h;
  server = Bun.serve({
    port: 0,
    fetch: (req) => handler(req),
  });
  return `http://localhost:${server.port}`;
}

function stopServer(): void {
  if (server) {
    server.stop(true);
    server = null;
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe("OllamaClient", () => {
  afterEach(() => {
    stopServer();
  });

  // ── isAvailable ─────────────────────────────────────────────

  describe("isAvailable", () => {
    it("returns true when Ollama is running", async () => {
      const url = startServer((req) => {
        if (new URL(req.url).pathname === "/api/tags") {
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      expect(await client.isAvailable()).toBe(true);
    });

    it("returns false when Ollama is not reachable", async () => {
      const client = createOllamaClient({
        baseUrl: "http://localhost:19999",
        defaultModel: "llama3.2",
        timeoutMs: 500,
      });
      expect(await client.isAvailable()).toBe(false);
    });

    it("returns false when Ollama returns error", async () => {
      const url = startServer(() => new Response("error", { status: 500 }));
      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      expect(await client.isAvailable()).toBe(false);
    });
  });

  // ── generate ────────────────────────────────────────────────

  describe("generate", () => {
    it("sends correct request body", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const url = startServer(async (req) => {
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ response: "hello" });
      });

      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      await client.generate("test prompt");

      expect(capturedBody).not.toBeNull();
      expect(capturedBody!["model"]).toBe("llama3.2");
      expect(capturedBody!["prompt"]).toBe("test prompt");
      expect(capturedBody!["stream"]).toBe(false);
    });

    it("uses custom model when specified", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const url = startServer(async (req) => {
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ response: "hi" });
      });

      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      await client.generate("test", { model: "mistral" });

      expect(capturedBody!["model"]).toBe("mistral");
    });

    it("includes format json when specified", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const url = startServer(async (req) => {
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ response: "{}" });
      });

      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      await client.generate("test", { format: "json" });

      expect(capturedBody!["format"]).toBe("json");
    });

    it("returns response text", async () => {
      const url = startServer(() => Response.json({ response: "the answer is 42" }));
      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      const result = await client.generate("what is the answer?");
      expect(result).toBe("the answer is 42");
    });

    it("retries on failure then succeeds", async () => {
      let attempts = 0;

      const url = startServer(() => {
        attempts++;
        if (attempts < 3) {
          return new Response("error", { status: 500 });
        }
        return Response.json({ response: "success after retries" });
      });

      const client = createOllamaClient({
        baseUrl: url,
        defaultModel: "llama3.2",
        maxRetries: 3,
      });
      const result = await client.generate("test");
      expect(result).toBe("success after retries");
      expect(attempts).toBe(3);
    });

    it("throws after exhausting retries", async () => {
      const url = startServer(() => new Response("error", { status: 500 }));

      const client = createOllamaClient({
        baseUrl: url,
        defaultModel: "llama3.2",
        maxRetries: 2,
      });

      await expect(client.generate("test")).rejects.toThrow(OllamaError);
    });

    it("throws OllamaConnectionError when server unreachable", async () => {
      const client = createOllamaClient({
        baseUrl: "http://localhost:19999",
        defaultModel: "llama3.2",
        maxRetries: 1,
        timeoutMs: 500,
      });

      await expect(client.generate("test")).rejects.toThrow(OllamaConnectionError);
    });

    it("throws when response is missing 'response' field", async () => {
      const url = startServer(() => Response.json({ bad_field: "oops" }));

      const client = createOllamaClient({
        baseUrl: url,
        defaultModel: "llama3.2",
        maxRetries: 1,
      });

      await expect(client.generate("test")).rejects.toThrow("missing 'response' field");
    });
  });

  // ── generateJSON ────────────────────────────────────────────

  describe("generateJSON", () => {
    it("parses JSON response", async () => {
      const url = startServer(() =>
        Response.json({ response: JSON.stringify({ answer: 42, items: ["a", "b"] }) }),
      );

      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      const result = await client.generateJSON<{ answer: number; items: string[] }>("give json");
      expect(result.answer).toBe(42);
      expect(result.items).toEqual(["a", "b"]);
    });

    it("requests json format", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const url = startServer(async (req) => {
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ response: "{}" });
      });

      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      await client.generateJSON("test");

      expect(capturedBody!["format"]).toBe("json");
    });

    it("retries once on JSON parse failure then succeeds", async () => {
      let calls = 0;

      const url = startServer(() => {
        calls++;
        if (calls <= 1) {
          // First call: return invalid JSON in the response field
          return Response.json({ response: "not valid json" });
        }
        // Retry: return valid JSON
        return Response.json({ response: JSON.stringify({ ok: true }) });
      });

      const client = createOllamaClient({
        baseUrl: url,
        defaultModel: "llama3.2",
        maxRetries: 3,
      });
      const result = await client.generateJSON<{ ok: boolean }>("test");
      expect(result.ok).toBe(true);
    });

    it("throws OllamaParseError when JSON is persistently invalid", async () => {
      const url = startServer(() =>
        Response.json({ response: "this is not json at all" }),
      );

      const client = createOllamaClient({
        baseUrl: url,
        defaultModel: "llama3.2",
        maxRetries: 3,
      });

      try {
        await client.generateJSON("test");
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(OllamaParseError);
        expect((err as OllamaParseError).rawResponse).toBe("this is not json at all");
      }
    });

    it("uses custom model", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const url = startServer(async (req) => {
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ response: "{}" });
      });

      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      await client.generateJSON("test", { model: "codellama" });

      expect(capturedBody!["model"]).toBe("codellama");
    });
  });

  // ── Edge cases ──────────────────────────────────────────────

  describe("edge cases", () => {
    it("strips trailing slashes from baseUrl", async () => {
      let requestUrl = "";

      const url = startServer((req) => {
        requestUrl = req.url;
        return Response.json({ response: "ok" });
      });

      const client = createOllamaClient({ baseUrl: url + "///", defaultModel: "llama3.2" });
      await client.generate("test");

      expect(requestUrl).toContain("/api/generate");
      expect(requestUrl).not.toContain("////api");
    });

    it("handles empty response string", async () => {
      const url = startServer(() => Response.json({ response: "" }));
      const client = createOllamaClient({ baseUrl: url, defaultModel: "llama3.2" });
      const result = await client.generate("test");
      expect(result).toBe("");
    });
  });
});
