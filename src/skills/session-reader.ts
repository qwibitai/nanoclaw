/**
 * Session Reader
 * Reads Claude Code session JSONL transcripts to extract tool calls
 * made during a specific agent run, identified by time window.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { ToolCall } from '../types.js';

interface JournalEntry {
  type: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    content?: Array<{
      type: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: string | Array<{ type: string; text?: string }>;
    }>;
  };
}

/**
 * Find the session JSONL file for a group + session ID.
 * Claude Code stores sessions at: .claude/projects/{project-slug}/{sessionId}.jsonl
 * The project slug is derived from the container's working dir (/workspace/group → -workspace-group).
 */
function findSessionFile(
  groupFolder: string,
  sessionId: string,
): string | null {
  const claudeDir = path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  const projectsDir = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsDir)) return null;

  // Search all project subdirectories for the session file
  try {
    for (const projectSlug of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, projectSlug, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (err) {
    logger.debug({ err, groupFolder }, 'Error scanning session files');
  }

  return null;
}

/**
 * Extract tool calls from a session transcript for a specific time window.
 * Matches tool_use blocks in assistant entries to their tool_result in user entries.
 */
export function extractToolCallsForRun(
  groupFolder: string,
  sessionId: string,
  runStartMs: number,
  runEndMs: number,
): ToolCall[] {
  const sessionFile = findSessionFile(groupFolder, sessionId);
  if (!sessionFile) {
    logger.debug({ groupFolder, sessionId }, 'Session file not found for tool call extraction');
    return [];
  }

  let entries: JournalEntry[];
  try {
    const raw = fs.readFileSync(sessionFile, 'utf-8');
    entries = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEntry);
  } catch (err) {
    logger.warn({ err, sessionFile }, 'Failed to parse session JSONL');
    return [];
  }

  // Filter to entries within the run's time window
  const inWindow = (ts?: string): boolean => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return t >= runStartMs && t <= runEndMs + 5000; // 5s grace for tool results
  };

  // Build a map of tool_use_id → ToolCall from assistant entries
  const pendingCalls = new Map<string, Omit<ToolCall, 'output'>>();
  const results: ToolCall[] = [];

  for (const entry of entries) {
    if (entry.type === 'assistant' && inWindow(entry.timestamp)) {
      const content = entry.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          pendingCalls.set(block.id, {
            name: block.name,
            input: block.input ?? {},
          });
        }
      }
    }

    if (entry.type === 'user' && inWindow(entry.timestamp)) {
      const content = entry.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const pending = pendingCalls.get(block.tool_use_id);
          if (pending) {
            const raw = block.content;
            let output = '';
            if (typeof raw === 'string') {
              output = raw;
            } else if (Array.isArray(raw)) {
              output = raw
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('\n');
            }
            results.push({ ...pending, output: output.slice(0, 500) });
            pendingCalls.delete(block.tool_use_id);
          }
        }
      }
    }
  }

  return results;
}
