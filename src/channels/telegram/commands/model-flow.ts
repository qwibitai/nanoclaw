import type { Bot, Context } from 'grammy';

import { DEFAULT_MODEL, resolveModelAlias } from '../../../config.js';
import { getTaskById, setGroupModel, updateTask } from '../../../db.js';
import type { RegisteredGroup } from '../../../types.js';
import { buildTargetKeyboard } from '../keyboards.js';

import {
  handleEffortPick,
  handleModelPick,
  handleTargetBack,
  handleTargetGrp,
  handleTargetTask,
  handleTaskPick,
  handleThinkingBudgetPick,
} from './model-flow-handlers.js';

/**
 * Dependencies for the /model command and its unified callback handler.
 */
export interface ModelFlowDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Register /model + the cfg:* callback handler (4-step inline-keyboard
 * flow: target → model → effort → thinking budget). Also supports
 * legacy text-arg shortcuts for backwards compat.
 */
export function registerModelFlow(bot: Bot, deps: ModelFlowDeps): void {
  bot.command('model', (ctx) => handleModelCommand(ctx, deps));
  bot.callbackQuery(/^cfg:/, (ctx) => handleConfigCallback(ctx, deps));
}

function handleModelCommand(ctx: Context, deps: ModelFlowDeps): void {
  if (!ctx.chat) return;
  const chatJid = `tg:${ctx.chat.id}`;
  const group = deps.registeredGroups()[chatJid];
  if (!group) {
    ctx.reply('This chat is not registered.');
    return;
  }

  const args = (ctx.message?.text || '').split(/\s+/).slice(1);
  if (args.length > 0) {
    if (args[0] === 'task') {
      handleModelTaskShortcut(ctx, args);
      return;
    }
    if (args[0] === 'reset') {
      resetGroupModel(ctx, chatJid, group);
      return;
    }
    setGroupModelShortcut(ctx, chatJid, group, args[0]);
    return;
  }

  const current = group.model || DEFAULT_MODEL;
  ctx.reply(`Model: \`${current}\`\nSelect target:`, {
    parse_mode: 'Markdown',
    reply_markup: buildTargetKeyboard(),
  });
}

function resetGroupModel(
  ctx: Context,
  chatJid: string,
  group: RegisteredGroup,
): void {
  const previous = group.model || DEFAULT_MODEL;
  setGroupModel(chatJid, null);
  group.model = undefined;
  group.agentModelOverride = undefined;
  group.agentModelOverrideSetAt = undefined;
  if (previous !== DEFAULT_MODEL) {
    group.pendingModelNotice = `[model has switched from ${previous} to ${DEFAULT_MODEL}]`;
  }
  ctx.reply(`Model reset to default (\`${DEFAULT_MODEL}\`).`, {
    parse_mode: 'Markdown',
  });
}

function setGroupModelShortcut(
  ctx: Context,
  chatJid: string,
  group: RegisteredGroup,
  raw: string,
): void {
  const resolved = resolveModelAlias(raw);
  const previous = group.model || DEFAULT_MODEL;
  setGroupModel(chatJid, resolved);
  group.model = resolved;
  group.agentModelOverride = undefined;
  group.agentModelOverrideSetAt = undefined;
  if (previous !== resolved) {
    group.pendingModelNotice = `[model has switched from ${previous} to ${resolved}]`;
  }
  ctx.reply(`Model set to \`${resolved}\`.`, { parse_mode: 'Markdown' });
}

function handleModelTaskShortcut(ctx: Context, args: string[]): void {
  if (args.length < 3) {
    ctx.reply('Usage: `/model task <task-id> <model|reset>`', {
      parse_mode: 'Markdown',
    });
    return;
  }
  const taskId = args[1];
  const task = getTaskById(taskId);
  if (!task) {
    ctx.reply(`Task \`${taskId}\` not found.`, { parse_mode: 'Markdown' });
    return;
  }
  if (args[2] === 'reset') {
    updateTask(taskId, { model: null });
    ctx.reply(`Task \`${taskId}\` model reset to default.`, {
      parse_mode: 'Markdown',
    });
  } else {
    const resolved = resolveModelAlias(args[2]);
    updateTask(taskId, { model: resolved });
    ctx.reply(`Task \`${taskId}\` model set to \`${resolved}\`.`, {
      parse_mode: 'Markdown',
    });
  }
}

function handleConfigCallback(ctx: Context, deps: ModelFlowDeps): void {
  if (!ctx.callbackQuery || !ctx.chat) {
    ctx.answerCallbackQuery();
    return;
  }
  const data = ctx.callbackQuery.data ?? '';
  const chatJid = `tg:${ctx.chat.id}`;
  const group = deps.registeredGroups()[chatJid];
  if (!group) {
    ctx.answerCallbackQuery('Not registered.');
    return;
  }

  if (data === 'cfg:tgt:grp') return handleTargetGrp(ctx, group);
  if (data === 'cfg:tgt:task') return handleTargetTask(ctx, group);
  if (data === 'cfg:tgt:back') return handleTargetBack(ctx, group);

  const tpickMatch = data.match(/^cfg:tpick:(.+)$/);
  if (tpickMatch) return handleTaskPick(ctx, tpickMatch[1]);

  const modMatch = data.match(/^cfg:mod:(grp|t:[^:]+):(.+)$/);
  if (modMatch) {
    return handleModelPick(ctx, group, chatJid, modMatch[1], modMatch[2]);
  }

  const effMatch = data.match(/^cfg:eff:(grp|t:[^:]+):(.+)$/);
  if (effMatch) {
    return handleEffortPick(ctx, group, chatJid, effMatch[1], effMatch[2]);
  }

  const tbMatch = data.match(/^cfg:tb:(grp|t:[^:]+):(.+)$/);
  if (tbMatch) {
    return handleThinkingBudgetPick(
      ctx,
      group,
      chatJid,
      tbMatch[1],
      tbMatch[2],
    );
  }

  ctx.answerCallbackQuery();
}
