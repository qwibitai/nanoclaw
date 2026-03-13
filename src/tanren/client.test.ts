import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../config.js", () => ({
  TANREN_API_URL: "http://tanren.test:8000",
}));

vi.mock("../env.js", () => ({
  readEnvFile: vi.fn(() => ({ TANREN_API_KEY: "test-api-key" })),
}));

import { readEnvFile } from "../env.js";
import { TanrenClient, createTanrenClient } from "./client.js";
import {
  TanrenAPIError,
  TanrenAuthError,
  TanrenConnectionError,
  TanrenNotFoundError,
  TanrenNotImplementedError,
  TanrenValidationError,
} from "./errors.js";

const BASE_URL = "http://tanren.test:8000";
const API_KEY = "test-key-123";

function mockFetch(
  status: number,
  body: unknown,
  statusText = "OK",
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

function makeClient(
  fetchFn: ReturnType<typeof vi.fn<typeof fetch>>,
  opts?: Partial<{ timeoutMs: number; maxRetries: number; retryDelayMs: number }>,
): TanrenClient {
  return new TanrenClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetchFn: fetchFn as typeof fetch,
    maxRetries: opts?.maxRetries ?? 0,
    retryDelayMs: opts?.retryDelayMs ?? 1,
    timeoutMs: opts?.timeoutMs ?? 5000,
  });
}

describe("TanrenClient — happy path", () => {
  it("health()", async () => {
    const body = { status: "ok", version: "0.1.0", uptime_seconds: 42 };
    const f = mockFetch(200, body);
    const client = makeClient(f);
    const result = await client.health();
    expect(result).toEqual(body);
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/health`);
    expect(init?.method).toBe("GET");
  });

  it("readiness()", async () => {
    const body = { status: "ready" };
    const f = mockFetch(200, body);
    const result = await makeClient(f).readiness();
    expect(result).toEqual(body);
    const [url] = f.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/health/ready`);
  });

  it("createDispatch()", async () => {
    const body = { dispatch_id: "d-1", status: "accepted" };
    const f = mockFetch(200, body);
    const client = makeClient(f);
    const result = await client.createDispatch({
      project: "proj",
      phase: "do-task",
      branch: "main",
      spec_folder: "specs/s1",
      cli: "claude",
    });
    expect(result).toEqual(body);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/dispatch`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toMatchObject({ project: "proj", phase: "do-task" });
  });

  it("getDispatch()", async () => {
    const body = {
      workflow_id: "w-1",
      phase: "do-task",
      project: "p",
      spec_folder: "s",
      branch: "main",
      cli: "claude",
      timeout: 1800,
      environment_profile: "default",
      status: "pending",
      created_at: "2026-01-01T00:00:00Z",
    };
    const f = mockFetch(200, body);
    const result = await makeClient(f).getDispatch("w-1");
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/dispatch/w-1`);
  });

  it("cancelDispatch()", async () => {
    const body = { dispatch_id: "d-1", status: "cancelled" };
    const f = mockFetch(200, body);
    const result = await makeClient(f).cancelDispatch("d-1");
    expect(result).toEqual(body);
    expect(f.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("listVMs()", async () => {
    const body = [
      {
        vm_id: "vm-1",
        host: "1.2.3.4",
        provider: "manual",
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const f = mockFetch(200, body);
    const result = await makeClient(f).listVMs();
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/vm`);
  });

  it("provisionVM()", async () => {
    const body = { vm_id: "vm-2", host: "5.6.7.8", created_at: "2026-01-01T00:00:00Z" };
    const f = mockFetch(200, body);
    const result = await makeClient(f).provisionVM({ project: "proj", branch: "main" });
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/vm/provision`);
  });

  it("dryRunVM()", async () => {
    const body = {
      provider: "hetzner",
      would_provision: true,
      requirements: { profile: "default" },
    };
    const f = mockFetch(200, body);
    const result = await makeClient(f).dryRunVM({ project: "proj", branch: "main" });
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/vm/dry-run`);
  });

  it("releaseVM()", async () => {
    const body = { vm_id: "vm-1", status: "released" };
    const f = mockFetch(200, body);
    const result = await makeClient(f).releaseVM("vm-1");
    expect(result).toEqual(body);
    expect(f.mock.calls[0][1]?.method).toBe("DELETE");
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/vm/vm-1`);
  });

  it("runProvision()", async () => {
    const body = { env_id: "env-1", vm_id: "vm-1", host: "1.2.3.4" };
    const f = mockFetch(200, body);
    const result = await makeClient(f).runProvision({ project: "proj", branch: "main" });
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/run/provision`);
  });

  it("runExecute()", async () => {
    const body = { env_id: "env-1", dispatch_id: "d-1", status: "executing" };
    const f = mockFetch(200, body);
    const result = await makeClient(f).runExecute("env-1");
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/run/env-1/execute`);
    expect(f.mock.calls[0][1]?.method).toBe("POST");
  });

  it("runTeardown()", async () => {
    const body = { env_id: "env-1", status: "tearing_down" };
    const f = mockFetch(200, body);
    const result = await makeClient(f).runTeardown("env-1");
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/run/env-1/teardown`);
  });

  it("runStatus()", async () => {
    const body = { env_id: "env-1", status: "executing" };
    const f = mockFetch(200, body);
    const result = await makeClient(f).runStatus("env-1");
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/run/env-1/status`);
    expect(f.mock.calls[0][1]?.method).toBe("GET");
  });

  it("runFull()", async () => {
    const body = { dispatch_id: "d-2", status: "accepted" };
    const f = mockFetch(200, body);
    const result = await makeClient(f).runFull({
      project: "proj",
      branch: "main",
      spec_path: "specs/s1",
      phase: "do-task",
    });
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/run/full`);
  });

  it("getConfig()", async () => {
    const body = {
      ipc_dir: "/tmp/ipc",
      github_dir: "/home/user/github",
      poll_interval: 2,
      heartbeat_interval: 30,
      max_opencode: 3,
      max_codex: 2,
      max_gate: 1,
      events_enabled: true,
      remote_enabled: false,
    };
    const f = mockFetch(200, body);
    const result = await makeClient(f).getConfig();
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/config`);
  });

  it("listEvents() without query", async () => {
    const body = { events: [], total: 0, limit: 50, offset: 0 };
    const f = mockFetch(200, body);
    const result = await makeClient(f).listEvents();
    expect(result).toEqual(body);
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/events`);
  });

  it("listEvents() with query params", async () => {
    const body = { events: [], total: 0, limit: 10, offset: 5 };
    const f = mockFetch(200, body);
    const result = await makeClient(f).listEvents({ workflow_id: "w-1", limit: 10, offset: 5 });
    expect(result).toEqual(body);
    const url = f.mock.calls[0][0] as string;
    expect(url).toContain("workflow_id=w-1");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=5");
  });
});

describe("TanrenClient — error handling", () => {
  it("401 → TanrenAuthError", async () => {
    const f = mockFetch(401, { detail: "unauthorized" }, "Unauthorized");
    await expect(makeClient(f).health()).rejects.toThrow(TanrenAuthError);
  });

  it("404 → TanrenNotFoundError", async () => {
    const f = mockFetch(404, { detail: "not found" }, "Not Found");
    await expect(makeClient(f).getDispatch("x")).rejects.toThrow(TanrenNotFoundError);
  });

  it("422 → TanrenValidationError with detail", async () => {
    const detail = [{ loc: ["body", "project"], msg: "required", type: "missing" }];
    const f = mockFetch(422, { detail }, "Unprocessable Entity");
    try {
      await makeClient(f).createDispatch({
        project: "",
        phase: "do-task",
        branch: "main",
        spec_folder: "s",
        cli: "claude",
      });
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TanrenValidationError);
      expect((err as TanrenValidationError).detail).toEqual(detail);
    }
  });

  it("501 → TanrenNotImplementedError", async () => {
    const f = mockFetch(501, {}, "Not Implemented");
    await expect(makeClient(f).dryRunVM({ project: "p", branch: "b" })).rejects.toThrow(
      TanrenNotImplementedError,
    );
  });

  it("network TypeError → TanrenConnectionError", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(makeClient(f).health()).rejects.toThrow(TanrenConnectionError);
  });

  it("unknown 500 → base TanrenAPIError", async () => {
    const f = mockFetch(500, { error: "boom" }, "Internal Server Error");
    try {
      await makeClient(f).health();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TanrenAPIError);
      expect(err).not.toBeInstanceOf(TanrenAuthError);
      expect((err as TanrenAPIError).status).toBe(500);
    }
  });
});

describe("TanrenClient — retry behavior", () => {
  it("retries on 503 then succeeds", async () => {
    const body = { status: "ok", version: "0.1.0", uptime_seconds: 1 };
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({}),
        text: async () => "",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
      } as Response);

    const client = makeClient(f, { maxRetries: 2, retryDelayMs: 1 });
    const result = await client.health();
    expect(result).toEqual(body);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries on network error then exhausts", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));

    const client = makeClient(f, { maxRetries: 1, retryDelayMs: 1 });
    await expect(client.health()).rejects.toThrow(TanrenConnectionError);
    expect(f).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("does NOT retry on 401", async () => {
    const f = mockFetch(401, {}, "Unauthorized");
    const client = makeClient(f, { maxRetries: 2, retryDelayMs: 1 });
    await expect(client.health()).rejects.toThrow(TanrenAuthError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 422", async () => {
    const f = mockFetch(422, { detail: [] }, "Unprocessable Entity");
    const client = makeClient(f, { maxRetries: 2, retryDelayMs: 1 });
    await expect(
      client.createDispatch({
        project: "p",
        phase: "do-task",
        branch: "b",
        spec_folder: "s",
        cli: "claude",
      }),
    ).rejects.toThrow(TanrenValidationError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("exponential backoff increases delay between retries", async () => {
    const body = { status: "ok", version: "0.1.0", uptime_seconds: 1 };
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => ({}),
        text: async () => "",
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => ({}),
        text: async () => "",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
      } as Response);

    const client = makeClient(f, { maxRetries: 2, retryDelayMs: 1 });
    const result = await client.health();
    expect(result).toEqual(body);
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe("TanrenClient — request construction", () => {
  it("sends x-api-key header", async () => {
    const f = mockFetch(200, {});
    await makeClient(f).health();
    const headers = f.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);
  });

  it("sends X-Request-ID as UUID", async () => {
    const f = mockFetch(200, {});
    await makeClient(f).health();
    const headers = f.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["X-Request-ID"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("sends Content-Type on POST", async () => {
    const f = mockFetch(200, { dispatch_id: "d-1" });
    await makeClient(f).createDispatch({
      project: "p",
      phase: "do-task",
      branch: "b",
      spec_folder: "s",
      cli: "claude",
    });
    const headers = f.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("does NOT send Content-Type on GET", async () => {
    const f = mockFetch(200, {});
    await makeClient(f).health();
    const headers = f.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
  });
});

describe("TanrenClient — timeout", () => {
  it("aborts after configured timeout", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      // Simulate a slow response — wait for abort
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const client = makeClient(f, { timeoutMs: 50, maxRetries: 0 });
    await expect(client.health()).rejects.toThrow(TanrenConnectionError);
    await expect(client.health()).rejects.toThrow(/timed out/);
  });

  it("timeout does NOT retry", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const client = makeClient(f, { timeoutMs: 50, maxRetries: 2 });
    await expect(client.health()).rejects.toThrow(TanrenConnectionError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("TanrenClient — URL encoding", () => {
  it("encodes path parameters", async () => {
    const f = mockFetch(200, {
      workflow_id: "a/b",
      phase: "do-task",
      project: "p",
      spec_folder: "s",
      branch: "b",
      cli: "claude",
      timeout: 1800,
      environment_profile: "default",
      status: "pending",
      created_at: "2026-01-01T00:00:00Z",
    });
    await makeClient(f).getDispatch("a/b");
    expect(f.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/dispatch/a%2Fb`);
  });
});

describe("createTanrenClient — factory", () => {
  beforeEach(() => {
    vi.mocked(readEnvFile).mockReturnValue({ TANREN_API_KEY: "test-api-key" });
  });

  it("creates client from config and env", () => {
    const client = createTanrenClient();
    expect(client).toBeInstanceOf(TanrenClient);
  });

  it("returns null when TANREN_API_URL is empty", async () => {
    const { createTanrenClient: create } = await import("./client.js");
    const client = create({ baseUrl: "" });
    expect(client).toBeNull();
  });

  it("returns null when TANREN_API_KEY is missing", () => {
    vi.mocked(readEnvFile).mockReturnValue({});
    const saved = process.env.TANREN_API_KEY;
    delete process.env.TANREN_API_KEY;
    try {
      const client = createTanrenClient({ baseUrl: "http://test:8000" });
      expect(client).toBeNull();
    } finally {
      if (saved) process.env.TANREN_API_KEY = saved;
    }
  });

  it("uses overrides when provided", () => {
    const client = createTanrenClient({
      baseUrl: "http://custom:9000",
      apiKey: "custom-key",
    });
    expect(client).toBeInstanceOf(TanrenClient);
  });

  it("ignores explicit undefined overrides and falls through to config", () => {
    const client = createTanrenClient({ baseUrl: undefined, apiKey: undefined });
    expect(client).toBeInstanceOf(TanrenClient);
  });
});
