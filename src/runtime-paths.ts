import path from "path";

/**
 * Runtime path roots.
 *
 * PROJECT_ROOT is where NanoClaw code runs.
 * CONFIG_ROOT can be overridden to load .env and groups/ from an external location.
 */
export const PROJECT_ROOT = process.cwd();
export const CONFIG_ROOT = path.resolve(process.env.NANOCLAW_CONFIG_ROOT || PROJECT_ROOT);
export const ENV_FILE_PATH = path.join(CONFIG_ROOT, ".env");
