import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpClientHandle {
  callTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
  close: () => Promise<void>;
}

export interface SystemPromptDeps {
  readFile: (path: string) => string | null;
  execSubprocess: (
    cmd: string,
    args: string[],
    env: Record<string, string>,
    timeout: number,
  ) => Promise<string | null>;
  createMcpClient: (config: McpServerConfig) => Promise<McpClientHandle | null>;
  loadMcpConfig: (path: string) => Record<string, McpServerConfig>;
  log: (message: string) => void;
}

const SESSION_TAIL_DEFAULT_LINES = 12;
const SESSION_TAIL_TIMEOUT_MS = 10_000;

// ─── renderSystemPrompt ──────────────────────────────────────

export function renderSystemPrompt(
  template: string,
  replacements: Record<string, string>,
): string {
  let result = template;

  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }

  // Remove unfilled placeholders
  result = result.replace(/\{\{[A-Z_]+\}\}/g, '');

  // Collapse empty separator sections (---\n\n---) → single ---
  result = result.replace(/---\s*\n\s*---/g, '---');

  // Collapse 3+ consecutive newlines → 2
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

// ─── callEgoWakeUp ───────────────────────────────────────────

export async function callEgoWakeUp(
  deps: SystemPromptDeps,
  workspaceGroup: string,
): Promise<string | null> {
  const configPath = path.join(workspaceGroup, 'mcp-servers.json');
  const config = deps.loadMcpConfig(configPath);
  const ego = config['ego'];

  if (!ego) {
    deps.log('[system-prompt] ego-mcp wake_up skipped: not configured');
    return null;
  }

  let client: McpClientHandle | null = null;
  try {
    client = await deps.createMcpClient(ego);
    if (!client) {
      deps.log('[system-prompt] ego-mcp wake_up failed: client creation returned null');
      return null;
    }

    const result = await client.callTool({ name: 'wake_up', arguments: {} });
    const text = result.content
      ?.filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    if (!text) {
      deps.log('[system-prompt] ego-mcp wake_up returned no text content');
      return null;
    }

    return text;
  } catch (err) {
    deps.log(
      `[system-prompt] ego-mcp wake_up failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (_closeErr) {
        // ignore close errors
      }
    }
  }
}

// ─── runSessionTail ──────────────────────────────────────────

export async function runSessionTail(
  deps: SystemPromptDeps,
  workspaceGroup: string,
  lines?: number,
): Promise<string | null> {
  const scriptPath = path.join(
    workspaceGroup,
    'skills',
    'session-tail',
    'scripts',
    'session-tail.py',
  );

  if (deps.readFile(scriptPath) === null) {
    deps.log('[system-prompt] session-tail skipped: script not found');
    return null;
  }

  const lineCount = String(lines ?? SESSION_TAIL_DEFAULT_LINES);

  try {
    const output = await deps.execSubprocess(
      'python3',
      [scriptPath, '--last', lineCount, '--no-trim'],
      { NANOCLAW_GROUP_DIR: workspaceGroup },
      SESSION_TAIL_TIMEOUT_MS,
    );

    if (!output || output.trim() === '') {
      deps.log('[system-prompt] session-tail returned empty output');
      return null;
    }

    return output.trim();
  } catch (err) {
    deps.log(
      `[system-prompt] session-tail failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ─── buildReplacements ──────────────────────────────────────

const IDENTITY_FILES: Record<string, string> = {
  SOUL: 'SOUL.md',
  IDENTITY: 'IDENTITY.md',
  VOICE: 'VOICE.md',
  USER: 'USER.md',
  MEMORY: 'MEMORY.md',
};

export async function buildReplacements(
  deps: SystemPromptDeps,
  containerInput: { isMain: boolean },
  workspaceGroup: string,
  workspaceGlobal: string,
): Promise<Record<string, string>> {
  const replacements: Record<string, string> = {};
  const filled: string[] = [];
  const skipped: string[] = [];

  // Identity files (synchronous)
  for (const [key, filename] of Object.entries(IDENTITY_FILES)) {
    const filePath = path.join(workspaceGroup, filename);
    const content = deps.readFile(filePath);
    if (content !== null) {
      replacements[key] = content;
      filled.push(key);
    } else {
      skipped.push(key);
    }
  }

  // Date-based memory files
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  for (const [key, date] of [
    ['TODAY_MEMORY', today],
    ['YESTERDAY_MEMORY', yesterday],
  ] as const) {
    const memPath = path.join(workspaceGroup, 'memory', `${date}.md`);
    const content = deps.readFile(memPath);
    if (content !== null) {
      replacements[key] = content;
      filled.push(key);
    } else {
      skipped.push(key);
    }
  }

  // Parallel async: session-tail + ego wake_up
  const sessionTailLines = parseInt(
    process.env.SESSION_TAIL_LINES || String(SESSION_TAIL_DEFAULT_LINES),
    10,
  );
  const [sessionTail, wakeUp] = await Promise.all([
    runSessionTail(deps, workspaceGroup, sessionTailLines),
    callEgoWakeUp(deps, workspaceGroup),
  ]);

  if (sessionTail) {
    replacements['SESSION_TAIL'] = sessionTail;
    filled.push('SESSION_TAIL');
  } else {
    skipped.push('SESSION_TAIL');
  }

  if (wakeUp) {
    replacements['WAKE_UP'] = wakeUp;
    filled.push('WAKE_UP');
  } else {
    skipped.push('WAKE_UP');
  }

  // Global CLAUDE.md (non-main only)
  if (!containerInput.isMain) {
    const globalPath = path.join(workspaceGlobal, 'CLAUDE.md');
    const content = deps.readFile(globalPath);
    if (content !== null) {
      replacements['GLOBAL_CLAUDE'] = content;
      filled.push('GLOBAL_CLAUDE');
    } else {
      skipped.push('GLOBAL_CLAUDE');
    }
  }

  deps.log(
    `[system-prompt] replacements: ${filled.join(',')}${skipped.length > 0 ? ` (${skipped.join(',')} skipped)` : ''}`,
  );

  return replacements;
}

// ─── createDefaultDeps ──────────────────────────────────────

export function createDefaultDeps(
  log: (message: string) => void,
): SystemPromptDeps {
  return {
    readFile(filePath: string): string | null {
      try {
        if (!fs.existsSync(filePath)) return null;
        return fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        log(
          `[system-prompt] Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },

    execSubprocess(
      cmd: string,
      args: string[],
      env: Record<string, string>,
      timeout: number,
    ): Promise<string | null> {
      return new Promise((resolve) => {
        execFile(
          cmd,
          args,
          { env: { ...process.env, ...env }, timeout },
          (err, stdout) => {
            if (err) {
              log(
                `[system-prompt] subprocess ${cmd} failed: ${err.message}`,
              );
              resolve(null);
              return;
            }
            resolve(stdout.trim() || null);
          },
        );
      });
    },

    async createMcpClient(
      config: McpServerConfig,
    ): Promise<McpClientHandle | null> {
      const { Client } = await import(
        '@modelcontextprotocol/sdk/client/index.js'
      );
      const { StdioClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/stdio.js'
      );

      // Filter out undefined env values for StdioClientTransport
      const envRecord: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...process.env, ...config.env })) {
        if (v !== undefined) envRecord[k] = v;
      }

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: envRecord,
      });
      const client = new Client({ name: 'nanoclaw-warmup', version: '1.0' });
      await client.connect(transport);

      return {
        async callTool(params) {
          const result = await client.callTool(params);
          const content = Array.isArray(result.content) ? result.content : [];
          return {
            content: content.map(
              (c: { type: string; text?: string }) => ({
                type: c.type,
                text: c.text,
              }),
            ),
          };
        },
        async close() {
          await client.close();
        },
      };
    },

    loadMcpConfig(filePath: string): Record<string, McpServerConfig> {
      try {
        if (!fs.existsSync(filePath)) return {};
        const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return config.servers || {};
      } catch (err) {
        log(
          `[system-prompt] Failed to load MCP config from ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {};
      }
    },

    log,
  };
}
