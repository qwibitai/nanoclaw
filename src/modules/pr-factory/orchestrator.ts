/**
 * Test plan forwarding and result polling.
 *
 * Container agents write test plans to their session outbox. This module
 * watches agent group folders for test plan files, SCPs them to the
 * orchestrator VM, and polls the orchestrator's outbox for results.
 * Results are written directly to the session's outbound DB so the
 * delivery loop posts them to Discord.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { writeOutboundDirect } from '../../session-manager.js';
import { log } from '../../log.js';

const ORCHESTRATOR_HOST = 'pr-factory-orchestrator.exe.xyz';
const PLAN_POLL_MS = 5_000;
const RESULT_POLL_MS = 30_000;

function ssh(args: string[], opts?: { maxBuffer?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'ConnectTimeout=5', ORCHESTRATOR_HOST, ...args], opts, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout).trim());
    });
  });
}

function scp(localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('scp', ['-o', 'ConnectTimeout=5', localPath, `${ORCHESTRATOR_HOST}:${remotePath}`], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Scan all PR agent group folders for test plan files and forward them
 * to the orchestrator. Test plans are written by the pr-test-plan
 * container skill to the agent's group folder.
 */
async function forwardTestPlans(): Promise<void> {
  let entries: string[];
  try {
    entries = fs.readdirSync(GROUPS_DIR).filter((f) => f.startsWith('pr-'));
  } catch {
    return;
  }

  for (const folder of entries) {
    const groupDir = path.resolve(GROUPS_DIR, folder);
    let files: string[];
    try {
      files = fs.readdirSync(groupDir).filter((f) => f.startsWith('PR-') && f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(groupDir, file);
      const tmpName = `.uploading-${file}`;
      try {
        await scp(filePath, `~/inbox/${tmpName}`);
        await ssh([`mv ~/inbox/${tmpName} ~/inbox/${file}`]);
        fs.unlinkSync(filePath);
        log.info('Test plan forwarded to orchestrator', { file, folder });
      } catch (err) {
        log.warn('Failed to forward test plan', { file, folder, err });
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    }
  }
}

const processedResults = new Set<string>();

/**
 * Poll the orchestrator's outbox for test results and post them to
 * the corresponding PR's Discord thread via the delivery system.
 */
async function pollTestResults(): Promise<void> {
  let listing: string;
  try {
    listing = await ssh(['ls ~/outbox/']);
  } catch {
    return;
  }
  if (!listing) return;

  const resultFiles = listing.split('\n').filter((f) => f.startsWith('results-') && f.endsWith('.md'));

  for (const file of resultFiles) {
    if (processedResults.has(file)) continue;

    const prMatch = file.match(/results-pr(\d+)/);
    if (!prMatch) continue;
    const prNumber = prMatch[1];

    // Find the PR's agent group by folder convention
    const prFolder = `pr-qwibitai-nanoclaw-${prNumber}`;
    const agentGroup = getAgentGroupByFolder(prFolder);
    if (!agentGroup) {
      log.warn('Test result for unknown PR group', { file, prFolder });
      processedResults.add(file);
      continue;
    }

    // Find the messaging group and session for this agent
    const messagingGroups = getMessagingGroupsByAgentGroup(agentGroup.id);
    if (messagingGroups.length === 0) {
      log.warn('No messaging group for PR agent', { file, agentGroupId: agentGroup.id });
      processedResults.add(file);
      continue;
    }
    const mg = messagingGroups[0];
    const session = findSessionForAgent(agentGroup.id, mg.id, null);
    if (!session) {
      log.warn('No session for PR agent', { file, agentGroupId: agentGroup.id });
      processedResults.add(file);
      continue;
    }

    try {
      const content = await ssh([`cat ~/outbox/${file}`], { maxBuffer: 1024 * 1024 });
      const truncated = content.length > 6000 ? content.slice(0, 6000) + '\n\n... (truncated)' : content;

      // Write directly to outbound DB — delivery loop picks it up
      const msgId = `test-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeOutboundDirect(agentGroup.id, session.id, {
        id: msgId,
        kind: 'chat',
        platformId: mg.platform_id,
        channelType: 'discord',
        threadId: null,
        content: JSON.stringify({ text: truncated }),
      });

      processedResults.add(file);

      try {
        const archiveName = `PR-${prNumber}-Test-Results.md`;
        await ssh([
          `mv ~/outbox/${file} "$HOME/NanoClaw-vault/02-R&D/dev tasks/test-factory/(Prod) PR Factory Testing Output/${archiveName}"`,
        ]);
      } catch (mvErr) {
        log.warn('Failed to archive result to nanoclaw-vault', { file, mvErr });
      }

      log.info('Test results posted to PR thread', { file, prNumber, sessionId: session.id });
    } catch (err) {
      log.warn('Failed to fetch test result', { file, err });
    }
  }
}

let planTimer: ReturnType<typeof setTimeout> | null = null;
let resultTimer: ReturnType<typeof setTimeout> | null = null;

function planLoop(): void {
  forwardTestPlans()
    .catch((err) => log.error('Test plan forwarding error', { err }))
    .finally(() => {
      planTimer = setTimeout(planLoop, PLAN_POLL_MS);
    });
}

function resultLoop(): void {
  pollTestResults()
    .catch((err) => log.error('Test result polling error', { err }))
    .finally(() => {
      resultTimer = setTimeout(resultLoop, RESULT_POLL_MS);
    });
}

export function startOrchestratorPolling(): void {
  planTimer = setTimeout(planLoop, PLAN_POLL_MS);
  resultTimer = setTimeout(resultLoop, 10_000);
  log.info('Orchestrator polling started');
}

export function stopOrchestratorPolling(): void {
  if (planTimer) clearTimeout(planTimer);
  if (resultTimer) clearTimeout(resultTimer);
  planTimer = null;
  resultTimer = null;
}
