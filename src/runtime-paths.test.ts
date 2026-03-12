import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

describe("runtime-paths", () => {
  afterEach(() => {
    delete process.env.NANOCLAW_CONFIG_ROOT;
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
});
