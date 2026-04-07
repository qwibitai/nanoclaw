import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  deleteRegisteredGroup,
  getAllGroupsForJid,
  getRegisteredAgentTypesForJid,
  getRouterState,
  setRegisteredGroup,
  setGroupPause,
} from '../db.js';
import { DEFAULT_TRIGGER, TIMEZONE } from '../config.js';
import { isError, isSyntaxError } from '../error-utils.js';
import { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import {
  ensureOllamaServerRunning,
  resolvePreferredOllamaModel,
  writeModelSwitchHandoff,
} from '../model-switch.js';
import { findChannel } from '../router.js';
import { startRemoteControl, stopRemoteControl } from '../remote-control.js';
import { getAgentType } from '../runtimes/index.js';
import type { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { AgentSessionService } from './agent-session-service.js';

interface ChannelCommandServiceDeps {
  channels: Channel[];
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  sessionService: AgentSessionService;
}

export function createChannelCommandService(deps: ChannelCommandServiceDeps): {
  handleInboundCommand(chatJid: string, msg: NewMessage): Promise<boolean>;
} {
  const handledPauseCommands = new Set<string>();
  const handledSessionCommands = new Set<string>();
  const handledModelCommands = new Set<string>();
  const handledStatusCommands = new Set<string>();

  function normalizeInboundCommand(
    rawContent: string,
    group?: RegisteredGroup,
  ): string {
    const trimmed = rawContent.trim();
    const candidatePrefixes = [
      group?.trigger?.trim(),
      DEFAULT_TRIGGER,
      '@nanoclaw_admin',
      '@claude_bot',
      '@claude',
    ].filter((value): value is string =>
      Boolean(value && value.trim().length > 0),
    );

    for (const prefix of candidatePrefixes) {
      if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const remainder = trimmed.slice(prefix.length).trimStart();
      if (remainder.startsWith('/')) return remainder;
    }

    return trimmed;
  }

  function normalizeAgentType(value?: string): string | undefined {
    if (!value) return undefined;
    const lowered = value.toLowerCase();
    if (lowered === 'claude') return 'claude-code';
    if (lowered === 'claude-code' || lowered === 'codex') {
      return lowered;
    }
    return undefined;
  }

  function formatModelStatus(group: RegisteredGroup): string {
    const agentType = getAgentType(group);
    const model = group.containerConfig?.model || 'default';
    const effort = group.containerConfig?.reasoningEffort || 'default';
    const providerPreset = group.containerConfig?.providerPreset || 'default';
    const thinking = group.containerConfig?.thinking;
    const budget = group.containerConfig?.thinkingBudget;
    const extras = [
      `agent=\`${agentType}\``,
      `provider=\`${providerPreset}\``,
      `model=\`${model}\``,
      `effort=\`${effort}\``,
    ];
    if (thinking !== undefined)
      extras.push(`thinking=\`${thinking ? 'on' : 'off'}\``);
    if (budget !== undefined) extras.push(`budget=\`${budget}\``);
    return extras.join(', ');
  }

  function formatElapsed(ms: number | null): string {
    if (!ms || ms < 1000) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600)
      return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  }

  function getRestartedAt(): string {
    return new Date(Date.now() - process.uptime() * 1000).toISOString();
  }

  function getVersionLabel(): string {
    let appVersion = 'unknown';
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
      ) as { version?: string };
      appVersion = packageJson.version || appVersion;
    } catch (err) {
      if (!isSyntaxError(err) && !isError(err)) throw err;
    }

    try {
      const sha = execSync('git rev-parse --short HEAD', {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      const dirty = execSync('git status --porcelain', {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      return dirty ? `${appVersion} (${sha}, dirty)` : `${appVersion} (${sha})`;
    } catch (err) {
      if (!isError(err)) throw err;
      return appVersion;
    }
  }

  async function handleStatusCommand(chatJid: string): Promise<void> {
    const group = deps.getRegisteredGroups()[chatJid];
    const channel =
      findChannel(deps.channels, chatJid) ??
      deps.channels.find((ch) => ch.isConnected());
    if (!group || !channel) return;

    if (!group.isMain) {
      await channel.sendMessage(
        chatJid,
        '⚠️ `/status` is allowed only in the main admin channel.',
      );
      return;
    }

    const queueStatus = deps.queue.getStatuses([chatJid])[0];
    const sessionId = deps.sessionService.getLiveSession(
      group.folder,
      getAgentType(group),
    );
    const agentCursorRaw = getRouterState('last_agent_timestamp');
    let lastAgentCursor = '-';
    if (agentCursorRaw) {
      try {
        const parsed = JSON.parse(agentCursorRaw) as Record<string, string>;
        lastAgentCursor = parsed[chatJid] || '-';
      } catch (err) {
        if (!isSyntaxError(err)) throw err;
        lastAgentCursor = 'invalid';
      }
    }

    const lines = [
      '**NanoClaw Admin Status**',
      `Version: \`${getVersionLabel()}\``,
      `Restarted: \`${getRestartedAt()}\``,
      `Runtime: ${formatModelStatus(group)}`,
      `Queue: \`${queueStatus.status}\`${queueStatus.elapsedMs !== null ? ` (${formatElapsed(queueStatus.elapsedMs)})` : ''}`,
      `Pending: messages=\`${queueStatus.pendingMessages ? 'yes' : 'no'}\`, tasks=\`${queueStatus.pendingTasks}\``,
      `Session: \`${sessionId || 'none'}\``,
      `Cursor: \`${lastAgentCursor}\``,
      `Channel: \`${chatJid}\` folder=\`${group.folder}\``,
    ];

    await channel.sendMessage(chatJid, lines.join('\n'));
  }

  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = deps.getRegisteredGroups()[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(deps.channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
      return;
    }

    const result = stopRemoteControl();
    if (result.ok) {
      await channel.sendMessage(chatJid, 'Remote Control session ended.');
    } else {
      await channel.sendMessage(chatJid, result.error);
    }
  }

  async function handlePauseCommand(
    command: string,
    chatJid: string,
  ): Promise<void> {
    const channel =
      findChannel(deps.channels, chatJid) ??
      deps.channels.find((ch) => ch.isConnected());
    if (!channel) return;

    const parts = command.split(/\s+/);
    const cmd = parts[0];

    if (cmd === '/pause') {
      const hours = parseFloat(parts[1] || '');
      if (isNaN(hours) || hours <= 0) {
        await channel.sendMessage(
          chatJid,
          '⚠️ Usage: `/pause <hours> [agent_type]`\nExample: `/pause 1` or `/pause 2 codex`',
        );
        return;
      }

      let targetAgent = parts[2]?.toLowerCase();
      if (targetAgent === 'claude') targetAgent = 'claude-code';

      const agentTypes = getRegisteredAgentTypesForJid(chatJid);
      if (agentTypes.length === 0) return;

      const pausedUntil = new Date(Date.now() + hours * 3600000).toISOString();
      if (targetAgent) {
        if (!agentTypes.includes(targetAgent)) {
          await channel.sendMessage(
            chatJid,
            `⚠️ Agent \`${targetAgent}\` is not registered in this channel.\nAvailable: ${agentTypes.join(', ')}`,
          );
          return;
        }
        setGroupPause(chatJid, targetAgent, pausedUntil);
      } else {
        for (const at of agentTypes) {
          setGroupPause(chatJid, at, pausedUntil);
        }
      }

      const resumeTime = new Date(Date.now() + hours * 3600000);
      const timeStr = resumeTime.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: TIMEZONE,
      });
      const agentLabel = targetAgent ?? 'All agents';
      await channel.sendMessage(
        chatJid,
        `⏸ **${agentLabel}** paused until ${timeStr} (${hours}h)`,
      );
      logger.info(
        { chatJid, agentLabel, hours },
        'Agent(s) paused via /pause command',
      );
      return;
    }

    let targetAgent = parts[1]?.toLowerCase();
    if (targetAgent === 'claude') targetAgent = 'claude-code';

    const agentTypes = getRegisteredAgentTypesForJid(chatJid);
    if (agentTypes.length === 0) return;

    if (targetAgent) {
      if (!agentTypes.includes(targetAgent)) {
        await channel.sendMessage(
          chatJid,
          `⚠️ Agent \`${targetAgent}\` is not registered in this channel.\nAvailable: ${agentTypes.join(', ')}`,
        );
        return;
      }
      setGroupPause(chatJid, targetAgent, null);
    } else {
      for (const at of agentTypes) {
        setGroupPause(chatJid, at, null);
      }
    }

    const agentLabel = targetAgent ?? 'All agents';
    await channel.sendMessage(chatJid, `▶️ **${agentLabel}** resumed`);
    logger.info(
      { chatJid, agentLabel },
      'Agent(s) resumed via /resume command',
    );
  }

  async function handleSessionCommand(
    command: string,
    chatJid: string,
  ): Promise<void> {
    const channel =
      findChannel(deps.channels, chatJid) ??
      deps.channels.find((ch) => ch.isConnected());
    if (!channel) return;

    const parts = command.trim().split(/\s+/);
    const cmd = parts[0];
    let targetAgent = parts[1]?.toLowerCase();
    if (targetAgent === 'claude') targetAgent = 'claude-code';

    if (targetAgent !== 'codex') {
      await channel.sendMessage(
        chatJid,
        '⚠️ Session commands currently support only `codex`.\nExamples: `/sessions codex`, `/new codex feature-a`, `/switch codex feature-a`',
      );
      return;
    }

    const group = getAllGroupsForJid(chatJid).find(
      (item) => getAgentType(item) === 'codex',
    );
    if (!group) {
      await channel.sendMessage(
        chatJid,
        '⚠️ No Codex group is registered for this channel.',
      );
      return;
    }

    const currentLabel = deps.sessionService.getCurrentLabel(
      group.folder,
      'codex',
    );

    if (cmd === '/sessions') {
      const namedSessions = deps.sessionService.listNamedSessions(
        group.folder,
        'codex',
      );
      if (namedSessions.length === 0) {
        await channel.sendMessage(
          chatJid,
          `Codex sessions: active=\`${currentLabel}\`, saved sessions=none yet.`,
        );
        return;
      }

      const lines = namedSessions.slice(0, 12).map((session) => {
        const marker = session.session_label === currentLabel ? '*' : '-';
        return `${marker} \`${session.session_label}\` (${session.updated_at.replace('T', ' ').slice(0, 16)})`;
      });
      await channel.sendMessage(
        chatJid,
        `Codex sessions for \`${group.folder}\`:\n${lines.join('\n')}`,
      );
      return;
    }

    const rawLabel = parts.slice(2).join(' ').trim();
    const label = deps.sessionService.slugifyLabel(
      rawLabel || deps.sessionService.createGeneratedLabel(),
    );
    if (!label) {
      await channel.sendMessage(
        chatJid,
        '⚠️ Session label is empty after normalization.',
      );
      return;
    }

    if (cmd === '/new') {
      if (deps.sessionService.getNamedSession(group.folder, 'codex', label)) {
        await channel.sendMessage(
          chatJid,
          `⚠️ Codex session \`${label}\` already exists. Use \`/switch codex ${label}\` instead.`,
        );
        return;
      }

      deps.sessionService.startFreshSession(group.folder, 'codex', label);
      deps.queue.closeStdin(chatJid);
      await channel.sendMessage(
        chatJid,
        `Started a fresh Codex session slot \`${label}\`. The next Codex message will begin a new thread.`,
      );
      return;
    }

    if (cmd === '/switch') {
      const named = deps.sessionService.switchToNamedSession(
        group.folder,
        'codex',
        label,
      );
      if (!named) {
        await channel.sendMessage(
          chatJid,
          `⚠️ Unknown Codex session \`${label}\`. Use \`/sessions codex\` to list available sessions.`,
        );
        return;
      }

      deps.queue.closeStdin(chatJid);
      await channel.sendMessage(
        chatJid,
        `Switched Codex to session \`${label}\`. The next Codex message will resume that thread.`,
      );
    }
  }

  async function handleModelCommand(
    command: string,
    chatJid: string,
  ): Promise<void> {
    const group = deps.getRegisteredGroups()[chatJid];
    const channel =
      findChannel(deps.channels, chatJid) ??
      deps.channels.find((ch) => ch.isConnected());
    if (!group || !channel) return;

    const parts = command.trim().split(/\s+/);
    if (parts.length === 1 || parts[1] === 'show' || parts[1] === 'status') {
      await channel.sendMessage(
        chatJid,
        `Current runtime: ${formatModelStatus(group)}`,
      );
      return;
    }

    if (parts[1] === 'reset') {
      const updatedGroup: RegisteredGroup = {
        ...group,
        containerConfig: {
          ...group.containerConfig,
          providerPreset: undefined,
          model: undefined,
          reasoningEffort: undefined,
          thinking: undefined,
          thinkingBudget: undefined,
        },
      };
      if (
        updatedGroup.containerConfig &&
        Object.values(updatedGroup.containerConfig).every(
          (value) => value === undefined,
        )
      ) {
        updatedGroup.containerConfig = undefined;
      }
      deps.getRegisteredGroups()[chatJid] = updatedGroup;
      setRegisteredGroup(chatJid, updatedGroup);
      deps.sessionService.clearLiveSession(
        updatedGroup.folder,
        getAgentType(updatedGroup),
      );
      deps.queue.closeStdin(chatJid);
      await channel.sendMessage(
        chatJid,
        `Reset admin runtime overrides. Current: ${formatModelStatus(updatedGroup)}`,
      );
      return;
    }

    const currentAgentType = getAgentType(group);
    const isClaudeRoom = currentAgentType === 'claude-code';
    let nextAgentType: string | undefined;
    let providerPreset: 'anthropic' | 'ollama' | undefined =
      group.containerConfig?.providerPreset;
    let model: string | undefined;
    let reasoningEffort: string | undefined;

    if (group.isMain) {
      nextAgentType = normalizeAgentType(parts[1]);
      if (!nextAgentType) {
        await channel.sendMessage(
          chatJid,
          '⚠️ Usage: `/model <claude|codex> [model|ollama] [effort]`\nExamples: `/model codex gpt-5.4 high`, `/model claude sonnet`, `/model claude ollama`, `/model status`, `/model reset`',
        );
        return;
      }
      model = parts[2];
      reasoningEffort = parts[3];
    } else if (isClaudeRoom) {
      nextAgentType = 'claude-code';
      model = parts[1];
      reasoningEffort = parts[2];
    } else {
      await channel.sendMessage(
        chatJid,
        '⚠️ Non-admin `/model` is currently supported only in Claude channels.',
      );
      return;
    }

    if (nextAgentType === 'claude-code') {
      if (model?.toLowerCase() === 'ollama') {
        const ollama = await ensureOllamaServerRunning();
        if (!ollama.ok) {
          await channel.sendMessage(
            chatJid,
            `⚠️ Failed to switch to Ollama: ${ollama.error}`,
          );
          return;
        }
        providerPreset = 'ollama';
        model = resolvePreferredOllamaModel();
        reasoningEffort = undefined;
      } else {
        providerPreset = 'anthropic';
      }
    }

    const previousAgentType = getAgentType(group);
    const updatedGroup: RegisteredGroup = {
      ...group,
      agentType: nextAgentType,
      containerConfig: {
        ...group.containerConfig,
        providerPreset,
        model: model || undefined,
        reasoningEffort: reasoningEffort || undefined,
      },
    };

    if (previousAgentType !== nextAgentType) {
      deleteRegisteredGroup(chatJid, previousAgentType);
    }
    const handoffPath = writeModelSwitchHandoff({
      chatJid,
      group,
      previousRuntime: formatModelStatus(group),
      nextRuntime: formatModelStatus(updatedGroup),
      requestedBy: group.isMain ? 'admin' : group.name,
    });
    deps.getRegisteredGroups()[chatJid] = updatedGroup;
    setRegisteredGroup(chatJid, updatedGroup);
    deps.sessionService.clearLiveSession(group.folder, previousAgentType);
    deps.sessionService.clearLiveSession(group.folder, nextAgentType);
    deps.queue.closeStdin(chatJid);

    await channel.sendMessage(
      chatJid,
      `Updated runtime: ${formatModelStatus(updatedGroup)}. Next message will use a fresh session.\nHandoff: \`${handoffPath}\``,
    );
    logger.info(
      {
        chatJid,
        previousAgentType,
        nextAgentType,
        model,
        reasoningEffort,
      },
      'Admin runtime changed via /model command',
    );
  }

  return {
    async handleInboundCommand(
      chatJid: string,
      msg: NewMessage,
    ): Promise<boolean> {
      const trimmed = normalizeInboundCommand(
        msg.content,
        deps.getRegisteredGroups()[chatJid],
      );

      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        await handleRemoteControl(trimmed, chatJid, msg);
        return true;
      }

      if (trimmed.startsWith('/pause') || trimmed.startsWith('/resume')) {
        if (handledPauseCommands.has(msg.id)) return true;
        handledPauseCommands.add(msg.id);
        setTimeout(() => handledPauseCommands.delete(msg.id), 5000);
        await handlePauseCommand(trimmed, chatJid);
        return true;
      }

      if (
        trimmed.startsWith('/sessions') ||
        trimmed.startsWith('/new ') ||
        trimmed === '/new' ||
        trimmed.startsWith('/switch ')
      ) {
        if (handledSessionCommands.has(msg.id)) return true;
        handledSessionCommands.add(msg.id);
        setTimeout(() => handledSessionCommands.delete(msg.id), 5000);
        await handleSessionCommand(trimmed, chatJid);
        return true;
      }

      if (trimmed.startsWith('/model')) {
        if (handledModelCommands.has(msg.id)) return true;
        handledModelCommands.add(msg.id);
        setTimeout(() => handledModelCommands.delete(msg.id), 5000);
        await handleModelCommand(trimmed, chatJid);
        return true;
      }

      if (trimmed === '/status') {
        if (handledStatusCommands.has(msg.id)) return true;
        handledStatusCommands.add(msg.id);
        setTimeout(() => handledStatusCommands.delete(msg.id), 5000);
        await handleStatusCommand(chatJid);
        return true;
      }

      return false;
    },
  };
}
