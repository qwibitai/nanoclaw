import type pino from 'pino';

import { insertToolEvent } from '../db/index.js';

/**
 * Handle tool event IPC messages from agent sessions.
 * Receives tool call events from PostToolUse/PostToolUseFailure hooks.
 */
export async function handleToolEventIpc(
  data: {
    tool_name?: string;
    tool_use_id?: string;
    session_id?: string;
    hook_event?: string;
    tool_input?: string;
    tool_response?: string;
    timestamp?: string;
  },
  sourceGroup: string,
  log?: pino.Logger,
): Promise<void> {
  // Validate required fields
  if (!data.session_id || !data.tool_name || !data.timestamp) {
    log?.warn(
      { data, sourceGroup },
      'Ignoring tool event with missing required fields',
    );
    return;
  }

  // Insert into database
  try {
    insertToolEvent({
      session_id: data.session_id,
      group_folder: sourceGroup,
      tool_name: data.tool_name,
      tool_use_id: data.tool_use_id,
      hook_event: data.hook_event ?? 'PostToolUse',
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      timestamp: data.timestamp,
    });

    log?.debug({ tool: data.tool_name, session: data.session_id }, 'Tool event stored');
  } catch (err) {
    log?.error(
      { err, data, sourceGroup },
      'Failed to insert tool event into database',
    );
    throw err;
  }
}
