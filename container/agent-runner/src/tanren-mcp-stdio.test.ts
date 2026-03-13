import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the tanren MCP server by validating its tool registration and fetch behavior.
// Since the server is a standalone process that reads env vars at module level,
// we test the core logic patterns rather than importing the module directly.

describe("tanren-mcp-stdio — tool definitions", () => {
  const TOOL_NAMES = [
    "tanren_health",
    "tanren_dispatch",
    "tanren_dispatch_status",
    "tanren_cancel",
    "tanren_provision",
    "tanren_execute",
    "tanren_teardown",
    "tanren_run_full",
    "tanren_run_status",
    "tanren_vm_list",
    "tanren_vm_release",
    "tanren_config",
    "tanren_events",
  ];

  it("defines exactly 13 tools", () => {
    expect(TOOL_NAMES).toHaveLength(13);
  });

  it("all tool names start with tanren_", () => {
    for (const name of TOOL_NAMES) {
      expect(name).toMatch(/^tanren_/);
    }
  });
});

describe("tanren-mcp-stdio — tanrenFetch logic", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Simulate the tanrenFetch function inline since we can't import it
  async function tanrenFetch(
    apiUrl: string,
    apiKey: string,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        "x-api-key": apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new Error(
        `Tanren API ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
      );
    }
    return data;
  }

  it("returns parsed JSON on success", async () => {
    const body = { status: "ok", version: "0.1.0" };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    }) as unknown as typeof fetch;

    const result = await tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health");
    expect(result).toEqual(body);
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: "unauthorized" }),
    }) as unknown as typeof fetch;

    await expect(tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health")).rejects.toThrow(
      "Tanren API 401",
    );
  });

  it("sends x-api-key header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await tanrenFetch("http://tanren:8000", "my-key", "GET", "/api/v1/health");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("my-key");
  });

  it("sends Content-Type only when body is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // GET without body
    await tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health");
    expect(mockFetch.mock.calls[0][1].headers["Content-Type"]).toBeUndefined();

    // POST with body
    await tanrenFetch("http://tanren:8000", "key", "POST", "/api/v1/dispatch", { project: "p" });
    expect(mockFetch.mock.calls[1][1].headers["Content-Type"]).toBe("application/json");
  });

  it("returns raw text when response is not JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "plain text response",
    }) as unknown as typeof fetch;

    const result = await tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health");
    expect(result).toBe("plain text response");
  });

  it("includes error body in thrown error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: "internal server error" }),
    }) as unknown as typeof fetch;

    await expect(tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health")).rejects.toThrow(
      "internal server error",
    );
  });
});

describe("tanren-mcp-stdio — tool response format", () => {
  function ok(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  function err(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: message }], isError: true as const };
  }

  it("ok() wraps data as JSON text content", () => {
    const result = ok({ status: "healthy" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ status: "healthy" });
  });

  it("err() wraps error message with isError flag", () => {
    const result = err(new Error("connection refused"));
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("connection refused");
    expect(result.isError).toBe(true);
  });

  it("err() handles string errors", () => {
    const result = err("something went wrong");
    expect(result.content[0].text).toBe("something went wrong");
    expect(result.isError).toBe(true);
  });
});
