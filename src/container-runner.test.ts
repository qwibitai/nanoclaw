import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = "---NANOCLAW_OUTPUT_START---";
const OUTPUT_END_MARKER = "---NANOCLAW_OUTPUT_END---";

// Mutable mock data — override per-test via direct assignment
const mockConfig = vi.hoisted(() => ({
  CONTAINER_HOST_CONFIG_DIR: "",
  CONTAINER_HOST_DATA_DIR: "",
  CONTAINER_IMAGE: "nanoclaw-agent:latest",
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: "/tmp/nanoclaw-test-data",
  GROUPS_DIR: "/tmp/nanoclaw-test-groups",
  IDLE_TIMEOUT: 1800000, // 30min
  INSTANCE_ID: "test1234",
  TIMEZONE: "America/Los_Angeles",
  APP_DIR: "/tmp/nanoclaw-test-app",
}));

const mockRuntime = vi.hoisted(() => ({
  CREDENTIAL_PROXY_EXTERNAL_URL: "",
  AGENT_NETWORK: "",
  CONTAINER_HOST_GATEWAY: "host.docker.internal",
  CONTAINER_RUNTIME_BIN: "docker",
  hostGatewayArgs: () => [] as string[],
  readonlyMountArgs: (h: string, c: string) => ["-v", `${h}:${c}:ro`],
  stopContainer: (name: string) => `docker stop ${name}`,
}));

const mockRuntimePaths = vi.hoisted(() => ({
  APP_DIR: "/tmp/nanoclaw-test-app",
  CONFIG_ROOT: "/tmp/nanoclaw-test-groups",
  DATA_DIR: "/tmp/nanoclaw-test-data",
}));

// Mock config
vi.mock("./config.js", () => mockConfig);

// Mock runtime-paths
vi.mock("./runtime-paths.js", () => mockRuntimePaths);

// Mock container-runtime — return the hoisted object directly so property
// mutations in individual tests are visible to the module under test.
vi.mock("./container-runtime.js", () => mockRuntime);

// Mock credential-proxy
vi.mock("./credential-proxy.js", () => ({
  detectAuthMode: () => "api-key",
}));

// Mock auth-circuit-breaker
vi.mock("./auth-circuit-breaker.js", () => ({
  isAuthError: vi.fn(() => false),
  recordAuthFailure: vi.fn(),
  recordAuthSuccess: vi.fn(),
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
      cpSync: vi.fn(),
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
import fs from "fs";
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

/** Reset mutable mock values to defaults between tests */
function resetMocks() {
  mockConfig.CONTAINER_HOST_CONFIG_DIR = "";
  mockConfig.CONTAINER_HOST_DATA_DIR = "";
  mockConfig.CONTAINER_IMAGE = "nanoclaw-agent:latest";
  mockConfig.CONTAINER_MAX_OUTPUT_SIZE = 10485760;
  mockConfig.CONTAINER_TIMEOUT = 1800000;
  mockConfig.CREDENTIAL_PROXY_PORT = 3001;
  mockConfig.DATA_DIR = "/tmp/nanoclaw-test-data";
  mockConfig.GROUPS_DIR = "/tmp/nanoclaw-test-groups";
  mockConfig.IDLE_TIMEOUT = 1800000;
  mockConfig.INSTANCE_ID = "test1234";
  mockConfig.TIMEZONE = "America/Los_Angeles";
  mockConfig.APP_DIR = "/tmp/nanoclaw-test-app";

  mockRuntime.CREDENTIAL_PROXY_EXTERNAL_URL = "";
  mockRuntime.AGENT_NETWORK = "";
  mockRuntime.CONTAINER_HOST_GATEWAY = "host.docker.internal";
  mockRuntime.CONTAINER_RUNTIME_BIN = "docker";

  mockRuntimePaths.APP_DIR = "/tmp/nanoclaw-test-app";
  mockRuntimePaths.CONFIG_ROOT = "/tmp/nanoclaw-test-groups";
  mockRuntimePaths.DATA_DIR = "/tmp/nanoclaw-test-data";
}

describe("container-runner tanren passthrough", () => {
  beforeEach(() => {
    resetMocks();
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
    expect(stdinData).not.toBeNull();
    const parsed = JSON.parse(stdinData!.toString());
    expect(parsed.tanren).toEqual(tanrenConfig);

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

describe("container-runner instance label", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds nanoclaw.instance label to spawn args", async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const labelIdx = spawnArgs.indexOf("nanoclaw.instance=test1234");
    expect(labelIdx).toBeGreaterThan(-1);
    expect(spawnArgs[labelIdx - 1]).toBe("--label");

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

describe("container-runner timeout behavior", () => {
  beforeEach(() => {
    resetMocks();
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

describe("container-runner agent-runner sync", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.cpSync).mockClear();
    vi.mocked(fs.mkdirSync).mockClear();
    vi.mocked(fs.statSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs new upstream files without overwriting existing ones", async () => {
    // Simulate: agent-runner source has 3 files, session dir already has 2 of them
    const existingFiles = new Set([
      "/tmp/nanoclaw-test-data/sessions/test-group/agent-runner-src/agent.ts",
      "/tmp/nanoclaw-test-data/sessions/test-group/agent-runner-src/tools.ts",
    ]);

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      // agent-runner source dir exists
      if (s.endsWith("container/agent-runner/src")) return true;
      // skills source dir — not relevant for this test
      if (s.includes("container/skills")) return false;
      // global dir
      if (s.endsWith("/global")) return false;
      // .env file
      if (s.endsWith(".env")) return false;
      // settings.json doesn't exist yet (let it be created)
      if (s.endsWith("settings.json")) return false;
      // Existing files in session dir
      if (existingFiles.has(s)) return true;
      // New file doesn't exist yet
      if (s.endsWith("tanren-mcp-stdio.ts")) return false;
      return false;
    });

    vi.mocked(fs.readdirSync).mockImplementation(((p: fs.PathLike) => {
      const s = p.toString();
      if (s.endsWith("container/agent-runner/src")) {
        return ["agent.ts", "tools.ts", "tanren-mcp-stdio.ts"];
      }
      if (s.includes("container/skills")) {
        return [];
      }
      return [];
    }) as typeof fs.readdirSync);

    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // Only the new file should be copied
    const cpCalls = vi.mocked(fs.cpSync).mock.calls;
    const copiedFiles = cpCalls
      .filter(([src]) => src.toString().includes("agent-runner"))
      .map(([src]) => src.toString());

    expect(copiedFiles).toHaveLength(1);
    expect(copiedFiles[0]).toContain("tanren-mcp-stdio.ts");

    // Existing files should NOT have been overwritten
    expect(copiedFiles.some((f) => f.endsWith("agent.ts"))).toBe(false);
    expect(copiedFiles.some((f) => f.endsWith("tools.ts"))).toBe(false);

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

describe("container-runner AGENT_NETWORK", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT include --network flag when AGENT_NETWORK is empty", async () => {
    mockRuntime.AGENT_NETWORK = "";
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain("--network");

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("includes --network flag when AGENT_NETWORK is set", async () => {
    mockRuntime.AGENT_NETWORK = "my-network";
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const networkIdx = spawnArgs.indexOf("my-network");
    expect(networkIdx).toBeGreaterThan(-1);
    expect(spawnArgs[networkIdx - 1]).toBe("--network");

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

describe("container-runner CREDENTIAL_PROXY_EXTERNAL_URL", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses host gateway URL when CREDENTIAL_PROXY_EXTERNAL_URL is empty", async () => {
    mockRuntime.CREDENTIAL_PROXY_EXTERNAL_URL = "";
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const baseUrlArg = spawnArgs.find((arg) => arg.startsWith("ANTHROPIC_BASE_URL="));
    expect(baseUrlArg).toBe(
      `ANTHROPIC_BASE_URL=http://host.docker.internal:${mockConfig.CREDENTIAL_PROXY_PORT}`,
    );

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("uses CREDENTIAL_PROXY_EXTERNAL_URL as ANTHROPIC_BASE_URL when set", async () => {
    mockRuntime.CREDENTIAL_PROXY_EXTERNAL_URL = "http://nanoclaw:3001";
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const baseUrlArg = spawnArgs.find((arg) => arg.startsWith("ANTHROPIC_BASE_URL="));
    expect(baseUrlArg).toBe("ANTHROPIC_BASE_URL=http://nanoclaw:3001");

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

describe("container-runner volume mount overrides", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.statSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rewrites config-rooted mount sources when CONTAINER_HOST_CONFIG_DIR is set", async () => {
    mockConfig.CONTAINER_HOST_CONFIG_DIR = "/host/config";
    // The group folder path resolves under GROUPS_DIR which is under CONFIG_ROOT
    // resolveGroupFolderPath => GROUPS_DIR/test-group => /tmp/nanoclaw-test-groups/test-group
    // resolveHostPath should rewrite since GROUPS_DIR is under CONFIG_ROOT

    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    // Find volume mount args that contain the host config path rewrite
    const volumeArgs = spawnArgs.filter((arg) => arg.includes("/host/config"));
    // The group folder mount should be rewritten from /tmp/nanoclaw-test-groups/test-group
    // to /host/config/test-group (CONFIG_ROOT = GROUPS_DIR in test, so relative path is just "test-group")
    expect(volumeArgs.length).toBeGreaterThan(0);
    expect(volumeArgs.some((a) => a.includes("/host/config/test-group"))).toBe(true);

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("rewrites data-rooted mount sources when CONTAINER_HOST_DATA_DIR is set", async () => {
    mockConfig.CONTAINER_HOST_DATA_DIR = "/host/data";

    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    // Data-rooted mounts (sessions, cache, ipc) should be rewritten
    const volumeArgs = spawnArgs.filter((arg) => arg.includes("/host/data"));
    expect(volumeArgs.length).toBeGreaterThan(0);
    // uv cache mount is under DATA_DIR/cache/uv/test-group
    expect(volumeArgs.some((a) => a.includes("/host/data/cache/uv/test-group"))).toBe(true);

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("uses original paths when neither override is set", async () => {
    mockConfig.CONTAINER_HOST_CONFIG_DIR = "";
    mockConfig.CONTAINER_HOST_DATA_DIR = "";

    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    // Group mount should use the original path
    const groupMountArg = spawnArgs.find(
      (arg) =>
        arg.includes("/tmp/nanoclaw-test-groups/test-group") && arg.includes("/workspace/group"),
    );
    expect(groupMountArg).toBeDefined();
    // Should NOT contain any host override paths
    expect(spawnArgs.every((arg) => !arg.includes("/host/"))).toBe(true);

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

describe("container-runner main group mounts", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.statSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts project-meta read-only when the directory exists", async () => {
    const projectMetaDir = "/tmp/nanoclaw-test-data/project-meta";

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s === projectMetaDir) return true;
      return false;
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const resultPromise = runContainerAgent(testGroup, { ...testInput, isMain: true }, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    // project-meta should be mounted read-only at /workspace/project
    const projectMount = spawnArgs.find(
      (arg) => arg.includes("project-meta") && arg.includes("/workspace/project"),
    );
    expect(projectMount).toBeDefined();
    expect(projectMount).toContain(":ro");

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("skips project-meta mount when directory does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const resultPromise = runContainerAgent(testGroup, { ...testInput, isMain: true }, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const projectMount = spawnArgs.find((arg) => arg.includes("/workspace/project"));
    expect(projectMount).toBeUndefined();

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("mounts cross-group directory read-only for main group", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const resultPromise = runContainerAgent(testGroup, { ...testInput, isMain: true }, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    // Cross-group mount: GROUPS_DIR -> /workspace/groups (ro)
    const crossGroupMount = spawnArgs.find(
      (arg) => arg.includes("/tmp/nanoclaw-test-groups") && arg.includes("/workspace/groups"),
    );
    expect(crossGroupMount).toBeDefined();
    expect(crossGroupMount).toContain(":ro");

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("mounts own group folder as writable for main group", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const resultPromise = runContainerAgent(testGroup, { ...testInput, isMain: true }, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    // Main group gets its own folder at /workspace/group (writable, no :ro)
    const ownGroupMount = spawnArgs.find(
      (arg) =>
        arg.includes("/tmp/nanoclaw-test-groups/test-group") &&
        arg.includes("/workspace/group") &&
        !arg.includes("/workspace/groups"),
    );
    expect(ownGroupMount).toBeDefined();
    expect(ownGroupMount).not.toContain(":ro");

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it("does NOT mount cross-group directory for non-main groups", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const resultPromise = runContainerAgent(testGroup, { ...testInput, isMain: false }, () => {});

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const crossGroupMount = spawnArgs.find((arg) => arg.includes("/workspace/groups"));
    expect(crossGroupMount).toBeUndefined();

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

describe("container-runner CONTAINER_IMAGE validation", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when CONTAINER_IMAGE is empty", async () => {
    mockConfig.CONTAINER_IMAGE = "";

    await expect(runContainerAgent(testGroup, testInput, () => {})).rejects.toThrow(
      "CONTAINER_IMAGE is required",
    );
  });

  it("does not throw when CONTAINER_IMAGE is set", async () => {
    mockConfig.CONTAINER_IMAGE = "nanoclaw-agent:latest";

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // Should have spawned successfully
    expect(vi.mocked(spawn)).toHaveBeenCalled();

    fakeProc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});
