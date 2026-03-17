import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

const envFileData = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock("./env.js", () => ({
  readEnvFile: vi.fn(() => envFileData.current),
}));

describe("parseIntEnv validation", () => {
  afterEach(() => {
    delete process.env.CONTAINER_TIMEOUT;
    delete process.env.CHANNEL_CONNECT_TIMEOUT;
    envFileData.current = {};
    vi.resetModules();
  });

  it("throws on non-numeric env value", async () => {
    process.env.CONTAINER_TIMEOUT = "abc";
    await expect(import("./config.js")).rejects.toThrow(
      'Invalid integer for CONTAINER_TIMEOUT: "abc"',
    );
  });

  it("throws on partially numeric env value", async () => {
    process.env.CHANNEL_CONNECT_TIMEOUT = "30s";
    await expect(import("./config.js")).rejects.toThrow(
      'Invalid integer for CHANNEL_CONNECT_TIMEOUT: "30s"',
    );
  });

  it("uses env value when set to a valid integer", async () => {
    process.env.CHANNEL_CONNECT_TIMEOUT = "5000";
    const mod = await import("./config.js");
    expect(mod.CHANNEL_CONNECT_TIMEOUT).toBe(5000);
  });

  it("uses default when env var is not set", async () => {
    delete process.env.CHANNEL_CONNECT_TIMEOUT;
    const mod = await import("./config.js");
    expect(mod.CHANNEL_CONNECT_TIMEOUT).toBe(30000);
  });

  it("reads integer from .env file when process.env is unset", async () => {
    delete process.env.CHANNEL_CONNECT_TIMEOUT;
    envFileData.current = { CHANNEL_CONNECT_TIMEOUT: "15000" };
    const mod = await import("./config.js");
    expect(mod.CHANNEL_CONNECT_TIMEOUT).toBe(15000);
  });

  it("process.env takes precedence over .env file", async () => {
    process.env.CHANNEL_CONNECT_TIMEOUT = "5000";
    envFileData.current = { CHANNEL_CONNECT_TIMEOUT: "15000" };
    const mod = await import("./config.js");
    expect(mod.CHANNEL_CONNECT_TIMEOUT).toBe(5000);
  });
});

describe("config path resolution", () => {
  afterEach(() => {
    delete process.env.NANOCLAW_CONFIG_ROOT;
    vi.resetModules();
  });

  it("keeps GROUPS_DIR under project root by default", async () => {
    const mod = await import("./config.js");
    expect(mod.GROUPS_DIR).toBe(path.resolve(process.cwd(), "groups"));
  });

  it("moves GROUPS_DIR under NANOCLAW_CONFIG_ROOT when provided", async () => {
    process.env.NANOCLAW_CONFIG_ROOT = "/tmp/nanoclaw-config";
    const mod = await import("./config.js");
    expect(mod.GROUPS_DIR).toBe("/tmp/nanoclaw-config/groups");
  });
});
