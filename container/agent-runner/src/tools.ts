import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { tool } from '@openrouter/sdk';
import { z } from 'zod';
import { createIpcHandlers, IpcContext } from './ipc.js';

const DEFAULT_TOOL_OUTPUT_LIMIT = parseInt(process.env.DOTCLAW_TOOL_OUTPUT_LIMIT_BYTES || '1000000', 10);
const DEFAULT_BASH_TIMEOUT_MS = parseInt(process.env.DOTCLAW_BASH_TIMEOUT_MS || '120000', 10);
const DEFAULT_BASH_OUTPUT_LIMIT = parseInt(process.env.DOTCLAW_BASH_OUTPUT_LIMIT_BYTES || '200000', 10);
const DEFAULT_WEBFETCH_MAX_BYTES = parseInt(process.env.DOTCLAW_WEBFETCH_MAX_BYTES || '1000000', 10);
const DEFAULT_GREP_MAX_FILE_BYTES = parseInt(process.env.DOTCLAW_GREP_MAX_FILE_BYTES || '1000000', 10);

const WORKSPACE_GROUP = '/workspace/group';
const WORKSPACE_GLOBAL = '/workspace/global';
const WORKSPACE_EXTRA = '/workspace/extra';
const WORKSPACE_PROJECT = '/workspace/project';

export type ToolCallRecord = {
  name: string;
  args?: unknown;
  ok: boolean;
  duration_ms?: number;
  error?: string;
};

type ToolCallLogger = (record: ToolCallRecord) => void;

function getAllowedRoots(isMain: boolean): string[] {
  const roots = [WORKSPACE_GROUP, WORKSPACE_GLOBAL, WORKSPACE_EXTRA];
  if (isMain) roots.push(WORKSPACE_PROJECT);
  return roots.map(root => path.resolve(root));
}

function isWithinRoot(targetPath: string, root: string): boolean {
  return targetPath === root || targetPath.startsWith(`${root}${path.sep}`);
}

function resolvePath(inputPath: string, isMain: boolean, mustExist = false): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path is required');
  }
  const roots = getAllowedRoots(isMain);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(WORKSPACE_GROUP, inputPath);

  if (!roots.some(root => isWithinRoot(resolved, root))) {
    throw new Error(`Path is outside allowed roots: ${resolved}`);
  }

  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  return resolved;
}

function limitText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { text, truncated: false };
  }
  const buffer = Buffer.from(text, 'utf-8');
  const truncated = buffer.subarray(0, maxBytes).toString('utf-8');
  return { text: truncated, truncated: true };
}

function isEnabled(envName: string, defaultValue = true): boolean {
  const value = (process.env[envName] || '').toLowerCase().trim();
  if (!value) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value);
}

function normalizeDomain(value: string): string {
  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/^[a-z]+:\/\//, '');
  normalized = normalized.split('/')[0];
  normalized = normalized.split(':')[0];
  return normalized;
}

function sanitizeToolArgs(name: string, args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const record = { ...(args as Record<string, unknown>) };

  if ('content' in record && typeof record.content === 'string') {
    record.content = `<redacted:${(record.content as string).length}>`;
  }
  if ('text' in record && typeof record.text === 'string') {
    record.text = `<redacted:${(record.text as string).length}>`;
  }
  if ('old_text' in record && typeof record.old_text === 'string') {
    record.old_text = `<redacted:${(record.old_text as string).length}>`;
  }
  if ('new_text' in record && typeof record.new_text === 'string') {
    record.new_text = `<redacted:${(record.new_text as string).length}>`;
  }
  if ('command' in record && typeof record.command === 'string') {
    record.command = (record.command as string).slice(0, 200);
  }

  return record;
}

function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join('/');
}

function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      const next = pattern[i + 1];
      if (next === '*') {
        const nextNext = pattern[i + 2];
        if (nextNext === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
        continue;
      }
      regex += '[^/]*';
      i += 1;
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      i += 1;
      continue;
    }
    if ('\\^$+?.()|{}[]'.includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
    i += 1;
  }
  return new RegExp(`^${regex}$`);
}

function getSearchRoot(patternPosix: string): string {
  const globIndex = patternPosix.search(/[*?]/);
  if (globIndex === -1) {
    return patternPosix;
  }
  const slashIndex = patternPosix.lastIndexOf('/', globIndex);
  if (slashIndex <= 0) return '/';
  return patternPosix.slice(0, slashIndex);
}

function walkFileTree(
  rootPath: string,
  options: { includeFiles: boolean; includeDirs: boolean; maxResults: number }
): string[] {
  const results: string[] = [];
  const stack: string[] = [rootPath];

  while (stack.length > 0 && results.length < options.maxResults) {
    const current = stack.pop();
    if (!current) continue;
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      if (options.includeDirs) results.push(current);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (results.length >= options.maxResults) break;
        const nextPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(nextPath);
        } else if (entry.isFile()) {
          if (options.includeFiles) results.push(nextPath);
        }
      }
    } else if (stats.isFile()) {
      if (options.includeFiles) results.push(current);
    }
  }

  return results;
}

async function runCommand(command: string, timeoutMs: number, outputLimit: number) {
  return new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    truncated: boolean;
  }>((resolve) => {
    const start = Date.now();
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: WORKSPACE_GROUP,
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    const maxBytes = outputLimit;

    const append = (chunk: Buffer | string, isStdout: boolean) => {
      if (truncated) return;
      const text = chunk.toString();
      const current = isStdout ? stdout : stderr;
      const remaining = maxBytes - Buffer.byteLength(stdout + stderr, 'utf-8');
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const toAdd = Buffer.byteLength(text, 'utf-8') > remaining
        ? Buffer.from(text).subarray(0, remaining).toString('utf-8')
        : text;
      if (isStdout) {
        stdout += toAdd;
      } else {
        stderr += toAdd;
      }
      if (Buffer.byteLength(stdout + stderr, 'utf-8') >= maxBytes) {
        truncated = true;
      }
    };

    child.stdout.on('data', (data) => append(data, true));
    child.stderr.on('data', (data) => append(data, false));

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - start,
        truncated
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr: `${stderr}\n${err instanceof Error ? err.message : String(err)}`.trim(),
        exitCode: 1,
        durationMs: Date.now() - start,
        truncated
      });
    });
  });
}

async function readFileSafe(filePath: string, maxBytes: number) {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return { content: fs.readFileSync(filePath, 'utf-8'), truncated: false, size: stat.size };
  }
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(maxBytes);
  const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
  fs.closeSync(fd);
  return { content: buffer.subarray(0, bytesRead).toString('utf-8'), truncated: true, size: stat.size };
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return { body: Buffer.alloc(0), truncated: true };
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength <= maxBytes) {
    return { body: Buffer.from(buffer), truncated: false };
  }
  return { body: Buffer.from(buffer).subarray(0, maxBytes), truncated: true };
}

export function createTools(ctx: IpcContext, options?: { onToolCall?: ToolCallLogger }) {
  const ipc = createIpcHandlers(ctx);
  const isMain = ctx.isMain;
  const onToolCall = options?.onToolCall;

  const enableBash = isEnabled('DOTCLAW_ENABLE_BASH', true);
  const enableWebSearch = isEnabled('DOTCLAW_ENABLE_WEBSEARCH', true);
  const enableWebFetch = isEnabled('DOTCLAW_ENABLE_WEBFETCH', true);
  const webFetchAllowlist = (process.env.DOTCLAW_WEBFETCH_ALLOWLIST || '')
    .split(',')
    .map(normalizeDomain)
    .filter(Boolean);
  const webFetchBlocklist = (process.env.DOTCLAW_WEBFETCH_BLOCKLIST || '')
    .split(',')
    .map(normalizeDomain)
    .filter(Boolean);

  const wrapExecute = <TInput, TOutput>(name: string, execute: (args: TInput) => Promise<TOutput>) => {
    return async (args: TInput): Promise<TOutput> => {
      const start = Date.now();
      try {
        const result = await execute(args);
        onToolCall?.({
          name,
          args: sanitizeToolArgs(name, args),
          ok: true,
          duration_ms: Date.now() - start
        });
        return result;
      } catch (err) {
        onToolCall?.({
          name,
          args: sanitizeToolArgs(name, args),
          ok: false,
          duration_ms: Date.now() - start,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    };
  };

  const bashTool = tool({
    name: 'Bash',
    description: 'Run a shell command inside the container. CWD is /workspace/group.',
    inputSchema: z.object({
      command: z.string().describe('Command to run'),
      timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds')
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number(),
      truncated: z.boolean()
    }),
    execute: wrapExecute('Bash', async ({ command, timeoutMs }: { command: string; timeoutMs?: number }) => {
      return runCommand(command, timeoutMs || DEFAULT_BASH_TIMEOUT_MS, DEFAULT_BASH_OUTPUT_LIMIT);
    })
  });

  const readTool = tool({
    name: 'Read',
    description: 'Read a file from the mounted workspace.',
    inputSchema: z.object({
      path: z.string().describe('File path (relative to /workspace/group or absolute within mounts)'),
      maxBytes: z.number().int().positive().optional().describe('Maximum bytes to read')
    }),
    outputSchema: z.object({
      path: z.string(),
      content: z.string(),
      truncated: z.boolean(),
      size: z.number()
    }),
    execute: wrapExecute('Read', async ({ path: inputPath, maxBytes }: { path: string; maxBytes?: number }) => {
      const resolved = resolvePath(inputPath, isMain, true);
      const { content, truncated, size } = await readFileSafe(resolved, Math.min(maxBytes || DEFAULT_TOOL_OUTPUT_LIMIT, DEFAULT_TOOL_OUTPUT_LIMIT));
      return { path: resolved, content, truncated, size };
    })
  });

  const writeTool = tool({
    name: 'Write',
    description: 'Write a file to the mounted workspace.',
    inputSchema: z.object({
      path: z.string().describe('File path (relative to /workspace/group or absolute within mounts)'),
      content: z.string().describe('File contents'),
      overwrite: z.boolean().optional().describe('Overwrite if file exists (default true)')
    }),
    outputSchema: z.object({
      path: z.string(),
      bytesWritten: z.number()
    }),
    execute: wrapExecute('Write', async ({ path: inputPath, content, overwrite }: { path: string; content: string; overwrite?: boolean }) => {
      const resolved = resolvePath(inputPath, isMain, false);
      if (fs.existsSync(resolved) && overwrite === false) {
        throw new Error(`File already exists: ${resolved}`);
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content);
      return { path: resolved, bytesWritten: Buffer.byteLength(content, 'utf-8') };
    })
  });

  const editTool = tool({
    name: 'Edit',
    description: 'Replace a substring in a file.',
    inputSchema: z.object({
      path: z.string().describe('File path (relative to /workspace/group or absolute within mounts)'),
      old_text: z.string().describe('Text to replace'),
      new_text: z.string().describe('Replacement text')
    }),
    outputSchema: z.object({
      path: z.string(),
      replaced: z.boolean(),
      occurrences: z.number()
    }),
    execute: wrapExecute('Edit', async ({ path: inputPath, old_text, new_text }: { path: string; old_text: string; new_text: string }) => {
      if (!old_text) {
        throw new Error('old_text must be non-empty');
      }
      const resolved = resolvePath(inputPath, isMain, true);
      const content = fs.readFileSync(resolved, 'utf-8');
      const occurrences = content.split(old_text).length - 1;
      if (occurrences === 0) {
        return { path: resolved, replaced: false, occurrences: 0 };
      }
      const updated = content.replace(old_text, new_text);
      fs.writeFileSync(resolved, updated);
      return { path: resolved, replaced: true, occurrences };
    })
  });

  const globTool = tool({
    name: 'Glob',
    description: 'List files matching a glob pattern (relative to /workspace/group).',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern'),
      maxResults: z.number().int().positive().optional().describe('Maximum results')
    }),
    outputSchema: z.object({
      matches: z.array(z.string())
    }),
    execute: wrapExecute('Glob', async ({ pattern, maxResults }: { pattern: string; maxResults?: number }) => {
      const roots = getAllowedRoots(isMain);
      const absolutePattern = path.isAbsolute(pattern)
        ? resolvePath(pattern, isMain, false)
        : path.resolve(WORKSPACE_GROUP, pattern);
      const patternPosix = toPosixPath(absolutePattern);

      if (!roots.some(root => isWithinRoot(absolutePattern, root))) {
        throw new Error(`Glob pattern is outside allowed roots: ${pattern}`);
      }

      if (!/[*?]/.test(patternPosix)) {
        if (!fs.existsSync(absolutePattern)) {
          return { matches: [] };
        }
        return { matches: [absolutePattern] };
      }

      const searchRoot = getSearchRoot(patternPosix);
      if (!roots.some(root => isWithinRoot(searchRoot, root))) {
        throw new Error(`Glob search root is outside allowed roots: ${searchRoot}`);
      }

      const regex = globToRegex(patternPosix);
      const limit = Math.min(maxResults || 200, 2000);
      const candidates = walkFileTree(searchRoot, {
        includeFiles: true,
        includeDirs: true,
        maxResults: limit * 5
      });

      const matches = candidates.filter(candidate => {
        const posixCandidate = toPosixPath(candidate);
        return regex.test(posixCandidate);
      });

      return { matches: matches.slice(0, limit) };
    })
  });

  const grepTool = tool({
    name: 'Grep',
    description: 'Search for a pattern in files.',
    inputSchema: z.object({
      pattern: z.string().describe('Search pattern (plain text or regex)'),
      path: z.string().optional().describe('File or directory path (default /workspace/group)'),
      glob: z.string().optional().describe('Glob pattern to filter files (default **/*)'),
      regex: z.boolean().optional().describe('Treat pattern as regex'),
      maxResults: z.number().int().positive().optional().describe('Maximum matches')
    }),
    outputSchema: z.object({
      matches: z.array(z.object({
        path: z.string(),
        lineNumber: z.number(),
        line: z.string()
      }))
    }),
    execute: wrapExecute('Grep', async ({
      pattern,
      path: targetPath,
      glob,
      regex,
      maxResults
    }: { pattern: string; path?: string; glob?: string; regex?: boolean; maxResults?: number }) => {
      const basePath = resolvePath(targetPath || WORKSPACE_GROUP, isMain, true);
      const stats = fs.statSync(basePath);
      const limit = Math.min(maxResults || 200, 2000);
      const results: Array<{ path: string; lineNumber: number; line: string }> = [];

      const matcher = regex ? new RegExp(pattern, 'i') : null;
      const globPattern = glob || '**/*';
      const globRegex = globToRegex(toPosixPath(globPattern));

      const files = stats.isFile()
        ? [basePath]
        : walkFileTree(basePath, {
          includeFiles: true,
          includeDirs: false,
          maxResults: limit * 50
        });

      for (const file of files) {
        if (results.length >= limit) break;
        const relative = toPosixPath(path.relative(basePath, file) || '');
        if (relative && !globRegex.test(relative)) continue;
        let content: string;
        try {
          const stat = fs.statSync(file);
          if (stat.size > DEFAULT_GREP_MAX_FILE_BYTES) continue;
          content = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          const match = matcher ? matcher.test(line) : line.includes(pattern);
          if (match) {
            results.push({ path: file, lineNumber: i + 1, line });
            if (results.length >= limit) break;
          }
        }
      }

      return { matches: results };
    })
  });

  const webFetchTool = tool({
    name: 'WebFetch',
    description: 'Fetch a URL and return its contents.',
    inputSchema: z.object({
      url: z.string().describe('URL to fetch'),
      maxBytes: z.number().int().positive().optional().describe('Max bytes to read')
    }),
    outputSchema: z.object({
      url: z.string(),
      status: z.number(),
      contentType: z.string().nullable(),
      content: z.string(),
      truncated: z.boolean()
    }),
    execute: wrapExecute('WebFetch', async ({ url, maxBytes }: { url: string; maxBytes?: number }) => {
      let hostname: string;
      try {
        hostname = new URL(url).hostname.toLowerCase();
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }

      const isBlocked = webFetchBlocklist.some(domain =>
        hostname === domain || hostname.endsWith(`.${domain}`)
      );
      if (isBlocked) {
        throw new Error(`WebFetch blocked for host: ${hostname}`);
      }

      if (webFetchAllowlist.length > 0) {
        const isAllowed = webFetchAllowlist.some(domain =>
          hostname === domain || hostname.endsWith(`.${domain}`)
        );
        if (!isAllowed) {
          throw new Error(`WebFetch not allowed for host: ${hostname}`);
        }
      }

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'DotClaw/1.0',
          'Accept': 'text/html,application/json,text/plain,*/*'
        }
      });
      const { body, truncated } = await readResponseWithLimit(response, maxBytes || DEFAULT_WEBFETCH_MAX_BYTES);
      const contentType = response.headers.get('content-type');
      let content = '';
      if (contentType && (contentType.includes('text') || contentType.includes('json'))) {
        content = body.toString('utf-8');
      } else {
        content = body.toString('utf-8');
      }
      const limited = limitText(content, DEFAULT_TOOL_OUTPUT_LIMIT);
      return {
        url,
        status: response.status,
        contentType,
        content: limited.text,
        truncated: truncated || limited.truncated
      };
    })
  });

  const webSearchTool = tool({
    name: 'WebSearch',
    description: 'Search the web using Brave Search API.',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
      count: z.number().int().positive().optional().describe('Number of results (default 5)'),
      offset: z.number().int().nonnegative().optional().describe('Offset for pagination'),
      safesearch: z.enum(['off', 'moderate', 'strict']).optional().describe('Safe search setting')
    }),
    outputSchema: z.object({
      query: z.string(),
      results: z.array(z.object({
        title: z.string().nullable(),
        url: z.string().nullable(),
        description: z.string().nullable()
      }))
    }),
    execute: wrapExecute('WebSearch', async ({
      query,
      count,
      offset,
      safesearch
    }: { query: string; count?: number; offset?: number; safesearch?: 'off' | 'moderate' | 'strict' }) => {
      const apiKey = process.env.BRAVE_SEARCH_API_KEY;
      if (!apiKey) {
        throw new Error('BRAVE_SEARCH_API_KEY is not set');
      }
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(count || 5, 20)),
        offset: String(offset || 0),
        safesearch: safesearch || 'moderate'
      });
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey
        }
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Brave search error (${response.status}): ${text}`);
      }
      const data = await response.json();
      const results = (data?.web?.results || []).map((result: any) => ({
        title: result?.title ?? null,
        url: result?.url ?? null,
        description: result?.description ?? result?.snippet ?? null
      }));
      return { query, results };
    })
  });

  const sendMessageTool = tool({
    name: 'mcp__dotclaw__send_message',
    description: 'Send a message to the current Telegram chat.',
    inputSchema: z.object({
      text: z.string().describe('The message text to send')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__send_message', async ({ text }: { text: string }) => ipc.sendMessage(text))
  });

  const scheduleTaskTool = tool({
    name: 'mcp__dotclaw__schedule_task',
    description: 'Schedule a recurring or one-time task.',
    inputSchema: z.object({
      prompt: z.string().describe('Task prompt'),
      schedule_type: z.enum(['cron', 'interval', 'once']),
      schedule_value: z.string(),
      context_mode: z.enum(['group', 'isolated']).optional(),
      target_group: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__schedule_task', async (args: { prompt: string; schedule_type: 'cron' | 'interval' | 'once'; schedule_value: string; context_mode?: 'group' | 'isolated'; target_group?: string }) =>
      ipc.scheduleTask(args))
  });

  const listTasksTool = tool({
    name: 'mcp__dotclaw__list_tasks',
    description: 'List all scheduled tasks.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      ok: z.boolean(),
      tasks: z.array(z.any())
    }),
    execute: wrapExecute('mcp__dotclaw__list_tasks', async () => ipc.listTasks())
  });

  const pauseTaskTool = tool({
    name: 'mcp__dotclaw__pause_task',
    description: 'Pause a scheduled task.',
    inputSchema: z.object({
      task_id: z.string()
    }),
    outputSchema: z.object({
      ok: z.boolean()
    }),
    execute: wrapExecute('mcp__dotclaw__pause_task', async ({ task_id }: { task_id: string }) => ipc.pauseTask(task_id))
  });

  const resumeTaskTool = tool({
    name: 'mcp__dotclaw__resume_task',
    description: 'Resume a paused task.',
    inputSchema: z.object({
      task_id: z.string()
    }),
    outputSchema: z.object({
      ok: z.boolean()
    }),
    execute: wrapExecute('mcp__dotclaw__resume_task', async ({ task_id }: { task_id: string }) => ipc.resumeTask(task_id))
  });

  const cancelTaskTool = tool({
    name: 'mcp__dotclaw__cancel_task',
    description: 'Cancel a scheduled task.',
    inputSchema: z.object({
      task_id: z.string()
    }),
    outputSchema: z.object({
      ok: z.boolean()
    }),
    execute: wrapExecute('mcp__dotclaw__cancel_task', async ({ task_id }: { task_id: string }) => ipc.cancelTask(task_id))
  });

  const registerGroupTool = tool({
    name: 'mcp__dotclaw__register_group',
    description: 'Register a new Telegram chat (main group only).',
    inputSchema: z.object({
      jid: z.string(),
      name: z.string(),
      folder: z.string(),
      trigger: z.string().optional()
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__register_group', async ({ jid, name, folder, trigger }: { jid: string; name: string; folder: string; trigger?: string }) =>
      ipc.registerGroup({ jid, name, folder, trigger }))
  });

  const setModelTool = tool({
    name: 'mcp__dotclaw__set_model',
    description: 'Set the active OpenRouter model (main group only).',
    inputSchema: z.object({
      model: z.string().describe('OpenRouter model ID (e.g., moonshotai/kimi-k2.5)')
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional()
    }),
    execute: wrapExecute('mcp__dotclaw__set_model', async ({ model }: { model: string }) => ipc.setModel({ model }))
  });

  const tools: Array<ReturnType<typeof tool>> = [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    sendMessageTool,
    scheduleTaskTool,
    listTasksTool,
    pauseTaskTool,
    resumeTaskTool,
    cancelTaskTool,
    registerGroupTool,
    setModelTool
  ];

  if (enableBash) tools.push(bashTool as ReturnType<typeof tool>);
  if (enableWebSearch) tools.push(webSearchTool as ReturnType<typeof tool>);
  if (enableWebFetch) tools.push(webFetchTool as ReturnType<typeof tool>);

  return tools;
}
