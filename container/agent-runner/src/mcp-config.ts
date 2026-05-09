/**
 * Translate a raw container.json MCP entry into the shape the Claude Agent
 * SDK (and other providers) accept.
 *
 * The host-side schema accepts four shapes:
 *   - stdio:           `{ command, args?, env?, type?: 'stdio' }`
 *   - http:            `{ type: 'http', url, headers? }`
 *   - sse:             `{ type: 'sse',  url, headers? }`
 *   - streamableHttp:  `{ type: 'streamableHttp', url, headers? }`  (alias for 'http')
 *
 * The SDK only knows `'stdio' | 'http' | 'sse'`. We normalize 'streamableHttp'
 * to 'http' here. Host-only fields (`instructions`) are dropped — those are
 * consumed by `claude-md-compose.ts` on the host side, never by the SDK.
 */
import type { McpServerConfig } from './providers/types.js';

export type RawMcpEntry = {
  type?: 'stdio' | 'http' | 'sse' | 'streamableHttp';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  // Host-only — dropped before reaching the SDK.
  instructions?: string;
  // Tolerate unknown fields without losing the rest of the config.
  [k: string]: unknown;
};

export function normalizeMcpEntry(name: string, raw: RawMcpEntry): McpServerConfig {
  if (raw.url) {
    if (raw.command) {
      throw new Error(`mcp[${name}]: cannot set both command and url`);
    }
    const sdkType = raw.type === 'streamableHttp' ? 'http' : raw.type;
    if (sdkType !== 'http' && sdkType !== 'sse') {
      throw new Error(`mcp[${name}]: url-based entry needs type 'http' | 'sse' | 'streamableHttp' (got ${String(raw.type)})`);
    }
    const out: McpServerConfig = { type: sdkType, url: raw.url };
    if (raw.headers) (out as { headers?: Record<string, string> }).headers = raw.headers;
    return out;
  }
  if (raw.command) {
    const out: McpServerConfig = { command: raw.command };
    if (raw.type === 'stdio') out.type = 'stdio';
    if (raw.args) out.args = raw.args;
    if (raw.env) out.env = raw.env;
    return out;
  }
  throw new Error(`mcp[${name}]: must set either command or url`);
}
