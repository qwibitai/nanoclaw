/**
 * Google Workspace MCP Server for NanoClaw
 *
 * Thin passthrough wrapper around the Google Workspace CLI (gws).
 * Preserves gws's dynamic API discovery while adding:
 * - Guardrails: write operations require user confirmation via nonce
 * - Audit logging: every tool call logged to gws-audit.jsonl
 *
 * Three tools:
 *   gws_discover  — list services or methods within a service
 *   gws_help      — get usage/parameter docs for a command
 *   gws_run       — execute any gws command (with guardrails)
 *
 * @see https://github.com/googleworkspace/cli
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// --- Configuration ---

const AUDIT_LOG_DIR = '/workspace/group/logs';
const AUDIT_LOG_FILE = path.join(AUDIT_LOG_DIR, 'gws-audit.jsonl');
const GWS_BIN = 'gws';
const EXEC_TIMEOUT_MS = 120_000;
const HELP_TIMEOUT_MS = 15_000;
const DISCOVER_TIMEOUT_MS = 30_000;
const NONCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OUTPUT_SIZE = 100 * 1024; // 100KB
const GWS_CREDS_PATH = '/home/node/.config/gws/credentials.json';
const GWS_CLIENT_PATH = '/home/node/.config/gws/client_secret.json';

// --- Token management ---
// gws expects encrypted credential storage which doesn't work in containers.
// Instead, we read the mounted credentials.json (client_id + client_secret +
// refresh_token) and inject a fresh access token via GOOGLE_WORKSPACE_CLI_TOKEN.

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  try {
    if (!fs.existsSync(GWS_CREDS_PATH)) return null;
    const creds = JSON.parse(fs.readFileSync(GWS_CREDS_PATH, 'utf-8'));

    // If the file has client_id + refresh_token, exchange for access token
    if (creds.client_id && creds.client_secret && creds.refresh_token) {
      const params = new URLSearchParams({
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      });

      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!resp.ok) return null;
      const data = await resp.json();
      cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      };
      return cachedToken.token;
    }
  } catch {
    return null;
  }
  return null;
}

// --- Nonce store for write confirmation ---

const pendingNonces = new Map<string, { command: string; expiresAt: number }>();

function generateNonce(command: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  pendingNonces.set(nonce, {
    command,
    expiresAt: Date.now() + NONCE_EXPIRY_MS,
  });
  return nonce;
}

function consumeNonce(nonce: string, command: string): boolean {
  const entry = pendingNonces.get(nonce);
  if (!entry) return false;
  pendingNonces.delete(nonce);
  if (Date.now() > entry.expiresAt) return false;
  // Verify the command matches what was originally requested
  if (entry.command !== command) return false;
  return true;
}

// Periodic cleanup of expired nonces
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingNonces) {
    if (now > entry.expiresAt) pendingNonces.delete(key);
  }
}, 60_000);

// --- Operation classification ---

const WRITE_PATTERNS = [
  'create', 'insert', 'update', 'patch', 'delete', 'remove',
  'trash', 'send', 'modify', 'copy', 'move', 'batchupdate',
  'empty', 'import', 'untrash', 'archive', 'star', 'label',
  'forward', 'reply', 'reply-all',
  '+send', '+reply', '+reply-all', '+forward',
];

const READ_PATTERNS = [
  'list', 'get', 'search', 'query', 'export', 'watch', 'resolve',
  '+read', '+triage', '+watch',
  'discover', 'help', '--help',
];

function classifyOperation(command: string): 'read' | 'write' {
  const lower = command.toLowerCase();
  const tokens = lower.split(/\s+/);

  // Check read patterns first (more specific matches)
  for (const token of tokens) {
    if (READ_PATTERNS.some(p => token === p || token.endsWith(p))) {
      return 'read';
    }
  }

  // Check write patterns
  for (const token of tokens) {
    if (WRITE_PATTERNS.some(p => token === p || token.endsWith(p))) {
      return 'write';
    }
  }

  // Default to write (safe fallback)
  return 'write';
}

// --- Audit logging ---

interface AuditEntry {
  timestamp: string;
  tool: string;
  command: string;
  classification: 'read' | 'write' | 'discover' | 'help';
  confirmed: boolean | null;
  nonce?: string;
  status: 'success' | 'error' | 'confirmation_required' | 'nonce_invalid';
  duration_ms: number;
  result_size: number;
  error: string | null;
}

function writeAuditLog(entry: AuditEntry): void {
  try {
    fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Audit logging should never break the tool
  }
}

// --- Command execution ---

async function execGws(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const token = await getAccessToken();
  const env = { ...process.env };
  if (token) {
    env.GOOGLE_WORKSPACE_CLI_TOKEN = token;
  }

  return new Promise((resolve) => {
    execFile(GWS_BIN, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env,
    }, (error, stdout, stderr) => {
      let output = stdout || '';
      if (output.length > MAX_OUTPUT_SIZE) {
        output = output.slice(0, MAX_OUTPUT_SIZE) + '\n... [output truncated at 100KB]';
      }
      resolve({
        stdout: output,
        stderr: stderr || '',
        exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code === 'ETIMEDOUT' ? 124 : 1 : 0,
      });
    });
  });
}

/**
 * Parse a command string into arguments, respecting shell quoting.
 * Handles single quotes, double quotes, and backslash escapes.
 */
function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if ((char === ' ' || char === '\t') && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

// --- MCP Server ---

const server = new McpServer({
  name: 'gws',
  version: '1.0.0',
});

// Tool descriptions include common examples so models have a starting point
// without needing to call gws_discover first.

server.tool(
  'gws_discover',
  `List available Google Workspace services, or list methods/commands within a specific service.
Use this to find out what operations are available before calling gws_run.

Examples:
  gws_discover()                    → list all services
  gws_discover({ service: "gmail" }) → list Gmail commands and methods
  gws_discover({ service: "drive" }) → list Drive commands and methods

Available services include: gmail, drive, sheets, calendar, slides, docs, people, chat, forms, keep, meet, admin, classroom, tasks`,
  {
    service: z.string().optional().describe('Service name to explore (e.g., "gmail", "drive", "calendar"). Omit to list all services.'),
  },
  async (args) => {
    const start = Date.now();
    const gwsArgs = args.service ? [args.service, '--help'] : ['--help'];

    const result = await execGws(gwsArgs, DISCOVER_TIMEOUT_MS);

    writeAuditLog({
      timestamp: new Date().toISOString(),
      tool: 'gws_discover',
      command: args.service || '(all services)',
      classification: 'discover',
      confirmed: null,
      status: result.exitCode === 0 ? 'success' : 'error',
      duration_ms: Date.now() - start,
      result_size: result.stdout.length,
      error: result.exitCode !== 0 ? result.stderr : null,
    });

    const output = result.exitCode === 0
      ? result.stdout
      : `Error (exit ${result.exitCode}):\n${result.stderr}\n${result.stdout}`;

    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'gws_help',
  `Get detailed help for a specific Google Workspace CLI command, including parameters and usage.

Examples:
  gws_help({ service: "gmail", command: "+send" })        → how to send email
  gws_help({ service: "gmail", command: "+read" })         → how to read email
  gws_help({ service: "calendar", command: "events list" }) → how to list events
  gws_help({ service: "drive", command: "files list" })    → how to list files`,
  {
    service: z.string().describe('Service name (e.g., "gmail", "drive", "calendar")'),
    command: z.string().optional().describe('Command or method to get help for (e.g., "+send", "files list"). Omit for service-level help.'),
  },
  async (args) => {
    const start = Date.now();
    const gwsArgs = [args.service];
    if (args.command) {
      gwsArgs.push(...args.command.split(/\s+/));
    }
    gwsArgs.push('--help');

    const result = await execGws(gwsArgs, HELP_TIMEOUT_MS);

    writeAuditLog({
      timestamp: new Date().toISOString(),
      tool: 'gws_help',
      command: `${args.service} ${args.command || ''}`.trim(),
      classification: 'help',
      confirmed: null,
      status: result.exitCode === 0 ? 'success' : 'error',
      duration_ms: Date.now() - start,
      result_size: result.stdout.length,
      error: result.exitCode !== 0 ? result.stderr : null,
    });

    const output = result.exitCode === 0
      ? result.stdout
      : `Error (exit ${result.exitCode}):\n${result.stderr}\n${result.stdout}`;

    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'gws_run',
  `Execute any Google Workspace CLI command. This is the main tool for interacting with Google Workspace services.

IMPORTANT — WRITE OPERATIONS REQUIRE CONFIRMATION:
When you call this with a write operation (send, create, update, delete, etc.), the tool will return a confirmation_required response with a nonce. You MUST then:
1. Use send_message to ask the user for confirmation, showing them exactly what will happen
2. Wait for the user to reply "yes" / "approve" / "go ahead" (or similar)
3. Call gws_run again with the SAME command and the nonce to execute

Read operations (list, get, search, read, triage) execute immediately.

Examples:
  gws_run({ command: "gmail +triage" })                                → list unread emails (read, immediate)
  gws_run({ command: "gmail +read --id 18e4f2a" })                     → read an email (read, immediate)
  gws_run({ command: "gmail +send --to user@example.com --subject 'Hello' --body 'Hi there'" }) → send email (write, needs confirmation)
  gws_run({ command: "drive files list --q 'name contains report'" })  → list Drive files (read, immediate)
  gws_run({ command: "calendar events list --calendarId primary" })    → list calendar events (read, immediate)
  gws_run({ command: "sheets spreadsheets.values get --spreadsheetId ID --range A1:B10" }) → read sheet (read, immediate)`,
  {
    command: z.string().describe('The gws command to execute (without the "gws" prefix). E.g., "gmail +send --to user@example.com --subject Hello"'),
    confirmed_nonce: z.string().optional().describe('Confirmation nonce returned by a previous confirmation_required response. Required for write operations.'),
  },
  async (args) => {
    const start = Date.now();
    const classification = classifyOperation(args.command);
    const gwsArgs = parseCommand(args.command);

    // Write operations require confirmation
    if (classification === 'write') {
      if (!args.confirmed_nonce) {
        // First call — return confirmation request with nonce
        const nonce = generateNonce(args.command);

        writeAuditLog({
          timestamp: new Date().toISOString(),
          tool: 'gws_run',
          command: args.command,
          classification: 'write',
          confirmed: false,
          nonce,
          status: 'confirmation_required',
          duration_ms: Date.now() - start,
          result_size: 0,
          error: null,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'confirmation_required',
              operation: args.command,
              nonce,
              message: 'This write operation requires user confirmation. Send a message to the user describing what will happen, then call gws_run again with the same command and the confirmed_nonce parameter set to this nonce after they approve.',
            }, null, 2),
          }],
        };
      }

      // Second call — verify nonce and execute
      if (!consumeNonce(args.confirmed_nonce, args.command)) {
        writeAuditLog({
          timestamp: new Date().toISOString(),
          tool: 'gws_run',
          command: args.command,
          classification: 'write',
          confirmed: false,
          nonce: args.confirmed_nonce,
          status: 'nonce_invalid',
          duration_ms: Date.now() - start,
          result_size: 0,
          error: 'Invalid, expired, or mismatched confirmation nonce',
        });

        return {
          content: [{
            type: 'text' as const,
            text: 'Confirmation failed: invalid, expired, or mismatched nonce. Please start the confirmation flow again by calling gws_run without a nonce.',
          }],
          isError: true,
        };
      }
    }

    // Execute the command
    const result = await execGws(gwsArgs, EXEC_TIMEOUT_MS);

    writeAuditLog({
      timestamp: new Date().toISOString(),
      tool: 'gws_run',
      command: args.command,
      classification,
      confirmed: classification === 'write' ? true : null,
      nonce: args.confirmed_nonce || undefined,
      status: result.exitCode === 0 ? 'success' : 'error',
      duration_ms: Date.now() - start,
      result_size: result.stdout.length,
      error: result.exitCode !== 0 ? result.stderr : null,
    });

    if (result.exitCode !== 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `Command failed (exit ${result.exitCode}):\n${result.stderr}\n${result.stdout}`,
        }],
        isError: true,
      };
    }

    return { content: [{ type: 'text' as const, text: result.stdout }] };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
