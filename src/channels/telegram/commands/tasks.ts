import type { Bot } from 'grammy';

import { TIMEZONE } from '../../../config.js';
import { getTasksForGroup } from '../../../db.js';
import type { ScheduledTask } from '../../../types.js';
import type { ChannelOpts } from '../../registry.js';

export interface TasksCommandDeps {
  opts: ChannelOpts;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ja-JP', {
    timeZone: TIMEZONE,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTasksList(tasks: ScheduledTask[]): string {
  return tasks
    .map((t) => {
      const model = t.model ? `\`${t.model}\`` : '(default)';
      const effort = t.effort ? `\`${t.effort}\`` : '(default)';
      const tb = t.thinking_budget ? `\`${t.thinking_budget}\`` : '(default)';
      const prompt =
        t.prompt.length > 60 ? t.prompt.slice(0, 57) + '...' : t.prompt;
      return [
        `\`${t.id}\` | ${t.schedule_type} ${t.schedule_value} | ${t.status} | ${t.context_mode || 'isolated'}`,
        `  ${t.name ? `Name: ${t.name} | ` : ''}Model: ${model} | Effort: ${effort} | Thinking: ${tb}`,
        `  Last: ${formatTime(t.last_run)} | Next: ${formatTime(t.next_run)}`,
        `  Prompt: ${prompt}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function registerTasksCommand(bot: Bot, deps: TasksCommandDeps): void {
  bot.command('tasks', (ctx) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = deps.opts.registeredGroups()[chatJid];
    if (!group) {
      ctx.reply('This chat is not registered.');
      return;
    }
    const tasks = getTasksForGroup(group.folder);
    if (tasks.length === 0) {
      ctx.reply('No tasks for this group.');
      return;
    }
    ctx.reply(formatTasksList(tasks), { parse_mode: 'Markdown' });
  });
}
