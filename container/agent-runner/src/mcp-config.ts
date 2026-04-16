import fs from 'fs';

import { log } from './io.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Load declarative MCP server configs from JSON. Missing or malformed
 * files return an empty object (with a log line for the malformed case).
 */
export function loadMcpConfig(filePath: string): Record<string, McpServerConfig> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return config.servers || {};
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    log(
      `Failed to load MCP config from ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}
