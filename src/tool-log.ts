/**
 * Tool Call Log — appends a JSON-lines audit trail of every MCP tool invocation
 * processed by the IPC dispatcher. Used for debugging agent behavior without
 * needing to dig through raw audit/ files.
 *
 * Log file: data/tool-calls.jsonl
 * Rotates at 10 MB → data/tool-calls.jsonl.1 (single-file rotation)
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

const LOG_FILE = path.join(DATA_DIR, 'tool-calls.jsonl');
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ToolLogEntry {
  ts: string;
  group: string;
  thread?: string;
  type: string;
  durationMs: number;
  ok: boolean;
  detail?: Record<string, unknown>;
  error?: string;
}

/**
 * Extract a small summary of args relevant to each IPC type.
 * Avoids logging full message bodies — just enough to identify the call.
 */
export function buildToolDetail(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  switch (type) {
    case 'message':
      return {
        chatJid: data.chatJid,
        textLen: typeof data.text === 'string' ? data.text.length : undefined,
        isScheduled: data.isScheduled,
      };
    case 'send_files':
      return {
        chatJid: data.chatJid,
        fileCount: Array.isArray(data.files) ? data.files.length : 0,
      };
    case 'schedule_task':
      return {
        scheduleType: data.schedule_type,
        scheduleValue: data.schedule_value,
        contextMode: data.context_mode,
      };
    case 'update_task':
    case 'pause_task':
    case 'resume_task':
    case 'cancel_task':
      return { taskId: data.task_id };
    case 'list_tasks':
      return { requestId: data.requestId };
    case 'register_group':
      return { jid: data.jid, folder: data.folder };
    case 'debug_query':
      return { queryId: data.id };
    default:
      return undefined;
  }
}

/**
 * Append a tool call entry to the JSONL log file.
 * Never throws — logging must not break core functionality.
 */
export function appendToolLog(entry: ToolLogEntry): void {
  try {
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_BYTES) {
        fs.renameSync(LOG_FILE, LOG_FILE + '.1');
      }
    } catch {
      // File doesn't exist yet — fine
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort — never propagate
  }
}
