import fs from 'fs';
import path from 'path';

import {
  HookCallback,
  PreCompactHookInput,
  SessionStartHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { log } from './io.js';
import {
  formatTranscriptMarkdown,
  generateFallbackName,
  getSessionSummary,
  parseTranscript,
  sanitizeFilename,
} from './transcript.js';
import { WORKSPACE_GLOBAL, WORKSPACE_GROUP } from './workspace.js';

/**
 * Archive the full transcript to conversations/ before compaction.
 */
export function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

/**
 * Re-inject CLAUDE.md into context after compact or clear so instructions
 * survive context compaction.
 */
export function createSessionStartHook(isMain: boolean): HookCallback {
  return async (input) => {
    const sessionStart = input as SessionStartHookInput;
    if (sessionStart.source !== 'compact' && sessionStart.source !== 'clear') {
      return {};
    }

    const parts: string[] = [];

    const groupPath = path.join(WORKSPACE_GROUP, 'CLAUDE.md');
    if (fs.existsSync(groupPath)) {
      parts.push(fs.readFileSync(groupPath, 'utf-8'));
    }

    if (!isMain) {
      const globalPath = path.join(WORKSPACE_GLOBAL, 'CLAUDE.md');
      if (fs.existsSync(globalPath)) {
        parts.push(fs.readFileSync(globalPath, 'utf-8'));
      }
    }

    if (parts.length === 0) return {};

    const content = parts.join('\n\n---\n\n');
    log(
      `SessionStart(${sessionStart.source}): injecting CLAUDE.md (${content.length} chars)`,
    );
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart' as const,
        additionalContext: content,
      },
    };
  };
}
