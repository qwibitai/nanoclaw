import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = "---NANOCLAW_OUTPUT_START---";
const OUTPUT_END_MARKER = "---NANOCLAW_OUTPUT_END---";

// Mock config
vi.mock("./config.js", () => ({
  CONTAINER_IMAGE: "nanoclaw-agent:latest",
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: "/tmp/nanoclaw-test-data",
  GROUPS_DIR: "/tmp/nanoclaw-test-groups",
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: "America/Los_Angeles",
}));

// Mock logger
vi.mock("./logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ""),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock("./mount-security.js", () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { spawn } from "child_process";
import { runContainerAgent, ContainerOutput } from "./container-runner.js";
import type { RegisteredGroup } from "./types.js";

const testGroup: RegisteredGroup = {
  name: "Test Group",
  folder: "test-group",
  trigger: "@Andy",
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: "Hello",
  groupFolder: "test-group",
  chatJid: "test@g.us",
  isMain: false,
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe("container-runner tanren passthrough", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes TANREN_API_URL env var when tanren config is provided", async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        isMain: true,
        tanren: { apiUrl: "http://tanren:8000", apiKey: "key-123" },
      },
      () => {},
    );

    // Check spawn args include TANREN_API_URL
    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envIdx = spawnArgs.indexOf("TANREN_API_URL=http://tanren:8000");
    expect(envIdx).toBeGreaterThan(-1);
    // The -e flag should precede the env var
    expect(spawnArgs[envIdx - 1]).toBe("-e");

    // Clean up: emit close
    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("does NOT pass TANREN_API_URL when tanren config is absent", async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const hasTanren = spawnArgs.some((arg) => arg.includes("TANREN_API_URL"));
    expect(hasTanren).toBe(false);

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("includes tanren config in stdin JSON when provided", async () => {
    const tanrenConfig = { apiUrl: "http://tanren:8000", apiKey: "key-123" };
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, isMain: true, tanren: tanrenConfig },
      () => {},
    );

    // Read what was written to stdin
    const stdinData = (fakeProc.stdin as PassThrough).read();
    if (stdinData) {
      const parsed = JSON.parse(stdinData.toString());
      expect(parsed.tanren).toEqual(tanrenConfig);
    }

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

describe("container-runner timeout behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("timeout after output resolves as success", async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: "success",
      result: "Here is my response",
      newSessionId: "session-123",
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit("close", 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe("success");
    expect(result.newSessionId).toBe("session-123");
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: "Here is my response" }),
    );
  });

  it("timeout with no output resolves as error", async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit("close", 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe("error");
    expect(result.error).toContain("timed out");
    expect(onOutput).not.toHaveBeenCalled();
  });

  it("normal exit after output resolves as success", async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // Emit output
    emitOutputMarker(fakeProc, {
      status: "success",
      result: "Done",
      newSessionId: "session-456",
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit("close", 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe("success");
    expect(result.newSessionId).toBe("session-456");
  });
});
