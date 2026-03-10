/**
 * HTTP API for NanoClaw
 * Provides REST endpoints for external integrations (e.g., Jarvis voice pipeline)
 */
import express, { Request, Response } from 'express';

import { ASSISTANT_NAME } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  AvailableGroup,
} from './container-runner.js';
import { getAllTasks, getSession, setSession } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Main group folder name (was removed from config exports)
const MAIN_GROUP_FOLDER = 'main';

export interface ApiOptions {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getAvailableGroups: () => AvailableGroup[];
  port?: number;
}

// Store active sessions in memory (synced with DB)
let sessions: Record<string, string> = {};

export function updateSessions(newSessions: Record<string, string>): void {
  sessions = newSessions;
}

/**
 * Create a virtual group for API sessions (like Jarvis)
 */
function createVirtualGroup(sessionFolder: string): { jid: string; group: RegisteredGroup } {
  return {
    jid: `api-${sessionFolder}@local`,
    group: {
      name: `API Session: ${sessionFolder}`,
      folder: sessionFolder,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    },
  };
}

/**
 * Create the Express HTTP API server
 */
export function createApi(options: ApiOptions): express.Application {
  const app = express();
  const { registeredGroups, getAvailableGroups, port = 3100 } = options;

  app.use(express.json());

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', assistant: ASSISTANT_NAME });
  });

  // Chat endpoint for voice pipeline (Jarvis)
  app.post('/api/chat', async (req: Request, res: Response) => {
    const { text, stream = false } = req.body;
    const session = req.body.session || 'jarvis'; // Handle null/undefined

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }

    // Find or create the session group
    const groups = registeredGroups();
    let chatJid: string | undefined;
    let group: RegisteredGroup | undefined;

    // Look for existing group with matching folder
    for (const [jid, grp] of Object.entries(groups)) {
      if (grp.folder === session) {
        chatJid = jid;
        group = grp;
        break;
      }
    }

    // If not found, create a virtual group for this session
    if (!group) {
      const virtual = createVirtualGroup(session);
      chatJid = virtual.jid;
      group = virtual.group;
    }

    // At this point both are guaranteed to be set
    if (!chatJid || !group) {
      res.status(500).json({ error: 'Failed to create session' });
      return;
    }

    const isMain = session === MAIN_GROUP_FOLDER;
    const sessionId = sessions[session] || getSession(session);

    logger.info({ session, textLength: text.length, stream }, 'API chat request');

    try {
      // Write task snapshots for container
      const tasks = getAllTasks();
      writeTasksSnapshot(
        session,
        isMain,
        tasks.map((t) => ({
          id: t.id,
          groupFolder: t.group_folder,
          prompt: t.prompt,
          schedule_type: t.schedule_type,
          schedule_value: t.schedule_value,
          status: t.status,
          next_run: t.next_run,
        })),
      );

      // Write groups snapshot
      const availableGroups = getAvailableGroups();
      writeGroupsSnapshot(
        session,
        isMain,
        availableGroups,
        new Set(Object.keys(groups)),
      );

      // Run container agent - simplified without streaming deltas
      const output = await runContainerAgent(
        group,
        {
          prompt: text,
          sessionId,
          groupFolder: session,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
        },
        (_proc, _containerName) => {
          // Process tracking callback - can be used for logging
        },
        async (message: ContainerOutput) => {
          // Output callback - called for each complete output
          if (message.newSessionId) {
            sessions[session] = message.newSessionId;
            setSession(session, message.newSessionId);
          }
        },
      );

      // Extract response from output
      const raw = typeof output.result === 'string'
        ? output.result
        : JSON.stringify(output.result);
      const responseText = raw
        .replace(/<internal>[\s\S]*?<\/internal>/g, '')
        .trim();

      // Update session if changed
      if (output.newSessionId) {
        sessions[session] = output.newSessionId;
        setSession(session, output.newSessionId);
      }

      // Handle error status
      if (output.status === 'error') {
        res.status(500).json({
          error: output.error || 'Agent processing failed',
        });
        return;
      }

      // Return successful response
      res.json({
        response: responseText,
        session: output.newSessionId || sessionId,
      });
    } catch (err) {
      logger.error({ session, err }, 'API chat error');
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // Start listening
  app.listen(port, () => {
    logger.info({ port }, 'HTTP API server started');
  });

  return app;
}
