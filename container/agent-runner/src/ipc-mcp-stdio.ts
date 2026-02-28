/**
 * Stdio MCP Server for Sovereign
 * Slim server shell: creates the MCP server, wraps tools with observability
 * and security guard, then delegates tool registration to the plugin system.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path from 'path';

import { createToolContext, IPC_DIR } from './tool-context.js';
import { registerAllTools } from './tools/index.js';

const ctx = createToolContext();

const server = new McpServer({
  name: 'sovereign',
  version: '1.0.0',
});


// ── Tool Observability — log every tool call to JSONL ────────────────
// Async append, non-blocking. Credential patterns scrubbed from args.

const SESSION_ID = `${ctx.groupFolder}-${Date.now()}`;

const CRED_PATTERNS = [
  /\b(sk-[a-zA-Z0-9]{20,})\b/g,
  /\b(ghp_[a-zA-Z0-9]{36,})\b/g,
  /\b(AKIA[A-Z0-9]{12,})\b/g,
  /\b(xoxb-[a-zA-Z0-9-]+)\b/g,
  /\b(Bearer\s+[a-zA-Z0-9._-]{20,})\b/g,
  /\b([a-f0-9]{64})\b/g,
];

function scrubText(text: string): string {
  let r = text;
  for (const p of CRED_PATTERNS) r = r.replace(p, '[REDACTED]');
  return r;
}

function scrubObjValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      let s = scrubText(v);
      if (s.length > 500) s = s.slice(0, 500) + '...';
      out[k] = s;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = scrubObjValues(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function logToolCall(
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  resultSize: number,
  success: boolean,
  error?: string,
): void {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const logPath = path.join(IPC_DIR, `tool-calls-${yyyy}-${mm}-${dd}.jsonl`);

  const entry = JSON.stringify({
    timestamp: now.toISOString(),
    tool,
    args: scrubObjValues(args),
    duration_ms: Math.round(durationMs),
    result_size: resultSize,
    success,
    ...(error ? { error: scrubText(error).slice(0, 200) } : {}),
    session_id: SESSION_ID,
  });

  // Async append — fire and forget, never blocks tool execution
  fs.appendFile(logPath, entry + '\n', () => {});
}


// ── Tool Guard — pre-execution security layer ────────────────────────
// Blocks dangerous patterns in args, enforces per-agent tool permissions.

interface GuardVerdict {
  action: 'allow' | 'block';
  reason: string;
}

const GUARD_DEFAULT_BLOCK = [
  'rm -rf', 'rm -r /', 'DROP TABLE', 'DROP DATABASE',
  'TRUNCATE TABLE', 'shutdown', 'reboot', 'mkfs',
];

function loadGuardConfig(): { block: string[]; pause: string[]; allow: string[] } {
  try {
    const configPath = '/workspace/group/tool-guard.json';
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const userBlock = Array.isArray(raw.block) ? raw.block : [];
      return {
        block: [...new Set([...GUARD_DEFAULT_BLOCK, ...userBlock])],
        pause: Array.isArray(raw.pause) ? raw.pause : [],
        allow: Array.isArray(raw.allow) ? raw.allow : [],
      };
    }
  } catch { /* use defaults */ }
  return { block: GUARD_DEFAULT_BLOCK, pause: [], allow: [] };
}

const guardConfig = loadGuardConfig();

function evaluateGuard(
  toolName: string,
  callArgs: Record<string, unknown>,
): GuardVerdict {
  const serialized = `${toolName} ${JSON.stringify(callArgs)}`.toLowerCase().replace(/\s+/g, ' ');

  for (const pattern of guardConfig.block) {
    if (serialized.includes(pattern.toLowerCase())) {
      return { action: 'block', reason: `Matched block pattern: "${pattern}"` };
    }
  }

  if (guardConfig.allow.includes(toolName)) {
    return { action: 'allow', reason: 'In allow list' };
  }

  if (guardConfig.pause.includes(toolName)) {
    return { action: 'block', reason: `Tool "${toolName}" requires approval (in pause list)` };
  }

  return { action: 'allow', reason: 'No matching rule' };
}


// ── Wrap server.tool with observability + guard ──────────────────────

const originalTool = server.tool.bind(server);
type ToolCallback = (...callbackArgs: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

server.tool = function wrappedTool(name: string, ...rest: unknown[]) {
  const handlerIdx = rest.length - 1;
  const originalHandler = rest[handlerIdx] as ToolCallback;

  rest[handlerIdx] = async function observedHandler(...handlerArgs: unknown[]) {
    const start = performance.now();
    let success = true;
    let errorMsg: string | undefined;
    let resultText = '';

    try {
      const callArgs = (typeof handlerArgs[0] === 'object' && handlerArgs[0] !== null)
        ? handlerArgs[0] as Record<string, unknown>
        : {};
      const verdict = evaluateGuard(name, callArgs);
      if (verdict.action === 'block') {
        const msg = `\u26D4 Blocked by tool guard: ${verdict.reason}`;
        resultText = msg;
        success = false;
        errorMsg = `GUARD_BLOCKED: ${verdict.reason}`;
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }

      const result = await originalHandler(...handlerArgs);
      resultText = result.content?.map((c: { text: string }) => c.text).join('') ?? '';
      if (result.isError) {
        success = false;
        errorMsg = resultText.slice(0, 200);
      }
      return result;
    } catch (err) {
      success = false;
      errorMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const duration = performance.now() - start;
      const args = (typeof handlerArgs[0] === 'object' && handlerArgs[0] !== null)
        ? handlerArgs[0] as Record<string, unknown>
        : {};
      logToolCall(name, args, duration, resultText.length, success, errorMsg);
    }
  };

  return (originalTool as Function)(name, ...rest);
} as typeof server.tool;


// ── Register all tool plugins ────────────────────────────────────────

registerAllTools(server, ctx);


// ── Start transport ──────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
