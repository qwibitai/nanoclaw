/**
 * `create_agent` delivery-action handler.
 *
 * Spawns a new agent group on demand from the parent agent, wires bidirectional
 * agent_destinations rows, projects the new destination into the parent's
 * running container, and notifies the parent.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

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

export async function handleCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = content.requestId as string;
  const name = content.name as string;
  const instructions = content.instructions as string | null;
  const rawProvider = content.agent_provider as string | null | undefined;
  const agentProvider = typeof rawProvider === 'string' && rawProvider.trim() ? rawProvider.trim().toLowerCase() : null;
  const rawModel = content.model as string | null | undefined;
  // Case preserved — SDKs use `[1m]` / version suffixes that must round-trip.
  const model = typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : null;

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, `create_agent failed: source agent group not found.`);
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Derive a safe folder name, deduplicated globally across agent_groups.folder
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    notifyAgent(session, `Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: agentProvider,
    model,
    created_at: now,
  };
  createAgentGroup(newGroup);
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });

  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  writeDestinations(session.agent_group_id, session.id);

  // Fire-and-forget notification back to the creator
  const notifyParts: string[] = [];
  if (agentProvider) notifyParts.push(`provider=${agentProvider}`);
  if (model) notifyParts.push(`model=${model}`);
  const configSuffix = notifyParts.length ? ` (${notifyParts.join(', ')})` : '';
  notifyAgent(
    session,
    `Agent "${localName}" created${configSuffix}. You can now message it with <message to="${localName}">...</message>.`,
  );
  log.info('Agent group created', {
    agentGroupId,
    name,
    localName,
    folder,
    parent: sourceGroup.id,
    agent_provider: agentProvider,
    model,
  });
  // Note: requestId is unused — this is fire-and-forget, not request/response.
  void requestId;
}
