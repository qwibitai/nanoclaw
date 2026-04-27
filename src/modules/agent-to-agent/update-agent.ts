/**
 * `update_agent` delivery-action handler.
 *
 * Lets a parent agent re-configure a previously-created sub-agent's
 * `agent_provider` and/or `model` by destination name. Applied directly
 * to the `agent_groups` row; any currently-running container for the
 * target is stopped so the next wake picks up the new config.
 *
 * Authorization is implicit: the parent must have an agent-type
 * destination to the target (i.e. it must be one the parent created
 * or was explicitly granted access to). Without such a destination the
 * target name won't resolve and the update is rejected.
 */
import { getAgentGroup, updateAgentGroup } from '../../db/agent-groups.js';
import { getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { killContainer, wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getDestinationByName, normalizeName } from './db/agent-destinations.js';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export async function handleUpdateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = content.requestId as string;
  void requestId; // fire-and-forget

  const targetName = normalizeName((content.target as string) || '');
  if (!targetName) {
    notifyAgent(session, 'update_agent failed: target is required.');
    return;
  }

  // Only process keys the tool explicitly sent. This way callers can update
  // one field without clobbering the other. `null` = intentional clear,
  // absent key = leave unchanged.
  const hasProvider = Object.prototype.hasOwnProperty.call(content, 'agent_provider');
  const hasModel = Object.prototype.hasOwnProperty.call(content, 'model');
  if (!hasProvider && !hasModel) {
    notifyAgent(session, `update_agent failed: nothing to update for "${targetName}".`);
    return;
  }

  // Resolve target via the parent's destination namespace — this is the
  // implicit authorization: you can only update agents you can message.
  const dest = getDestinationByName(session.agent_group_id, targetName);
  if (!dest || dest.target_type !== 'agent') {
    notifyAgent(
      session,
      `update_agent failed: no sub-agent named "${targetName}" in your destinations. Only agents you created (or were granted access to) can be updated.`,
    );
    log.warn('update_agent: unknown target', { parent: session.agent_group_id, target: targetName });
    return;
  }

  const targetGroup = getAgentGroup(dest.target_id);
  if (!targetGroup) {
    notifyAgent(session, `update_agent failed: target agent group "${targetName}" does not exist.`);
    log.error('update_agent: destination points to missing agent group', {
      parent: session.agent_group_id,
      target: targetName,
      targetId: dest.target_id,
    });
    return;
  }

  const updates: { agent_provider?: string | null; model?: string | null } = {};
  const notifyParts: string[] = [];

  if (hasProvider) {
    const rawProvider = content.agent_provider as string | null | undefined;
    const agentProvider =
      typeof rawProvider === 'string' && rawProvider.trim() ? rawProvider.trim().toLowerCase() : null;
    updates.agent_provider = agentProvider;
    notifyParts.push(`provider=${agentProvider ?? '<cleared>'}`);
  }
  if (hasModel) {
    const rawModel = content.model as string | null | undefined;
    const model = typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : null;
    updates.model = model;
    notifyParts.push(`model=${model ?? '<cleared>'}`);
  }

  updateAgentGroup(targetGroup.id, updates);

  // Stop any currently-running container for the target so the next
  // message wakes it fresh with the new config. No-op if none running.
  // We don't spawn a replacement — it'll come up naturally on next traffic.
  const sessions = getSessionsByAgentGroup(targetGroup.id);
  let killed = 0;
  for (const sess of sessions) {
    if (sess.container_status === 'running' || sess.container_status === 'idle') {
      killContainer(sess.id, `update_agent by ${session.agent_group_id}`);
      killed++;
    }
  }

  notifyAgent(
    session,
    `Agent "${targetName}" updated (${notifyParts.join(', ')})${killed ? `. ${killed} running container(s) stopped — next message will respawn with the new config` : '. No running containers; next spawn will use the new config'}.`,
  );
  log.info('Agent group updated', {
    agentGroupId: targetGroup.id,
    targetName,
    parent: session.agent_group_id,
    ...updates,
    containersKilled: killed,
  });
}
