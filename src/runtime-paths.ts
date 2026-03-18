import path from "path";

/**
 * Runtime path roots.
 *
 * Three-root model for containerization:
 * - APP_DIR:    Immutable application code (baked into Docker image, or process.cwd() on bare metal)
 * - CONFIG_ROOT: User configuration and personalization (groups/, .env, allowlists)
 * - DATA_DIR:   Runtime state (sessions, cache, IPC, logs, store)
 *
 * PROJECT_ROOT is the legacy base path. When no env vars are set, all roots
 * collapse to PROJECT_ROOT-relative paths for backwards compatibility.
 */
export const PROJECT_ROOT = process.cwd();
export const APP_DIR = path.resolve(process.env.NANOCLAW_APP_DIR || PROJECT_ROOT);
export const CONFIG_ROOT = path.resolve(process.env.NANOCLAW_CONFIG_ROOT || PROJECT_ROOT);
export const DATA_DIR = path.resolve(
  process.env.NANOCLAW_DATA_DIR || path.join(PROJECT_ROOT, "data"),
);
export const ENV_FILE_PATH = path.join(CONFIG_ROOT, ".env");
