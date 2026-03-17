import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config
vi.mock("./config.js", () => ({
  INSTANCE_ID: "test1234",
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

// Mock child_process — store the mock fns so tests can configure them
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from "./container-runtime.js";
import { logger } from "./logger.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe("readonlyMountArgs", () => {
  it("returns -v flag with :ro suffix", () => {
    const args = readonlyMountArgs("/host/path", "/container/path");
    expect(args).toEqual(["-v", "/host/path:/container/path:ro"]);
  });
});

describe("stopContainer", () => {
  it("returns stop command using CONTAINER_RUNTIME_BIN", () => {
    expect(stopContainer("nanoclaw-test-123")).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe("ensureContainerRuntimeRunning", () => {
  it("does nothing when runtime is already running", () => {
    mockExecSync.mockReturnValueOnce("");

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: "pipe",
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith("Container runtime already running");
  });

  it("throws when docker info fails", () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("Cannot connect to the Docker daemon");
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      "Container runtime is required but failed to start",
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe("cleanupOrphans", () => {
  it("stops orphaned nanoclaw containers", () => {
    // docker ps returns container names, one per line
    mockExecFileSync.mockReturnValueOnce("nanoclaw-group1-111\nnanoclaw-group2-222\n");
    // stop calls succeed
    mockExecFileSync.mockReturnValue("");

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      CONTAINER_RUNTIME_BIN,
      ["ps", "--filter", "label=nanoclaw.instance=test1234", "--format", "{{.Names}}"],
      expect.anything(),
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ["stop", "nanoclaw-group1-111"],
      { stdio: "pipe" },
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      3,
      CONTAINER_RUNTIME_BIN,
      ["stop", "nanoclaw-group2-222"],
      { stdio: "pipe" },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ["nanoclaw-group1-111", "nanoclaw-group2-222"], instanceId: "test1234" },
      "Stopped orphaned containers",
    );
  });

  it("does nothing when no orphans exist", () => {
    mockExecFileSync.mockReturnValueOnce("");

    cleanupOrphans();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("warns and continues when ps fails", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("docker not available");
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to clean up orphaned containers",
    );
  });

  it("continues stopping remaining containers when one stop fails", () => {
    mockExecFileSync.mockReturnValueOnce("nanoclaw-a-1\nnanoclaw-b-2\n");
    // First stop fails
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("already stopped");
    });
    // Second stop succeeds
    mockExecFileSync.mockReturnValueOnce("");

    cleanupOrphans(); // should not throw

    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ["nanoclaw-a-1", "nanoclaw-b-2"], instanceId: "test1234" },
      "Stopped orphaned containers",
    );
  });
});
