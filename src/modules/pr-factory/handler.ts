import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, ONECLI_URL } from '../../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { PREvent } from './webhook.js';
import { SUPERVISOR_FOLDER } from './supervisor.js';
import { getBotId } from './discord-bots.js';

const MAX_DIFF_LENGTH = 50_000;

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFolder(repoFullName: string, prNumber: number): string {
  const repoSlug = repoFullName.replace(/[^A-Za-z0-9_-]/g, '-');
  return `pr-${repoSlug}-${prNumber}`.slice(0, 64);
}

async function fetchDiff(repoFullName: string, prNumber: number): Promise<string> {
  const gatewayUrl = ONECLI_URL.replace(/:\d+$/, ':10255');
  const url = `${gatewayUrl}/repos/${repoFullName}/pulls/${prNumber}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3.diff',
      Host: 'api.github.com',
      'User-Agent': 'NanoClaw',
    },
  });
  if (!res.ok) {
    log.warn('Failed to fetch PR diff', { status: res.status, repo: repoFullName, pr: prNumber });
    return `(Failed to fetch diff: HTTP ${res.status})`;
  }
  let diff = await res.text();
  if (diff.length > MAX_DIFF_LENGTH) {
    diff =
      diff.slice(0, MAX_DIFF_LENGTH) +
      `\n\n... (diff truncated at ${MAX_DIFF_LENGTH} chars — ask to review specific files for the rest)`;
  }
  return diff;
}

async function createDiscordThread(
  botToken: string,
  parentChannelId: string,
  name: string,
): Promise<{ threadId: string; guildId: string }> {
  const res = await fetch(`https://discord.com/api/v10/channels/${parentChannelId}/threads`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: name.slice(0, 100),
      auto_archive_duration: 10080, // 7 days
      type: 11, // PUBLIC_THREAD
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord thread creation failed: ${res.status} ${body}`);
  }
  const thread = (await res.json()) as { id: string; guild_id: string };
  return { threadId: thread.id, guildId: thread.guild_id };
}

export async function handlePullRequest(pr: PREvent, botToken: string, channelId: string): Promise<void> {
  const folder = sanitizeFolder(pr.repoFullName, pr.number);

  // Dedup: skip if agent group already exists for this PR
  const existing = getAgentGroupByFolder(folder);
  if (existing) {
    log.info('PR agent group already exists, skipping', { folder, pr: pr.number });
    return;
  }

  // Fetch diff + create Discord thread in parallel
  const [diff, thread] = await Promise.all([
    fetchDiff(pr.repoFullName, pr.number),
    createDiscordThread(botToken, channelId, `PR #${pr.number}: ${pr.title}`),
  ]);

  const now = new Date().toISOString();
  const platformId = `discord:${thread.guildId}:${thread.threadId}`;

  // 1. Create agent group
  const agentGroupId = generateId('ag-pr');
  const agentGroup = {
    id: agentGroupId,
    name: `PR #${pr.number}: ${pr.title}`,
    folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(agentGroup);
  initGroupFilesystem(agentGroup);

  log.info('Created PR agent group', { agentGroupId, folder, pr: pr.number });

  // 2. Create messaging group for the Discord thread
  const mgId = generateId('mg-pr');
  const mg = {
    id: mgId,
    channel_type: 'discord',
    platform_id: platformId,
    bot_id: getBotId('worker') ?? null,
    name: `PR #${pr.number}: ${pr.title}`,
    is_group: 1,
    unknown_sender_policy: 'public' as const,
    created_at: now,
  };
  createMessagingGroup(mg);

  // 3. Wire worker agent to messaging group (mention-only; initial trigger
  //    bypasses engage_mode via direct session write below)
  const mgaId = generateId('mga-pr');
  createMessagingGroupAgent({
    id: mgaId,
    messaging_group_id: mgId,
    agent_group_id: agentGroupId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });

  // 3b. Wire supervisor to this thread so @Supervisor mentions route correctly.
  //     Accumulate mode gives supervisor full thread context on wake.
  const supervisorGroup = getAgentGroupByFolder(SUPERVISOR_FOLDER);
  if (supervisorGroup) {
    const svMgId = generateId('mg-pr-sv');
    createMessagingGroup({
      id: svMgId,
      channel_type: 'discord',
      platform_id: platformId,
      bot_id: getBotId('supervisor') ?? null,
      name: `PR #${pr.number} (supervisor)`,
      is_group: 1,
      unknown_sender_policy: 'public' as const,
      created_at: now,
    });
    createMessagingGroupAgent({
      id: generateId('mga-pr-sv'),
      messaging_group_id: svMgId,
      agent_group_id: supervisorGroup.id,
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  }

  // 4. Create session + write initial message
  const { session } = resolveSession(agentGroupId, mgId, null, 'shared');

  const content = [
    'Use the /pr-triage skill to triage this pull request.',
    '',
    `## Pull Request #${pr.number}: ${pr.title}`,
    `**Author:** ${pr.author}`,
    `**Repository:** ${pr.repoFullName}`,
    `**URL:** ${pr.htmlUrl}`,
    '',
    '### Description',
    pr.body || '(no description)',
    '',
    '### Diff',
    '```diff',
    diff,
    '```',
  ].join('\n');

  // Save original prompt for retriggering
  const groupDir = path.resolve(GROUPS_DIR, folder);
  fs.writeFileSync(path.join(groupDir, 'original-prompt.txt'), content);

  writeSessionMessage(agentGroupId, session.id, {
    id: generateId('msg-pr'),
    kind: 'chat',
    timestamp: now,
    platformId,
    channelType: 'discord',
    threadId: null,
    content: JSON.stringify({ text: content, sender: 'GitHub', senderId: 'github-webhook' }),
  });

  log.info('PR message written to session', { sessionId: session.id, pr: pr.number });

  // 5. Wake container
  const freshSession = getSession(session.id);
  if (freshSession) {
    await wakeContainer(freshSession);
  }
}
