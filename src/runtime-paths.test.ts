import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

describe("runtime-paths", () => {
  afterEach(() => {
    delete process.env.NANOCLAW_CONFIG_ROOT;
    delete process.env.NANOCLAW_APP_DIR;
    delete process.env.NANOCLAW_DATA_DIR;
    vi.resetModules();
  });

  it("defaults CONFIG_ROOT to process cwd", async () => {
    const mod = await import("./runtime-paths.js");
    expect(mod.PROJECT_ROOT).toBe(process.cwd());
    expect(mod.CONFIG_ROOT).toBe(process.cwd());
    expect(mod.ENV_FILE_PATH).toBe(path.join(process.cwd(), ".env"));
  });

  it("resolves NANOCLAW_CONFIG_ROOT relative to cwd", async () => {
    process.env.NANOCLAW_CONFIG_ROOT = "assistant-config";
    const mod = await import("./runtime-paths.js");
    const expectedRoot = path.resolve(process.cwd(), "assistant-config");
    expect(mod.CONFIG_ROOT).toBe(expectedRoot);
    expect(mod.ENV_FILE_PATH).toBe(path.join(expectedRoot, ".env"));
  });

  it("defaults APP_DIR to process cwd", async () => {
    const mod = await import("./runtime-paths.js");
    expect(mod.APP_DIR).toBe(process.cwd());
  });

  it("resolves NANOCLAW_APP_DIR when set (absolute)", async () => {
    process.env.NANOCLAW_APP_DIR = "/app";
    const mod = await import("./runtime-paths.js");
    expect(mod.APP_DIR).toBe("/app");
  });

  it("resolves NANOCLAW_APP_DIR when set (relative)", async () => {
    process.env.NANOCLAW_APP_DIR = "my-app";
    const mod = await import("./runtime-paths.js");
    expect(mod.APP_DIR).toBe(path.resolve(process.cwd(), "my-app"));
  });

  it("defaults DATA_DIR to PROJECT_ROOT/data", async () => {
    const mod = await import("./runtime-paths.js");
    expect(mod.DATA_DIR).toBe(path.join(process.cwd(), "data"));
  });

  it("resolves NANOCLAW_DATA_DIR when set", async () => {
    process.env.NANOCLAW_DATA_DIR = "/data";
    const mod = await import("./runtime-paths.js");
    expect(mod.DATA_DIR).toBe("/data");
  });
});
