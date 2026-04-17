import type { Bot } from 'grammy';

import { DEFAULT_MODEL } from '../../../config.js';
import type { ChannelOpts } from '../../registry.js';

export interface StatusCommandDeps {
  opts: ChannelOpts;
}

/** Format a status payload for human reading, shared with tests. */
export function formatStatus(
  group: { folder: string; model?: string; effort?: string },
  status: ReturnType<ChannelOpts['getStatus']>,
): string {
  const model = group.model || DEFAULT_MODEL;
  const sessionId = status.sessions[group.folder];
  const usage = status.lastUsage[group.folder];
  const compacts = status.compactCount[group.folder] || 0;
  const rateLimit = status.lastRateLimit[group.folder];

  const hours = Math.floor(status.uptimeSeconds / 3600);
  const minutes = Math.floor((status.uptimeSeconds % 3600) / 60);
  const uptime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const lines = [
    `Status: Online`,
    `Uptime: ${uptime}`,
    `Active containers: ${status.activeContainers}`,
    `Model: \`${model}\``,
    `Effort: \`${group.effort || 'default'}\``,
    `Session: ${sessionId ? `\`${sessionId.slice(0, 12)}...\`` : 'none'}`,
  ];

  if (usage) {
    const usedK = Math.round(usage.inputTokens / 1000);
    const totalK = usage.contextWindow
      ? Math.round(usage.contextWindow / 1000)
      : '?';
    lines.push(`Context: ${usedK}k/${totalK}k`);
  } else {
    lines.push('Context: no usage data');
  }

  lines.push(`Compactions: ${compacts}`);

  if (rateLimit?.utilization != null) {
    const pct = Math.round(rateLimit.utilization * 100);
    let resetStr = 'unknown';
    if (rateLimit.resetsAt) {
      const resetDate = new Date(rateLimit.resetsAt * 1000);
      const hh = resetDate.getHours().toString().padStart(2, '0');
      const mm = resetDate.getMinutes().toString().padStart(2, '0');
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dow = days[resetDate.getDay()];
      resetStr = `${hh}:${mm} ${dow}.`;
    }
    lines.push(`Weekly usage: ${pct}% / Reset at: ${resetStr}`);
  }

  return lines.join('\n');
}

export function registerStatusCommand(
  bot: Bot,
  deps: StatusCommandDeps,
): void {
  bot.command('status', (ctx) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = deps.opts.registeredGroups()[chatJid];
    if (!group) {
      ctx.reply('This chat is not registered.');
      return;
    }
    const text = formatStatus(group, deps.opts.getStatus());
    ctx.reply(text, { parse_mode: 'Markdown' });
  });
}
