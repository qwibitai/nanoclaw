/**
 * stream-tool-logger.ts — Parse tool call events from Claude CLI stream-json output
 * and log them to the tool_call_events database.
 *
 * Used by host-side agents (CEO, ops) that run via spawned CLI processes instead
 * of containerized sessions with PostToolUse hooks.
 */

import { insertToolCallEvent } from './db/tool-events.js';
import { logger } from './logger.js';

interface StreamToolUseMessage {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

interface StreamToolResultMessage {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string }>;
}

interface StreamSystemMessage {
  type: 'system';
  subtype?: string;
  session_id?: string;
}

interface StreamMessageAny {
  type: string;
  subtype?: string;
  session_id?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

/**
 * Parse stream-json output line-by-line and log tool use events.
 * Tracks tool_use and tool_result pairs to build complete events.
 */
export class StreamToolLogger {
  private sessionId: string | null = null;
  private groupFolder: string;
  private toolUseMap = new Map<string, StreamToolUseMessage>();

  constructor(groupFolder: string) {
    this.groupFolder = groupFolder;
  }

  /**
   * Process a single line of stream-json output.
   * Extracts session_id from system/init messages and logs tool use/result pairs.
   */
  processLine(line: string): void {
    if (!line.trim()) return;

    let msg: StreamMessageAny;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Ignore non-JSON lines
    }

    // Extract session ID from system/init message
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      this.sessionId = msg.session_id;
    }

    // Track tool_use invocations
    if (msg.type === 'tool_use' && msg.id && msg.name) {
      this.toolUseMap.set(msg.id, {
        type: 'tool_use',
        id: msg.id,
        name: msg.name,
        input: msg.input,
      });
    }

    // Log tool_result events (matches tool_use by tool_use_id)
    if (msg.type === 'tool_result' && msg.tool_use_id) {
      const toolUse = this.toolUseMap.get(msg.tool_use_id);
      if (toolUse && this.sessionId) {
        this.logToolEvent(toolUse, msg as StreamToolResultMessage);
        this.toolUseMap.delete(msg.tool_use_id);
      }
    }
  }

  /**
   * Log a tool call event to the database.
   */
  private logToolEvent(
    toolUse: StreamToolUseMessage,
    toolResult: StreamToolResultMessage,
  ): void {
    if (!this.sessionId) return;

    try {
      let responseText = '';
      if (typeof toolResult.content === 'string') {
        responseText = toolResult.content;
      } else if (Array.isArray(toolResult.content)) {
        responseText = toolResult.content
          .map((c) => c.text || '')
          .join('\n');
      }

      insertToolCallEvent({
        session_id: this.sessionId,
        event_type: 'PostToolUse',
        tool_name: toolUse.name,
        payload: {
          group_folder: this.groupFolder,
          tool_use_id: toolUse.id,
          tool_input: JSON.stringify(toolUse.input ?? {}),
          tool_response: responseText.slice(0, 2000),
        },
      });

      logger.debug(
        {
          tool: toolUse.name,
          session: this.sessionId,
          group: this.groupFolder,
        },
        'Host-side tool event logged',
      );
    } catch (err) {
      logger.warn(
        {
          err,
          tool: toolUse.name,
          session: this.sessionId,
        },
        'Failed to log tool event',
      );
    }
  }

  /**
   * Get the extracted session ID (if any).
   */
  getSessionId(): string | null {
    return this.sessionId;
  }
}
