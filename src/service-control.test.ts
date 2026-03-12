import { EventEmitter } from "events";
import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { getRestartPlan, restartNanoClawService } from "./service-control.js";

class MockChildProcess extends EventEmitter {
  kill = vi.fn();
}

describe("service-control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.NANOCLAW_SERVICE_NAME;
    delete process.env.NANOCLAW_LAUNCHD_LABEL;
    vi.useRealTimers();
  });

  it("uses launchd kickstart on macOS", () => {
    const plan = getRestartPlan({
      platform: "darwin",
      uid: 501,
    });

    expect(plan).toEqual({
      manager: "launchd",
      command: {
        bin: "launchctl",
        args: ["kickstart", "-k", "gui/501/com.nanoclaw"],
        display: "launchctl kickstart -k gui/501/com.nanoclaw",
      },
    });
  });

  it("uses systemd --user on Linux for non-root", () => {
    const plan = getRestartPlan({
      platform: "linux",
      uid: 1000,
      hasSystemd: true,
    });

    expect(plan).toEqual({
      manager: "systemd-user",
      command: {
        bin: "systemctl",
        args: ["--user", "restart", "nanoclaw"],
        display: "systemctl --user restart nanoclaw",
      },
    });
  });

  it("uses system-level systemd when running as root", () => {
    const plan = getRestartPlan({
      platform: "linux",
      uid: 0,
      hasSystemd: true,
    });

    expect(plan).toEqual({
      manager: "systemd-system",
      command: {
        bin: "systemctl",
        args: ["restart", "nanoclaw"],
        display: "systemctl restart nanoclaw",
      },
    });
  });

  it("uses configurable service names", () => {
    process.env.NANOCLAW_SERVICE_NAME = "nanoclaw-dev";
    const plan = getRestartPlan({
      platform: "linux",
      uid: 1000,
      hasSystemd: true,
    });

    expect(plan).toEqual({
      manager: "systemd-user",
      command: {
        bin: "systemctl",
        args: ["--user", "restart", "nanoclaw-dev"],
        display: "systemctl --user restart nanoclaw-dev",
      },
    });
  });

  it("returns unsupported when systemd is unavailable on Linux", () => {
    const plan = getRestartPlan({
      platform: "linux",
      uid: 1000,
      hasSystemd: false,
    });

    expect(plan.manager).toBe("none");
    expect(plan.command).toBeNull();
    expect(plan.reason).toContain("systemd");
  });

  it("fails closed for invalid systemd service name", () => {
    process.env.NANOCLAW_SERVICE_NAME = "nanoclaw;rm -rf /";
    const plan = getRestartPlan({
      platform: "linux",
      uid: 1000,
      hasSystemd: true,
    });

    expect(plan.manager).toBe("none");
    expect(plan.command).toBeNull();
    expect(plan.reason).toContain("NANOCLAW_SERVICE_NAME");
  });

  it("fails closed for invalid launchd label", () => {
    process.env.NANOCLAW_LAUNCHD_LABEL = "com.nanoclaw bad";
    const plan = getRestartPlan({
      platform: "darwin",
      uid: 501,
    });

    expect(plan.manager).toBe("none");
    expect(plan.command).toBeNull();
    expect(plan.reason).toContain("NANOCLAW_LAUNCHD_LABEL");
  });

  it("executes restart with spawn and resolves success on zero exit", async () => {
    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as any);

    const promise = restartNanoClawService({
      manager: "systemd-user",
      command: {
        bin: "systemctl",
        args: ["--user", "restart", "nanoclaw"],
        display: "systemctl --user restart nanoclaw",
      },
    });

    expect(spawn).toHaveBeenCalledWith("systemctl", ["--user", "restart", "nanoclaw"], {
      stdio: "ignore",
    });
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({
      manager: "systemd-user",
      command: {
        bin: "systemctl",
        args: ["--user", "restart", "nanoclaw"],
        display: "systemctl --user restart nanoclaw",
      },
      ok: true,
    });
  });

  it("returns spawn errors from restart execution", async () => {
    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as any);

    const promise = restartNanoClawService({
      manager: "launchd",
      command: {
        bin: "launchctl",
        args: ["kickstart", "-k", "gui/501/com.nanoclaw"],
        display: "launchctl kickstart -k gui/501/com.nanoclaw",
      },
    });
    child.emit("error", new Error("ENOENT"));

    await expect(promise).resolves.toMatchObject({
      manager: "launchd",
      ok: false,
      error: "ENOENT",
    });
  });

  it("times out hung restart commands and terminates child process", async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as any);

    const promise = restartNanoClawService(
      {
        manager: "systemd-user",
        command: {
          bin: "systemctl",
          args: ["--user", "restart", "nanoclaw"],
          display: "systemctl --user restart nanoclaw",
        },
      },
      1000,
    );

    await vi.advanceTimersByTimeAsync(1000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(promise).resolves.toMatchObject({
      manager: "systemd-user",
      ok: false,
    });
    await expect(promise).resolves.toMatchObject({
      error: "Restart command timed out after 1000ms: systemctl --user restart nanoclaw",
    });
  });
});
