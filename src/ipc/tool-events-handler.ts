import pino from 'pino';

import { insertToolEvent } from '../db/index.js';

export interface ToolEventIpc {
  session_id: string;
  tool_name: string;
  tool_use_id?: string;
  hook_event: string;
  tool_input?: string;
  tool_response?: string;
  timestamp: string;
}

/**
 * Handle a tool event from IPC processing.
 * Writes the event to the tool_call_events table.
 */
export async function handleToolEventIpc(
  data: ToolEventIpc,
  sourceGroup: string,
  log?: pino.Logger,
): Promise<void> {
  const eventLog = log ?? console;

  try {
    insertToolEvent({
      session_id: data.session_id,
      group_folder: sourceGroup,
      tool_name: data.tool_name,
      tool_use_id: data.tool_use_id,
      hook_event: data.hook_event,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      timestamp: data.timestamp,
    });

    eventLog.info?.(
      { tool: data.tool_name, hook: data.hook_event, session: data.session_id },
      'Tool event recorded',
    );
  } catch (err) {
    eventLog.error?.(
      { err, tool: data.tool_name, hook: data.hook_event },
      'Failed to insert tool event',
    );
    throw err;
  }
}
