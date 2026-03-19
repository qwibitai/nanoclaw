/**
 * Case IPC handlers — processes case lifecycle events from container agents.
 *
 * Architecture:
 *   Container (MCP tools) → IPC files → Host (ipc.ts dispatcher) → this module
 *   This module handles all `case_*` IPC types and delegates to:
 *     - cases.ts for SQLite operations (primary store)
 *     - case-backend.ts for cloud sync (GitHub Issues V1, swappable)
 *     - case-auth.ts for authorization decisions
 *     - github-api.ts for dev case issue creation (kaizen repo)
 *
 * Separation of concerns:
 *   - ipc.ts: dispatch routing, file watching, non-case IPC
 *   - ipc-cases.ts (this file): case lifecycle business logic
 *   - case-backend.ts + case-backend-github.ts: cloud backend adapter
 *   - cases.ts: data model and SQLite operations
 */

import fs from 'fs';
import path from 'path';

import { authorizeCaseCreation } from './case-auth.js';
import { getCaseSyncService } from './case-backend.js';
import { DATA_DIR } from './config.js';
import { sanitizeRequestId } from './ipc-sanitize.js';
import {
  computePriority,
  loadEscalationConfig,
  resolveNotificationTargets,
} from './escalation.js';
import type {
  EscalationConfig,
  PriorityLevel,
  SignalContext,
} from './escalation.js';
import { dispatchEscalationNotifications } from './notification-dispatch.js';
import type { EscalationNotification } from './notification-dispatch.js';
import {
  createCaseWorkspace,
  generateCaseId,
  generateCaseName,
  getActiveCasesByGithubIssue,
  getCaseById,
  insertCase,
  pruneCaseWorkspace,
  removeWorktreeLock,
  resolveExistingWorktree,
  suggestDevCase,
  updateCase,
  updateWorktreeLockHeartbeat,
} from './cases.js';
import type { Case } from './cases.js';
import { createGitHubIssue, DEV_CASE_ISSUE_REPO } from './github-api.js';
import { logger } from './logger.js';
import type { IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

/**
 * Find and load escalation config from a group's vertical mounts.
 * Scans additionalMounts for config/escalation.yaml files.
 */
function loadEscalationConfigForGroup(
  group: RegisteredGroup | undefined,
): EscalationConfig | null {
  if (!group?.containerConfig?.additionalMounts) return null;

  for (const mount of group.containerConfig.additionalMounts) {
    const hostPath = mount.hostPath.startsWith('~')
      ? path.join(process.env.HOME || '', mount.hostPath.slice(1))
      : mount.hostPath;
    const configPath = path.join(hostPath, 'config', 'escalation.yaml');
    const config = loadEscalationConfig(configPath);
    if (config) {
      logger.info(
        { configPath, group: group.name },
        'Loaded escalation config from vertical mount',
      );
      return config;
    }
  }

  return null;
}

/**
 * Auto-detect escalation signals from case creation context.
 */
function detectSignals(
  config: EscalationConfig,
  initiator: string,
  isMain: boolean,
  explicitSignals?: Record<string, boolean>,
): SignalContext {
  const signals: SignalContext = { ...explicitSignals };

  if (config.signals.admin_initiated && !('admin_initiated' in signals)) {
    const isAdmin = config.admins.some(
      (a) =>
        a.name.toLowerCase() === initiator.toLowerCase() ||
        a.email?.toLowerCase() === initiator.toLowerCase() ||
        a.telegram === initiator,
    );
    signals.admin_initiated = isAdmin;
  }

  if (config.signals.main_channel && !('main_channel' in signals)) {
    signals.main_channel = isMain;
  }

  if (config.signals.customer_waiting && !('customer_waiting' in signals)) {
    signals.customer_waiting = false;
  }

  return signals;
}

/**
 * Handle a case-related IPC task. Returns true if handled, false if not a case type.
 */
export async function processCaseIpc(
  data: { type: string; caseId?: string; [key: string]: unknown },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<boolean> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'case_mark_done':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.worktree_path) {
            removeWorktreeLock(caseItem.worktree_path);
          }
          updateCase(data.caseId, {
            status: 'done',
            done_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            conclusion: (data.conclusion as string) || null,
            last_message: (data.conclusion as string) || caseItem.last_message,
          });
          logger.info(
            { caseId: data.caseId, sourceGroup },
            'Case marked done via IPC',
          );
        }
      }
      return true;

    case 'case_mark_blocked':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          updateCase(data.caseId, {
            status: 'blocked',
            blocked_on: (data.blocked_on as string) || 'user',
            last_activity_at: new Date().toISOString(),
          });
          logger.info(
            { caseId: data.caseId, sourceGroup },
            'Case marked blocked via IPC',
          );
        }
      }
      return true;

    case 'case_mark_active':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          updateCase(data.caseId, {
            status: 'active',
            blocked_on: null,
            last_activity_at: new Date().toISOString(),
          });
          logger.info(
            { caseId: data.caseId, sourceGroup },
            'Case marked active via IPC',
          );
        }
      }
      return true;

    case 'case_mark_reviewed':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.status !== 'done') {
            logger.warn(
              { caseId: data.caseId, status: caseItem.status },
              'Cannot review case — not in done status',
            );
          } else {
            updateCase(data.caseId, {
              status: 'reviewed',
              reviewed_at: new Date().toISOString(),
              last_activity_at: new Date().toISOString(),
            });
            logger.info(
              { caseId: data.caseId, sourceGroup },
              'Case marked reviewed via IPC',
            );
          }
        }
      }
      return true;

    case 'case_prune':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          try {
            pruneCaseWorkspace(caseItem);
            updateCase(data.caseId, {
              status: 'pruned',
              pruned_at: new Date().toISOString(),
              last_activity_at: new Date().toISOString(),
            });
            logger.info(
              { caseId: data.caseId, sourceGroup },
              'Case pruned via IPC — workspace removed',
            );
          } catch (pruneErr) {
            logger.warn(
              { caseId: data.caseId, err: pruneErr },
              'Case prune refused — status guard or lock prevented deletion',
            );
          }
        }
      }
      return true;

    case 'case_add_comment':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          const text = (data.text as string) || '';
          const author = (data.author as string) || 'agent';

          updateCase(data.caseId, {
            last_activity_at: new Date().toISOString(),
            last_message: text.slice(0, 200),
          });

          const syncService = getCaseSyncService();
          if (syncService) {
            syncService
              .onCaseMutated({
                type: 'comment',
                case: caseItem,
                comment: { text, author },
              })
              .catch(() => {});
          }

          logger.info(
            { caseId: data.caseId, author, sourceGroup },
            'Case comment added via IPC',
          );
        }
      }
      return true;

    case 'case_update_activity':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          const updates: Record<string, unknown> = {
            last_activity_at: new Date().toISOString(),
          };
          if (data.last_message) {
            updates.last_message = data.last_message;
          }
          updateCase(data.caseId, updates as Parameters<typeof updateCase>[1]);
        }
      }
      return true;

    case 'case_create':
      try {
        await handleCaseCreate(
          data,
          sourceGroup,
          isMain,
          deps,
          registeredGroups,
        );
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Unhandled error in case_create — writing error result',
        );
        writeCaseErrorResult(data, sourceGroup, {
          error: 'internal',
          message:
            err instanceof Error
              ? err.message
              : 'Unknown error during case creation',
        });
      }
      return true;

    case 'case_suggest_dev':
      handleCaseSuggestDev(data, sourceGroup, deps, registeredGroups);
      return true;

    case 'case_heartbeat':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.worktree_path) {
            updateWorktreeLockHeartbeat(caseItem.worktree_path);
          }
          updateCase(data.caseId, {
            last_activity_at: new Date().toISOString(),
          });
          logger.debug(
            { caseId: data.caseId, sourceGroup },
            'Case heartbeat updated',
          );
        }
      }
      return true;

    case 'case_unlock':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.worktree_path) {
            removeWorktreeLock(caseItem.worktree_path);
            logger.info(
              { caseId: data.caseId, sourceGroup },
              'Case worktree unlocked via IPC',
            );
          }
        }
      }
      return true;

    default:
      return false;
  }
}

/**
 * Write an error result file to case_results/ so the polling caller gets feedback.
 * Exported for testing.
 */
export function writeCaseErrorResult(
  data: Record<string, unknown>,
  sourceGroup: string,
  errorPayload: { error: string; message: string },
): void {
  const resultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'case_results');
  fs.mkdirSync(resultDir, { recursive: true });
  const rawReqId = data.requestId as string | undefined;
  const safeReqId = rawReqId ? sanitizeRequestId(rawReqId) : '';
  const resultFile = safeReqId
    ? `${safeReqId}.json`
    : `error-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(resultDir, resultFile),
    JSON.stringify(errorPayload),
  );
}

async function handleCaseCreate(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  const d = data as unknown as {
    description: string;
    context?: string;
    shortName?: string;
    caseType?: string;
    chatJid?: string;
    initiator?: string;
    githubIssue?: number;
    gapType?: string;
    signals?: Record<string, boolean>;
    allowDuplicate?: boolean;
    branchName?: string;
    worktreePath?: string;
  };
  if (!d.description) {
    logger.warn({ sourceGroup }, 'case_create missing description');
    writeCaseErrorResult(data, sourceGroup, {
      error: 'validation',
      message: 'case_create missing required field: description',
    });
    return;
  }

  if (d.githubIssue) {
    const existing = getActiveCasesByGithubIssue(d.githubIssue);
    if (existing.length > 0) {
      const names = existing.map((c) => c.name).join(', ');
      if (!d.allowDuplicate) {
        logger.warn(
          { githubIssue: d.githubIssue, existingCases: names, sourceGroup },
          `Blocked: Kaizen #${d.githubIssue} already has active case(s): ${names}`,
        );
        const warnJid =
          d.chatJid ||
          Object.entries(registeredGroups).find(
            ([, g]) => g.folder === sourceGroup,
          )?.[0];
        if (warnJid) {
          deps
            .sendMessage(
              warnJid,
              `🚫 Kaizen #${d.githubIssue} already has active case(s): ${names}. Case creation blocked to prevent parallel work. Pass allowDuplicate: true to override.`,
            )
            .catch(() => {});
        }
        // Write error result file so the requesting agent gets feedback
        const resultDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'case_results',
        );
        fs.mkdirSync(resultDir, { recursive: true });
        const rawReqId = (data as Record<string, unknown>).requestId as
          | string
          | undefined;
        const safeReqId = rawReqId ? sanitizeRequestId(rawReqId) : '';
        const resultFile = safeReqId
          ? `${safeReqId}.json`
          : `collision-${d.githubIssue}-${Date.now()}.json`;
        fs.writeFileSync(
          path.join(resultDir, resultFile),
          JSON.stringify({
            error: 'collision',
            message: `Kaizen #${d.githubIssue} already has active case(s): ${names}`,
            existingCases: existing.map((c) => ({
              name: c.name,
              status: c.status,
            })),
          }),
        );
        return;
      }
      logger.warn(
        { githubIssue: d.githubIssue, existingCases: names, sourceGroup },
        `Kaizen #${d.githubIssue} already has active case(s): ${names} — override via allowDuplicate`,
      );
    }
  }

  // Check for dev mode marker (written by message loop when safe word detected)
  const devModeMarkerPath = path.join(
    DATA_DIR,
    'ipc',
    sourceGroup,
    '.dev-mode',
  );
  const devModeRequested = fs.existsSync(devModeMarkerPath);

  const requestedType = d.caseType === 'dev' ? 'dev' : 'work';
  const authDecision = authorizeCaseCreation({
    requestedType,
    description: d.description,
    sourceGroup,
    isMain,
    devModeRequested,
  });

  const { caseType, autoPromoted } = authDecision;
  const id = generateCaseId();
  const name = generateCaseName(d.description, d.shortName);
  const now = new Date().toISOString();

  const resolvedChatJid =
    d.chatJid ||
    Object.entries(registeredGroups).find(
      ([, g]) => g.folder === sourceGroup,
    )?.[0] ||
    '';

  // Unauthorized dev case → route through approval gate
  if (authDecision.status === 'suggested') {
    const suggested = suggestDevCase({
      groupFolder: sourceGroup,
      chatJid: resolvedChatJid,
      description: autoPromoted
        ? `[auto-promoted work→dev] ${d.description}`
        : d.description,
      sourceWorkCaseId: 'direct-request',
      initiator: d.initiator || 'agent',
      initiatorChannel: undefined,
      githubIssue: d.githubIssue,
    });

    logger.info(
      {
        caseId: suggested.id,
        name: suggested.name,
        sourceGroup,
        autoPromoted,
        reason: authDecision.reason,
      },
      'Dev case routed to approval gate',
    );

    const resultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'case_results');
    fs.mkdirSync(resultDir, { recursive: true });
    const safeReqId = data.requestId
      ? sanitizeRequestId(String(data.requestId))
      : '';
    const resultFile = safeReqId ? `${safeReqId}.json` : `${suggested.id}.json`;
    fs.writeFileSync(
      path.join(resultDir, resultFile),
      JSON.stringify({
        id: suggested.id,
        name: suggested.name,
        workspace_path: '',
        github_issue: suggested.github_issue,
        issue_url: null,
        status: 'suggested',
        needs_approval: true,
      }),
    );

    const mainJid = Object.entries(registeredGroups).find(
      ([, g]) => g.isMain,
    )?.[0];
    if (mainJid) {
      deps
        .sendMessage(
          mainJid,
          `🔒 Dev case needs approval: ${suggested.name}\n${d.description.slice(0, 200)}\n(from: ${sourceGroup}${autoPromoted ? ', auto-promoted from work' : ''})\nReply "approve" to activate.`,
        )
        .catch(() => {});
    }
    return;
  }

  // Authorized case — create immediately
  let githubIssue = d.githubIssue ?? null;
  let issueUrl: string | null = githubIssue
    ? `https://github.com/${DEV_CASE_ISSUE_REPO.owner}/${DEV_CASE_ISSUE_REPO.repo}/issues/${githubIssue}`
    : null;
  if (caseType === 'dev' && !githubIssue) {
    const issueBody = d.context
      ? `## TL;DR\n\n${d.description}\n\n---\n\n## Details\n\n${d.context}\n\n---\n\n*Auto-created by dev case \`${name}\`*`
      : `${d.description}\n\n---\n*Auto-created by dev case \`${name}\`*`;
    const issueResult = await createGitHubIssue({
      owner: DEV_CASE_ISSUE_REPO.owner,
      repo: DEV_CASE_ISSUE_REPO.repo,
      title: d.description,
      body: issueBody,
      labels: ['kaizen'],
    });
    if (issueResult.success && issueResult.issueNumber) {
      githubIssue = issueResult.issueNumber;
      issueUrl = issueResult.issueUrl ?? null;
      logger.info(
        { caseId: id, issueNumber: githubIssue, issueUrl },
        'Auto-created GitHub issue for dev case',
      );
    } else {
      logger.warn(
        { caseId: id, error: issueResult.error },
        'Failed to auto-create GitHub issue for dev case (continuing without)',
      );
    }
  }

  // Reuse existing worktree if provided and valid, otherwise create a new one
  const resolved =
    d.branchName && d.worktreePath
      ? resolveExistingWorktree(d.worktreePath, d.branchName)
      : null;
  const { workspacePath, worktreePath, branchName } =
    resolved || createCaseWorkspace(name, caseType, id);

  // Escalation: compute priority if gap_type is provided
  let computedPriority: PriorityLevel | null = null;
  let computedScore = 0;
  let escalationMeanwhile: string | undefined;
  let escalationConfig: EscalationConfig | null = null;
  if (d.gapType) {
    const group = Object.values(registeredGroups).find(
      (g) => g.folder === sourceGroup,
    );
    escalationConfig = loadEscalationConfigForGroup(group);
    if (escalationConfig && escalationConfig.gap_types[d.gapType]) {
      const signals = detectSignals(
        escalationConfig,
        d.initiator || 'agent',
        isMain,
        d.signals,
      );
      try {
        const priorityResult = computePriority(
          escalationConfig,
          d.gapType,
          signals,
        );
        computedPriority = priorityResult.level;
        computedScore = priorityResult.score;
        const gapConfig = escalationConfig.gap_types[d.gapType];
        escalationMeanwhile = escalationConfig.meanwhile?.[gapConfig.status];
        logger.info(
          {
            caseId: id,
            gapType: d.gapType,
            priority: computedPriority,
            score: priorityResult.score,
            signals,
          },
          'Escalation priority computed for new case',
        );
      } catch (err) {
        logger.warn(
          { err, caseId: id, gapType: d.gapType },
          'Failed to compute escalation priority',
        );
      }
    } else if (escalationConfig) {
      logger.warn(
        { gapType: d.gapType, caseId: id },
        'Unknown gap type in escalation config, skipping priority computation',
      );
    }
  }

  const newCase: Case = {
    id,
    group_folder: sourceGroup,
    chat_jid: resolvedChatJid,
    name,
    description: d.description,
    type: caseType,
    status: 'active',
    blocked_on: null,
    worktree_path: worktreePath,
    workspace_path: workspacePath,
    branch_name: branchName,
    initiator: d.initiator || 'agent',
    initiator_channel: null,
    last_message: null,
    last_activity_at: now,
    conclusion: null,
    created_at: now,
    done_at: null,
    reviewed_at: null,
    pruned_at: null,
    total_cost_usd: 0,
    token_source: null,
    time_spent_ms: 0,
    github_issue: githubIssue,
    github_issue_url: issueUrl || null,
    customer_name: (data.customer_name as string) || null,
    customer_phone: (data.customer_phone as string) || null,
    customer_email: (data.customer_email as string) || null,
    customer_org: (data.customer_org as string) || null,
    priority: computedPriority,
    gap_type: d.gapType || null,
  };

  insertCase(newCase);
  logger.info(
    {
      caseId: id,
      name,
      caseType,
      sourceGroup,
      githubIssue,
      autoPromoted,
      reason: authDecision.reason,
    },
    'Case created via IPC',
  );

  const resultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'case_results');
  fs.mkdirSync(resultDir, { recursive: true });
  const safeReqId = data.requestId
    ? sanitizeRequestId(String(data.requestId))
    : '';
  const resultFile = safeReqId ? `${safeReqId}.json` : `${id}.json`;
  fs.writeFileSync(
    path.join(resultDir, resultFile),
    JSON.stringify({
      id,
      name,
      workspace_path: workspacePath,
      github_issue: githubIssue,
      issue_url: issueUrl,
      ...(computedPriority ? { priority: computedPriority } : {}),
      ...(d.gapType ? { gap_type: d.gapType } : {}),
      ...(escalationMeanwhile ? { meanwhile: escalationMeanwhile } : {}),
    }),
  );

  // Dispatch escalation notifications if priority was computed
  if (computedPriority && escalationConfig && d.gapType) {
    const targets = resolveNotificationTargets(
      escalationConfig,
      computedPriority,
    );
    if (targets.length > 0) {
      const notification: EscalationNotification = {
        caseName: name,
        caseId: id,
        description: d.description,
        gapType: d.gapType,
        gapDescription: escalationConfig.gap_types[d.gapType]?.description,
        priority: computedPriority,
        score: computedScore,
        sourceGroup,
        context: d.context,
      };
      dispatchEscalationNotifications(notification, targets, deps).catch(
        (err) => {
          logger.error(
            { err, caseId: id },
            'Failed to dispatch escalation notifications',
          );
        },
      );
    }
  }

  const notifyJid =
    caseType === 'dev'
      ? Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0] ||
        resolvedChatJid
      : resolvedChatJid;
  if (notifyJid) {
    const issueInfo = issueUrl ? `\nGitHub: ${issueUrl}` : '';
    deps
      .sendMessage(
        notifyJid,
        `📋 New ${caseType} case created: ${name}\n${d.description.slice(0, 200)}${issueInfo}`,
      )
      .catch(() => {});
  }
}

function handleCaseSuggestDev(
  data: Record<string, unknown>,
  sourceGroup: string,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  if (!data.description || !data.sourceCaseId) return;

  const d = data as unknown as {
    description: string;
    sourceCaseId: string;
    chatJid?: string;
    githubIssue?: number;
  };

  const sourceCase = getCaseById(d.sourceCaseId);
  let linkedDescription = d.description;
  if (sourceCase?.github_issue_url) {
    linkedDescription += ` (source: ${sourceCase.github_issue_url})`;
  }

  suggestDevCase({
    groupFolder: sourceGroup,
    chatJid: d.chatJid || '',
    description: linkedDescription,
    sourceWorkCaseId: d.sourceCaseId,
    initiator: 'agent',
    initiatorChannel: undefined,
    githubIssue: d.githubIssue,
  });

  const targetJid =
    Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0] ||
    Object.entries(registeredGroups).find(
      ([, g]) => g.folder === sourceGroup,
    )?.[0];
  if (targetJid) {
    deps
      .sendMessage(
        targetJid,
        `💡 Dev case suggested: ${d.description.slice(0, 200)}\n(from case ${d.sourceCaseId})\nReply "approve" to add to backlog.`,
      )
      .catch(() => {});
  }
}
