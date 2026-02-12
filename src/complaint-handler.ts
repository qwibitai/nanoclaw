/**
 * complaint-handler.ts — Direct in-process complaint handler.
 *
 * Handles 1:1 complaint messages using the Agent SDK's query() function
 * with an in-process MCP server. No containers, no IPC.
 */
import fs from 'fs';
import path from 'path';

import {
  query,
  tool,
  createSdkMcpServer,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { COMPLAINT_MAX_TURNS, COMPLAINT_MODEL, DATA_DIR } from './config.js';
import { getComplaintSession, getDb, setComplaintSession } from './db.js';
import { logger } from './logger.js';
import { escapeXml } from './router.js';
import {
  createComplaint,
  queryComplaints,
  updateComplaint,
  getCategories,
  getUser,
  updateUser,
  resolveArea,
} from './complaint-mcp-server.js';

// Cached system prompt (loaded once from runtime CLAUDE.md)
let cachedSystemPrompt: string | null = null;

// Per-user mutex to serialize concurrent messages from same user
const userLocks: Map<string, Promise<void>> = new Map();

/** MCP tool content result type. */
type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** Wrap a sync tool function into an async MCP handler with standard error handling. */
function wrapToolHandler<P>(
  fn: (params: P) => unknown,
): (params: P) => Promise<ToolResult> {
  return async (params: P) => {
    try {
      const result = fn(params);
      const text =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  };
}

function loadSystemPrompt(): string {
  if (cachedSystemPrompt) return cachedSystemPrompt;

  // Load the runtime-injected CLAUDE.md (tenant variables already replaced)
  const runtimePath = path.join(DATA_DIR, 'runtime', 'complaint', 'CLAUDE.md');
  const fallbackPath = path.join(
    process.cwd(),
    'groups',
    'complaint',
    'CLAUDE.md',
  );

  const promptPath = fs.existsSync(runtimePath) ? runtimePath : fallbackPath;
  cachedSystemPrompt = fs.readFileSync(promptPath, 'utf-8');

  // Replace tool usage section between delimiter comments
  cachedSystemPrompt = cachedSystemPrompt.replace(
    /<!-- TOOL_USAGE_START -->[\s\S]*?<!-- TOOL_USAGE_END -->/,
    `<!-- TOOL_USAGE_START -->
## Tool Usage

You have access to complaint management tools via MCP. Use them directly — do not use bash or shell commands.

### create_complaint
Creates a new complaint and returns a tracking ID.
Parameters: phone, category, description, location, language

### query_complaints
Look up complaints by phone number or complaint ID.
Parameters: phone (optional), id (optional)

### update_complaint
Update the status of an existing complaint.
Parameters: id, status, note (optional)
Valid statuses: registered, acknowledged, in_progress, action_taken, resolved, on_hold, escalated

### get_categories
List all available complaint categories. No parameters.

### get_user
Retrieve user profile. Call this at the START of every conversation to check if this is a returning user.
Parameters: phone

### update_user
Save or update user details — name, date of birth, language preference.
Parameters: phone, name (optional), date_of_birth (optional, YYYY-MM-DD), language (optional)

### resolve_area
Fuzzy-match a location text against known areas. Returns ranked matches with confidence scores.
Parameters: location_text

<!-- TOOL_USAGE_END -->`,
  );

  return cachedSystemPrompt;
}

function buildMcpServer() {
  const db = getDb();

  return createSdkMcpServer({
    name: 'complaint',
    version: '1.0.0',
    tools: [
      tool(
        'create_complaint',
        'Create a new complaint and return tracking ID',
        {
          phone: z.string().describe('Phone number of the complainant'),
          category: z
            .string()
            .optional()
            .describe('Complaint category (e.g. water_supply, roads)'),
          description: z.string().max(5000).describe('Full description of the complaint'),
          location: z
            .string()
            .optional()
            .describe('Location details (ward, area, landmark)'),
          language: z.string().describe('Language code: mr, hi, or en'),
          source: z
            .enum(['text', 'voice'])
            .optional()
            .describe('Message source: text or voice'),
          voice_message_id: z
            .string()
            .optional()
            .describe('WhatsApp voice message ID (when source is voice)'),
        },
        wrapToolHandler((params) => createComplaint(db, params)),
      ),
      tool(
        'query_complaints',
        'Look up complaints by phone number or complaint ID',
        {
          phone: z
            .string()
            .optional()
            .describe('Phone number to look up complaints for'),
          id: z.string().optional().describe('Specific complaint tracking ID'),
        },
        wrapToolHandler((params) => queryComplaints(db, params)),
      ),
      tool(
        'update_complaint',
        'Update the status of an existing complaint',
        {
          id: z.string().describe('Complaint tracking ID'),
          status: z
            .string()
            .describe(
              'New status: registered, acknowledged, in_progress, action_taken, resolved, on_hold, escalated',
            ),
          note: z
            .string()
            .optional()
            .describe('Optional note about the status change'),
        },
        wrapToolHandler((params) => updateComplaint(db, params)),
      ),
      tool(
        'get_categories',
        'List all available complaint categories',
        {},
        wrapToolHandler(() => getCategories(db)),
      ),
      tool(
        'get_user',
        'Get user profile (name, language, DOB, complaint count, blocked status)',
        {
          phone: z.string().describe('Phone number of the user'),
        },
        wrapToolHandler((params) => getUser(db, params)),
      ),
      tool(
        'update_user',
        'Save or update user details (name, date of birth, language preference)',
        {
          phone: z.string().describe('Phone number of the user'),
          name: z
            .string()
            .optional()
            .describe('Full name of the user (e.g. "Riyaz Shaikh")'),
          date_of_birth: z
            .string()
            .optional()
            .describe('Date of birth in YYYY-MM-DD format'),
          language: z
            .string()
            .optional()
            .describe('Preferred language code: mr, hi, or en'),
        },
        wrapToolHandler((params) => updateUser(db, params)),
      ),
      tool(
        'resolve_area',
        'Fuzzy-match a location text against known areas. Returns ranked matches.',
        {
          location_text: z
            .string()
            .describe('Location text to match against areas'),
        },
        wrapToolHandler((params) => resolveArea(db, params)),
      ),
    ],
  });
}

/**
 * Handle a complaint message from a 1:1 chat.
 * Calls the Agent SDK query() in-process with MCP tools.
 * Serializes concurrent messages from the same user via per-user mutex.
 */
export async function handleComplaintMessage(
  phone: string,
  userName: string,
  content: string,
): Promise<string> {
  // Acquire per-user lock to serialize messages from the same user
  const prevLock = userLocks.get(phone) ?? Promise.resolve();
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  userLocks.set(phone, lockPromise);

  try {
    await prevLock;
    return await _executeQuery(phone, userName, content);
  } finally {
    releaseLock!();
    // Clean up lock if we're the last in the chain
    if (userLocks.get(phone) === lockPromise) {
      userLocks.delete(phone);
    }
  }
}

async function _executeQuery(
  phone: string,
  userName: string,
  content: string,
): Promise<string> {
  const systemPrompt = loadSystemPrompt();
  const savedSessionId = getComplaintSession(phone);
  const mcpServer = buildMcpServer();

  // Build user prompt with context (XML-escaped to prevent injection)
  const prompt = `<user-context phone="${escapeXml(phone)}" name="${escapeXml(userName)}" />\n${content}`;

  logger.info(
    { phone, hasSession: !!savedSessionId },
    'Starting complaint query',
  );

  let resultText = '';
  let newSessionId: string | undefined;

  const q = query({
    prompt,
    options: {
      systemPrompt,
      model: COMPLAINT_MODEL,
      mcpServers: { complaint: mcpServer },
      allowedTools: ['mcp__complaint__*'],
      disallowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'NotebookEdit',
        'Task',
      ],
      maxTurns: COMPLAINT_MAX_TURNS,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      resume: savedSessionId,
    },
  });

  try {
    for await (const message of q) {
      // Capture session ID from any message
      if ('session_id' in message) {
        newSessionId = message.session_id;
      }

      if (message.type === 'result') {
        if (message.subtype === 'success' && 'result' in message) {
          resultText = (message as { result: string }).result;
        } else {
          // Error result — log and throw so caller can send fallback message
          const errors =
            'errors' in message ? (message as { errors: string[] }).errors : [];
          logger.error(
            { phone, subtype: message.subtype, errors },
            'Agent SDK query returned error result',
          );
          throw new Error(
            `Agent query failed: ${message.subtype} — ${errors.join('; ') || 'no details'}`,
          );
        }
      }
    }
  } catch (err) {
    // Persist session even on error so next message can resume
    if (newSessionId) {
      setComplaintSession(phone, newSessionId);
    }
    logger.error({ phone, err }, 'Agent SDK query error');
    throw err;
  }

  // Persist session ID for conversation continuity
  if (newSessionId) {
    setComplaintSession(phone, newSessionId);
  }

  if (!resultText) {
    logger.warn(
      { phone, sessionId: newSessionId?.slice(0, 8) },
      'Agent query completed with empty result',
    );
  }

  logger.info(
    {
      phone,
      resultLength: resultText.length,
      sessionId: newSessionId?.slice(0, 8),
    },
    'Complaint query complete',
  );

  return resultText;
}

/** Clear cached system prompt (for testing). */
export function _clearPromptCache(): void {
  cachedSystemPrompt = null;
}
