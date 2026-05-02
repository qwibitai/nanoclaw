// Self-observation tools — X reads its own conversation history across channels.
//
// Inside the NanoClaw container, messages.db is mounted read-only at
// /workspace/extra/messages-db/messages.db. The tool runs a local Python3
// script against it — no SSH needed.
//
// Fallback: if the mount is absent (e.g. running on the host), it SSHes to XPS.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { SshExecutor } from './ssh.js';
import { shellEscape } from './ssh.js';

/** Default and maximum limits for conversation queries. */
const DEFAULT_LINES = 20;
const MAX_LINES = 100;
const DEFAULT_HOURS = 4;

/** Path to messages.db when mounted inside the container. */
const LOCAL_DB_PATH = '/workspace/extra/messages-db/messages.db';

/** Path to messages.db on XPS host (for SSH fallback). */
const HOST_DB_PATH = '~/nanoclaw/store/messages.db';

/** SSH target for XPS (fallback only). */
const XPS_TARGET = 'xps';

export interface ReadConversationsOptions {
  channel?: 'slack' | 'telegram';
  lines?: number;
  search?: string;
  hours?: number;
}

/**
 * Build the Python3 script that queries messages.db.
 */
function buildPythonScript(dbPath: string, options: {
  lines: number;
  hours: number;
  channel?: string;
  search?: string;
}): string {
  const whereClauses: string[] = [
    `m.timestamp >= datetime('now', '-${options.hours} hours')`,
  ];

  if (options.channel) {
    whereClauses.push(`c.channel = '${options.channel}'`);
  }

  if (options.search) {
    const escapedSearch = options.search.replace(/'/g, "''");
    whereClauses.push(`m.content LIKE '%${escapedSearch}%'`);
  }

  const whereStr = whereClauses.join(' AND ');

  return `
import sqlite3, os
db_path = os.path.expanduser('${dbPath}')
conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
cursor = conn.cursor()
cursor.execute("""
  SELECT m.timestamp, c.channel, m.sender_name, m.is_from_me, m.content
  FROM messages m
  JOIN chats c ON m.chat_jid = c.jid
  WHERE ${whereStr}
  ORDER BY m.timestamp DESC
  LIMIT ${options.lines}
""")
rows = cursor.fetchall()
conn.close()
for row in rows:
    ts, ch, sender, is_me, content = row
    print(f"{ts} | {ch} | {sender} | {bool(is_me)} | {content}")
`.trim();
}

/**
 * Execute a Python3 script locally (inside the container).
 */
function execPythonLocal(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile('python3', ['-c', script], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        exitCode: error ? ((error as any).code as number | undefined) ?? 1 : 0,
      });
    });
  });
}

/**
 * Read X's own conversation history from messages.db.
 * Uses local mount if available, SSH to XPS as fallback.
 */
export async function readOwnConversations(
  ssh: SshExecutor,
  options?: ReadConversationsOptions,
): Promise<string> {
  const lines = Math.min(Math.max(options?.lines ?? DEFAULT_LINES, 1), MAX_LINES);
  const hours = options?.hours ?? DEFAULT_HOURS;
  const channel = options?.channel;
  const search = options?.search;

  const useLocal = existsSync(LOCAL_DB_PATH);
  const dbPath = useLocal ? LOCAL_DB_PATH : HOST_DB_PATH;
  const pythonScript = buildPythonScript(dbPath, { lines, hours, channel, search });

  let result: { stdout: string; stderr: string; exitCode: number };

  if (useLocal) {
    result = await execPythonLocal(pythonScript);
  } else {
    const cmd = `python3 -c ${shellEscape(pythonScript)}`;
    result = await ssh(XPS_TARGET, cmd);
  }

  if (result.exitCode !== 0) {
    return `Error reading conversations: ${result.stderr.trim()}`;
  }

  const output = result.stdout.trim();
  if (!output) {
    return 'No conversations found in the specified time range.';
  }

  return output;
}
