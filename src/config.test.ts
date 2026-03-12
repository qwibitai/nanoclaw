import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
