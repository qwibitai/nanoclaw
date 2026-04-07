import {
  ContainerOutput,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../container-runner.js';
import { getAllTasks } from '../db.js';
import { isError } from '../error-utils.js';
import { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import { readModelSwitchHandoff } from '../model-switch.js';
import {
  getAgentType,
  requiresContainerRuntime,
  resolveAgentRuntime,
} from '../runtimes/index.js';
import { shouldResetSessionOnFailure } from '../session-recovery.js';
import type { RegisteredGroup } from '../types.js';
import { AgentSessionService } from './agent-session-service.js';

export interface AgentExecutionServiceDeps {
  assistantName: string;
  queue: GroupQueue;
  sessionService: AgentSessionService;
  getAvailableGroups: () => import('../container-runner.js').AvailableGroup[];
  getRegisteredJids: () => Set<string>;
}

export class AgentExecutionService {
  constructor(private readonly deps: AgentExecutionServiceDeps) {}

  async runForGroup(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<'success' | 'error'> {
    const isMain = group.isMain === true;
    const agentType = getAgentType(group);
    const sessionId = this.deps.sessionService.getLiveSession(
      group.folder,
      agentType,
    );
    const handoff = !sessionId ? readModelSwitchHandoff(group.folder) : null;
    const runtime = resolveAgentRuntime(group);
    const effectivePrompt = handoff
      ? `[MODEL SWITCH HANDOFF]\n${handoff}\n\n---\n\n${prompt}`
      : prompt;

    if (requiresContainerRuntime(group)) {
      const tasks = getAllTasks();
      writeTasksSnapshot(
        group.folder,
        isMain,
        tasks.map((task) => ({
          id: task.id,
          groupFolder: task.group_folder,
          prompt: task.prompt,
          schedule_type: task.schedule_type,
          schedule_value: task.schedule_value,
          status: task.status,
          next_run: task.next_run,
        })),
      );

      writeGroupsSnapshot(
        group.folder,
        isMain,
        this.deps.getAvailableGroups(),
        this.deps.getRegisteredJids(),
      );
    }

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId) {
            this.deps.sessionService.recordSession(
              group.folder,
              agentType,
              output.newSessionId,
            );
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const output = await runtime.run({
        group,
        prompt: effectivePrompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: this.deps.assistantName,
        onProcess: (proc, containerName) =>
          this.deps.queue.registerProcess(
            chatJid,
            proc,
            containerName,
            group.folder,
          ),
        onOutput: wrappedOnOutput,
      });

      if (output.newSessionId) {
        this.deps.sessionService.recordSession(
          group.folder,
          agentType,
          output.newSessionId,
        );
      }

      if (output.status === 'error') {
        if (
          agentType === 'claude-code' &&
          shouldResetSessionOnFailure(output)
        ) {
          this.deps.sessionService.clearLiveSession(group.folder, agentType);
        }
        logger.error({ group: group.name, error: output.error }, 'Agent error');
        return 'error';
      }

      return 'success';
    } catch (err) {
      if (!isError(err)) throw err;
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }
}
