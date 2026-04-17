import { ASSISTANT_NAME, HOST_MODE } from '../config.js';
import {
  type ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../container-runner.js';
import { deleteSession, getAllTasks, setSession } from '../db.js';
import type { GroupQueue } from '../group-queue.js';
import { runHostAgent } from '../host-runner.js';
import { logger } from '../logger.js';
import { findChannel } from '../router.js';
import type { SessionGuard } from '../session-guard.js';
import type { Channel, RegisteredGroup } from '../types.js';

import { getAvailableGroups as getAvailableGroupsFn } from './group-registry.js';
import type { OrchestratorState } from './state.js';

export interface RunAgentDeps {
  state: OrchestratorState;
  queue: GroupQueue;
  channels: Channel[];
  sessionGuard: SessionGuard;
}

/**
 * Spawn the agent (container or host) for a group and pipe its output
 * back through `onOutput`. Bundles the snapshot writes, session-id
 * persistence, usage tracking, and stale-session detection that
 * surround every agent invocation.
 */
export function createRunAgent(
  deps: RunAgentDeps,
): (
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  effectiveModel: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
) => Promise<'success' | 'error'> {
  const { state, queue, channels, sessionGuard } = deps;

  return async function runAgent(
    group,
    prompt,
    chatJid,
    effectiveModel,
    onOutput,
  ) {
    const isMain = group.isMain === true;
    sessionGuard.startRun(group.folder);
    const sessionId = state.sessions[group.folder];

    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        name: t.name,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        context_mode: t.context_mode,
        silent: t.silent,
        model: t.model,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    const availableGroups = getAvailableGroupsFn(state.registeredGroups);
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(state.registeredGroups)),
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId && !sessionGuard.isCleared(group.folder)) {
            state.sessions[group.folder] = output.newSessionId;
            setSession(group.folder, output.newSessionId);

            if (state.compactPending.has(chatJid)) {
              state.compactPending.delete(chatJid);
              const ch = findChannel(channels, chatJid);
              if (ch) {
                ch.sendMessage(chatJid, 'Compact completed.').catch(() => {});
              }
            }
          }
          if (output.usage) {
            state.lastUsage[group.folder] = {
              ...output.usage,
              contextWindow:
                output.contextWindow ??
                state.lastUsage[group.folder]?.contextWindow,
            };
          }
          if (output.compacted) {
            state.compactCount[group.folder] =
              (state.compactCount[group.folder] || 0) + 1;
          }
          if (output.rateLimit) {
            state.lastRateLimit[group.folder] = output.rateLimit;
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const runAgentFn = HOST_MODE ? runHostAgent : runContainerAgent;
      const output = await runAgentFn(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
          model: effectiveModel,
          effort: group.effort,
          thinking_budget: group.thinking_budget,
        },
        (proc, containerName) =>
          queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
      );

      if (output.newSessionId && !sessionGuard.isCleared(group.folder)) {
        state.sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      }
      if (output.usage) {
        state.lastUsage[group.folder] = {
          ...output.usage,
          contextWindow:
            output.contextWindow ??
            state.lastUsage[group.folder]?.contextWindow,
        };
      }
      if (output.compacted) {
        state.compactCount[group.folder] =
          (state.compactCount[group.folder] || 0) + 1;
      }
      if (output.rateLimit) {
        state.lastRateLimit[group.folder] = output.rateLimit;
      }

      if (output.status === 'error') {
        state.compactPending.delete(chatJid);
        const isStaleSession =
          sessionId &&
          output.error &&
          /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
            output.error,
          );

        if (isStaleSession) {
          logger.warn(
            {
              group: group.name,
              staleSessionId: sessionId,
              error: output.error,
            },
            'Stale session detected — clearing for next retry',
          );
          delete state.sessions[group.folder];
          deleteSession(group.folder);
        }

        logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        return 'error';
      }

      return 'success';
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  };
}
