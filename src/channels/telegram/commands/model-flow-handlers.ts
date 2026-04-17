import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';

import { DEFAULT_MODEL, resolveModelAlias } from '../../../config.js';
import {
  getTaskById,
  getTasksForGroup,
  setGroupEffort,
  setGroupModel,
  setGroupThinkingBudget,
  updateTask,
} from '../../../db.js';
import type { RegisteredGroup } from '../../../types.js';
import {
  buildEffortKeyboard,
  buildModelKeyboard,
  buildTargetKeyboard,
  buildTaskPicker,
  buildThinkingBudgetKeyboard,
} from '../keyboards.js';

export function handleTargetGrp(ctx: Context, group: RegisteredGroup): void {
  const current = group.model || DEFAULT_MODEL;
  ctx.editMessageText(`Group model (current: \`${current}\`)`, {
    parse_mode: 'Markdown',
    reply_markup: buildModelKeyboard(group.model, 'grp'),
  });
  ctx.answerCallbackQuery();
}

export function handleTargetTask(ctx: Context, group: RegisteredGroup): void {
  const tasks = getTasksForGroup(group.folder);
  if (tasks.length === 0) {
    ctx.editMessageText('No tasks for this group.', {
      reply_markup: new InlineKeyboard().text('Back', 'cfg:tgt:back'),
    });
    ctx.answerCallbackQuery();
    return;
  }
  ctx.editMessageText('Select a task:', {
    reply_markup: buildTaskPicker(tasks),
  });
  ctx.answerCallbackQuery();
}

export function handleTargetBack(ctx: Context, group: RegisteredGroup): void {
  const current = group.model || DEFAULT_MODEL;
  ctx.editMessageText(`Model: \`${current}\`\nSelect target:`, {
    parse_mode: 'Markdown',
    reply_markup: buildTargetKeyboard(),
  });
  ctx.answerCallbackQuery();
}

export function handleTaskPick(ctx: Context, taskId: string): void {
  const task = getTaskById(taskId);
  if (!task) {
    ctx.answerCallbackQuery('Task not found.');
    return;
  }
  const current = task.model || '(default)';
  const target = `t:${taskId}`;
  ctx.editMessageText(
    `Task \`${taskId}\` model (current: \`${current}\`)`,
    {
      parse_mode: 'Markdown',
      reply_markup: buildModelKeyboard(task.model || undefined, target),
    },
  );
  ctx.answerCallbackQuery();
}

export function handleModelPick(
  ctx: Context,
  group: RegisteredGroup,
  chatJid: string,
  target: string,
  value: string,
): void {
  if (target === 'grp') {
    if (value === 'reset') {
      const previous = group.model || DEFAULT_MODEL;
      setGroupModel(chatJid, null);
      group.model = undefined;
      group.agentModelOverride = undefined;
      group.agentModelOverrideSetAt = undefined;
      if (previous !== DEFAULT_MODEL) {
        group.pendingModelNotice = `[model has switched from ${previous} to ${DEFAULT_MODEL}]`;
      }
    } else {
      const resolved = resolveModelAlias(value);
      const previous = group.model || DEFAULT_MODEL;
      setGroupModel(chatJid, resolved);
      group.model = resolved;
      group.agentModelOverride = undefined;
      group.agentModelOverrideSetAt = undefined;
      if (previous !== resolved) {
        group.pendingModelNotice = `[model has switched from ${previous} to ${resolved}]`;
      }
    }
    const currentEffort = group.effort || 'default';
    ctx.editMessageText(
      `Model updated. Effort (current: \`${currentEffort}\`):`,
      {
        parse_mode: 'Markdown',
        reply_markup: buildEffortKeyboard(group.effort, 'grp'),
      },
    );
  } else {
    const taskId = target.slice(2);
    if (value === 'reset') {
      updateTask(taskId, { model: null });
    } else {
      updateTask(taskId, { model: resolveModelAlias(value) });
    }
    const task = getTaskById(taskId);
    const currentEffort = task?.effort || 'default';
    ctx.editMessageText(
      `Task model updated. Effort (current: \`${currentEffort}\`):`,
      {
        parse_mode: 'Markdown',
        reply_markup: buildEffortKeyboard(task?.effort || undefined, target),
      },
    );
  }
  ctx.answerCallbackQuery();
}

export function handleEffortPick(
  ctx: Context,
  group: RegisteredGroup,
  chatJid: string,
  target: string,
  value: string,
): void {
  if (value === 'back') {
    if (target === 'grp') {
      ctx.editMessageText(
        `Group model (current: \`${group.model || DEFAULT_MODEL}\`)`,
        {
          parse_mode: 'Markdown',
          reply_markup: buildModelKeyboard(group.model, 'grp'),
        },
      );
    } else {
      const taskId = target.slice(2);
      const task = getTaskById(taskId);
      ctx.editMessageText(
        `Task \`${taskId}\` model (current: \`${task?.model || '(default)'}\`)`,
        {
          parse_mode: 'Markdown',
          reply_markup: buildModelKeyboard(task?.model || undefined, target),
        },
      );
    }
    ctx.answerCallbackQuery();
    return;
  }

  if (target === 'grp') {
    if (value === 'reset') {
      setGroupEffort(chatJid, null);
      group.effort = undefined;
    } else {
      setGroupEffort(chatJid, value);
      group.effort = value;
    }
    const currentTb = group.thinking_budget || 'default';
    ctx.editMessageText(
      `Effort updated. Thinking budget (current: \`${currentTb}\`):`,
      {
        parse_mode: 'Markdown',
        reply_markup: buildThinkingBudgetKeyboard(group.thinking_budget, 'grp'),
      },
    );
  } else {
    const taskId = target.slice(2);
    if (value === 'reset') {
      updateTask(taskId, { effort: null });
    } else {
      updateTask(taskId, { effort: value });
    }
    const task = getTaskById(taskId);
    const currentTb = task?.thinking_budget || 'default';
    ctx.editMessageText(
      `Effort updated. Thinking budget (current: \`${currentTb}\`):`,
      {
        parse_mode: 'Markdown',
        reply_markup: buildThinkingBudgetKeyboard(
          task?.thinking_budget || undefined,
          target,
        ),
      },
    );
  }
  ctx.answerCallbackQuery();
}

export function handleThinkingBudgetPick(
  ctx: Context,
  group: RegisteredGroup,
  chatJid: string,
  target: string,
  value: string,
): void {
  if (value === 'back') {
    if (target === 'grp') {
      ctx.editMessageText(
        `Effort (current: \`${group.effort || 'default'}\`):`,
        {
          parse_mode: 'Markdown',
          reply_markup: buildEffortKeyboard(group.effort, 'grp'),
        },
      );
    } else {
      const taskId = target.slice(2);
      const task = getTaskById(taskId);
      ctx.editMessageText(
        `Task \`${taskId}\` effort (current: \`${task?.effort || 'default'}\`):`,
        {
          parse_mode: 'Markdown',
          reply_markup: buildEffortKeyboard(task?.effort || undefined, target),
        },
      );
    }
    ctx.answerCallbackQuery();
    return;
  }

  if (target === 'grp') {
    setGroupThinkingBudget(chatJid, value);
    group.thinking_budget = value;
    ctx.editMessageText('Configuration complete.', {
      parse_mode: 'Markdown',
    });
  } else {
    const taskId = target.slice(2);
    updateTask(taskId, { thinking_budget: value });
    ctx.editMessageText(`Task \`${taskId}\` configuration complete.`, {
      parse_mode: 'Markdown',
    });
  }
  ctx.answerCallbackQuery();
}
