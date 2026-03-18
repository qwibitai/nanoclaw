import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime-paths.js", () => ({
  APP_DIR: "/test/app",
  DATA_DIR: "/test/data",
}));

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn((_p?: unknown) => false),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  cpSync: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, default: { ...actual, ...mockFs } };
});

import { syncProjectMeta } from "./project-meta.js";

describe("syncProjectMeta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockImplementation((_p?: unknown) => false);
  });

  it("creates project-meta directory", () => {
    syncProjectMeta();
    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/test/data/project-meta", { recursive: true });
  });

  it("copies CLAUDE.md when it exists", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => p === "/test/app/CLAUDE.md");
    syncProjectMeta();
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      "/test/app/CLAUDE.md",
      "/test/data/project-meta/CLAUDE.md",
    );
  });

  it("skips CLAUDE.md when it does not exist", () => {
    syncProjectMeta();
    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
  });

  it("copies docs/ recursively when it exists", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => p === "/test/app/docs");
    syncProjectMeta();
    expect(mockFs.cpSync).toHaveBeenCalledWith("/test/app/docs", "/test/data/project-meta/docs", {
      recursive: true,
    });
  });

  it("copies container/skills/ recursively when it exists", () => {
    mockFs.existsSync.mockImplementation((p: unknown) => p === "/test/app/container/skills");
    syncProjectMeta();
    expect(mockFs.cpSync).toHaveBeenCalledWith(
      "/test/app/container/skills",
      "/test/data/project-meta/container/skills",
      { recursive: true },
    );
  });

  it("handles all sources missing gracefully", () => {
    expect(() => syncProjectMeta()).not.toThrow();
  });
});
