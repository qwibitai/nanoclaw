/**
 * HTTP API for NanoClaw
 * Provides REST endpoints for external integrations (e.g., Jarvis voice pipeline)
 */
import express, { Request, Response } from 'express';
import { EventEmitter } from 'events';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER } from './config.js';
import {
  ContainerOutput,
  ContainerMessage,
  ContainerDelta,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  AvailableGroup,
  WarmContainer,
  getWarmContainer,
  prewarmContainer,
} from './container-runner.js';
import { getAllTasks, getSession, setSession } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

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

    // Try to get a warm container for faster response
    const warmContainer = getWarmContainer(session);

    logger.info({ session, textLength: text.length, stream, warmContainer: !!warmContainer }, 'API chat request');


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

      if (stream) {
        // Streaming mode - use Server-Sent Events
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const eventEmitter = new EventEmitter();
        let fullResponse = '';
        let containerProcess: import('child_process').ChildProcess | undefined;

        // Run container in background - we'll wait for complete event instead
        const containerPromise = runContainerAgent(
          group,
          {
            prompt: text,
            sessionId,
            groupFolder: session,
            chatJid,
            isMain,
            assistantName: ASSISTANT_NAME,
          },
          (proc) => {
            containerProcess = proc;
          }, // Track process for early termination
          async (message: ContainerMessage) => {
            // Debug: log all messages
            logger.debug({ message: JSON.stringify(message).slice(0, 200), fullResponse }, 'API received message');

            // Handle streaming deltas
            if ('type' in message && message.type === 'delta') {
              const delta = message as ContainerDelta;
              const responseText = delta.text
                .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                .trim();

              if (responseText) {
                fullResponse += responseText;
                // Send SSE event with delta
                res.write(`data: ${JSON.stringify({ type: 'delta', text: responseText })}\n\n`);
              }
              if (delta.newSessionId) {
                sessions[session] = delta.newSessionId;
                setSession(session, delta.newSessionId);
              }
              return;
            }

            // Handle complete outputs
            const output = message as ContainerOutput;
            if (output.result) {
              const raw =
                typeof output.result === 'string'
                  ? output.result
                  : JSON.stringify(output.result);
              // Strip <internal> blocks
              const responseText = raw
                .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                .trim();

              if (responseText) {
                fullResponse += responseText;
              }
            }

            if (output.newSessionId) {
              sessions[session] = output.newSessionId;
              setSession(session, output.newSessionId);
            }

            // Emit complete when we get a success/error status with response content
            // This handles the case where container stays alive waiting for IPC
            if (output.status === 'success' && fullResponse) {
              eventEmitter.emit('complete');
            }
            if (output.status === 'error') {
              eventEmitter.emit('complete');
            }
          },
          warmContainer ?? undefined, // Pass warm container if available
        );

        // Wait for completion event OR timeout (don't wait for container to exit)
        await new Promise<void>((resolve) => {
          eventEmitter.once('complete', () => {
            // Kill container after emitting done
            setTimeout(() => {
              if (containerProcess) {
                containerProcess.kill();
              }
            }, 100);
            resolve();
          });
          // Timeout after 60 seconds
          setTimeout(() => {
            if (containerProcess) {
              containerProcess.kill();
            }
            resolve();
          }, 60000);
        });

        res.write(`data: ${JSON.stringify({ type: 'done', fullResponse })}\n\n`);
        res.end();

        // Clean up container promise in background
        containerPromise.catch(() => {}); // Ignore errors from killed container
      } else {
        // Non-streaming mode - collect full response using event-based completion
        const eventEmitter = new EventEmitter();
        let fullResponse = '';
        let newSessionId: string | undefined;
        let hadError = false;
        let containerProcess: import('child_process').ChildProcess | undefined;

        // Run container in background - we'll wait for complete event instead
        const containerPromise = runContainerAgent(
          group,
          {
            prompt: text,
            sessionId,
            groupFolder: session,
            chatJid,
            isMain,
            assistantName: ASSISTANT_NAME,
          },
          (proc) => {
            containerProcess = proc;
          }, // Track process for early termination
          async (message: ContainerMessage) => {
            // Handle streaming deltas
            if ('type' in message && message.type === 'delta') {
              const delta = message as ContainerDelta;
              const responseText = delta.text
                .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                .trim();

              if (responseText) {
                fullResponse += responseText;
              }
              if (delta.newSessionId) {
                newSessionId = delta.newSessionId;
              }
              return;
            }

            // Handle complete outputs
            const output = message as ContainerOutput;
            if (output.result) {
              const raw =
                typeof output.result === 'string'
                  ? output.result
                  : JSON.stringify(output.result);
              // Strip <internal> blocks
              const responseText = raw
                .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                .trim();

              if (responseText) {
                fullResponse += responseText;
              }
            }

            if (output.newSessionId) {
              newSessionId = output.newSessionId;
            }

            // Emit complete when we get a success/error status with response content
            if (output.status === 'success' && fullResponse) {
              eventEmitter.emit('complete');
            }
            if (output.status === 'error') {
              hadError = true;
              eventEmitter.emit('complete');
            }
          },
          warmContainer ?? undefined, // Pass warm container if available
        );

        // Wait for completion event OR timeout (don't wait for container to exit)
        await new Promise<void>((resolve) => {
          eventEmitter.once('complete', () => {
            // Kill container after emitting done
            setTimeout(() => {
              if (containerProcess) {
                containerProcess.kill();
              }
            }, 100);
            resolve();
          });
          // Timeout after 30 seconds for non-streaming
          setTimeout(() => {
            if (containerProcess) {
              containerProcess.kill();
            }
            resolve();
          }, 30000);
        });

        // Clean up container promise in background
        containerPromise.catch(() => {}); // Ignore errors from killed container

        if (hadError && !fullResponse) {
          res.status(500).json({ error: 'Agent processing failed' });
          return;
        }

        // Update session
        if (newSessionId) {
          sessions[session] = newSessionId;
          setSession(session, newSessionId);
        }

        res.json({
          response: fullResponse,
          session: newSessionId || sessionId,
        });
      }
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
