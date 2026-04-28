/**
 * Session operations for PR factory workers.
 *
 * Provides clear-session and retrigger primitives that the supervisor
 * (or any authorized caller) can invoke to reset a PR worker's context
 * and re-run triage from the saved original prompt.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { findSessionForAgent, deleteSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { killContainer } from '../../container-runner.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Clear a PR worker's session so the next run starts fresh.
 * Kills the running container (if any) and deletes the session record.
 */
export function clearWorkerSession(folder: string): boolean {
  const agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    log.warn('clearWorkerSession: agent group not found', { folder });
    return false;
  }

  const sessions = getSessionsByAgentGroup(agentGroup.id);
  for (const session of sessions) {
    killContainer(session.id, 'supervisor clear_session');
    deleteSession(session.id);
  }

  log.info('Worker session cleared', { folder, sessionsCleared: sessions.length });
  return true;
}

/**
 * Re-trigger triage on a PR worker by re-queuing the saved original prompt.
 * If no original prompt exists, falls back to the provided prompt text.
 */
export async function retriggerWorker(folder: string, fallbackPrompt?: string): Promise<boolean> {
  const agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    log.warn('retriggerWorker: agent group not found', { folder });
    return false;
  }

  // Read saved original prompt (written by handlePullRequest)
  const savedPromptPath = path.join(GROUPS_DIR, folder, 'original-prompt.txt');
  let prompt = fallbackPrompt || '';
  if (fs.existsSync(savedPromptPath)) {
    prompt = fs.readFileSync(savedPromptPath, 'utf-8');
    log.info('Using saved original prompt for retrigger', { folder });
  }
  if (!prompt) {
    log.warn('retriggerWorker: no prompt available', { folder });
    return false;
  }

  // Find (or create) the messaging group and session
  const messagingGroups = getMessagingGroupsByAgentGroup(agentGroup.id);
  if (messagingGroups.length === 0) {
    log.warn('retriggerWorker: no messaging group', { folder });
    return false;
  }
  const mg = messagingGroups[0];

  const { session } = resolveSession(agentGroup.id, mg.id, null, 'shared');
  const now = new Date().toISOString();

  writeSessionMessage(agentGroup.id, session.id, {
    id: generateId('msg-retrigger'),
    kind: 'chat',
    timestamp: now,
    platformId: mg.platform_id,
    channelType: 'discord',
    threadId: null,
    content: JSON.stringify({ text: prompt, sender: 'Supervisor', senderId: 'supervisor' }),
  });

  // Wake the container
  const freshSession = getSession(session.id);
  if (freshSession) {
    await wakeContainer(freshSession);
  }

  log.info('Worker retriggered', { folder, sessionId: session.id });
  return true;
}
