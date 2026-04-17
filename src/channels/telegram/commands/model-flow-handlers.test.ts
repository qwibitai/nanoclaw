import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODEL } from '../../../config.js';
import {
  _initTestDatabase,
  createTask,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from '../../../db.js';
import type { RegisteredGroup } from '../../../types.js';

import {
  handleEffortPick,
  handleModelPick,
  handleTargetBack,
  handleTargetGrp,
  handleTargetTask,
  handleTaskPick,
  handleThinkingBudgetPick,
} from './model-flow-handlers.js';

type Ctx = {
  editMessageText: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
};

function fakeCtx(): Ctx {
  return {
    editMessageText: vi.fn(),
    answerCallbackQuery: vi.fn(),
  };
}

function baseGroup(): RegisteredGroup {
  return {
    name: 'G',
    folder: 'folder-a',
    trigger: '@Andy',
    added_at: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  _initTestDatabase();
  setRegisteredGroup('chat@g.us', baseGroup());
});

describe('handleTargetGrp', () => {
  it('renders the group model keyboard with the current model', () => {
    const ctx = fakeCtx();
    const g = { ...baseGroup(), model: 'claude-opus-4-20250514' };
    handleTargetGrp(ctx as never, g);
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const [text, opts] = ctx.editMessageText.mock.calls[0];
    expect(text).toContain('claude-opus-4-20250514');
    expect(opts.parse_mode).toBe('Markdown');
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('falls back to DEFAULT_MODEL when group.model is unset', () => {
    const ctx = fakeCtx();
    handleTargetGrp(ctx as never, baseGroup());
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toContain(DEFAULT_MODEL);
  });
});

describe('handleTargetTask', () => {
  it('shows "No tasks" when the group has none', () => {
    const ctx = fakeCtx();
    handleTargetTask(ctx as never, baseGroup());
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toBe('No tasks for this group.');
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('renders the task picker when tasks exist', () => {
    createTask({
      id: 'tA',
      group_folder: 'folder-a',
      chat_jid: 'chat@g.us',
      prompt: 'p',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00',
      context_mode: 'isolated',
      next_run: '2026-12-31T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const ctx = fakeCtx();
    handleTargetTask(ctx as never, baseGroup());
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toBe('Select a task:');
  });
});

describe('handleTargetBack', () => {
  it('shows the target keyboard with the current model', () => {
    const ctx = fakeCtx();
    const g = { ...baseGroup(), model: 'claude-sonnet-4-20250514' };
    handleTargetBack(ctx as never, g);
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toContain('claude-sonnet-4-20250514');
  });
});

describe('handleTaskPick', () => {
  it('answers with "Task not found" when the id is unknown', () => {
    const ctx = fakeCtx();
    handleTaskPick(ctx as never, 'missing');
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Task not found.');
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it('renders the model keyboard for an existing task', () => {
    createTask({
      id: 'tX',
      group_folder: 'folder-a',
      chat_jid: 'chat@g.us',
      prompt: 'p',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00',
      context_mode: 'isolated',
      model: 'claude-opus-4-20250514',
      next_run: '2026-12-31T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const ctx = fakeCtx();
    handleTaskPick(ctx as never, 'tX');
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toContain('tX');
    expect(text).toContain('claude-opus-4-20250514');
  });
});

describe('handleModelPick (target=grp)', () => {
  it('reset clears model and persists null', () => {
    const g = { ...baseGroup(), model: 'claude-opus-4-20250514' };
    const ctx = fakeCtx();
    handleModelPick(ctx as never, g, 'chat@g.us', 'grp', 'reset');
    expect(g.model).toBeUndefined();
    expect(getRegisteredGroup('chat@g.us')?.model).toBeUndefined();
    expect(g.pendingModelNotice).toContain('switched');
  });

  it('reset does NOT set a notice when previous already equals DEFAULT_MODEL', () => {
    const g = { ...baseGroup(), model: DEFAULT_MODEL };
    const ctx = fakeCtx();
    handleModelPick(ctx as never, g, 'chat@g.us', 'grp', 'reset');
    expect(g.pendingModelNotice).toBeUndefined();
  });

  it('non-reset resolves alias, writes DB, and sets switched notice', () => {
    const g = { ...baseGroup() };
    const ctx = fakeCtx();
    handleModelPick(ctx as never, g, 'chat@g.us', 'grp', 'opus');
    expect(g.model).toBeTruthy();
    expect(g.pendingModelNotice).toContain('switched');
    expect(getRegisteredGroup('chat@g.us')?.model).toBe(g.model);
  });
});

describe('handleModelPick (target=t:<id>)', () => {
  beforeEach(() => {
    createTask({
      id: 'tQ',
      group_folder: 'folder-a',
      chat_jid: 'chat@g.us',
      prompt: 'p',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00',
      context_mode: 'isolated',
      model: 'claude-opus-4-20250514',
      next_run: '2026-12-31T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reset clears the task model', () => {
    const ctx = fakeCtx();
    handleModelPick(ctx as never, baseGroup(), 'chat@g.us', 't:tQ', 'reset');
    expect(getTaskById('tQ')?.model).toBeNull();
  });

  it('non-reset writes a resolved alias to the task', () => {
    const ctx = fakeCtx();
    handleModelPick(ctx as never, baseGroup(), 'chat@g.us', 't:tQ', 'sonnet');
    expect(getTaskById('tQ')?.model).toBeTruthy();
    expect(getTaskById('tQ')?.model).not.toBe('claude-opus-4-20250514');
  });
});

describe('handleEffortPick', () => {
  beforeEach(() => {
    createTask({
      id: 'tE',
      group_folder: 'folder-a',
      chat_jid: 'chat@g.us',
      prompt: 'p',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00',
      context_mode: 'isolated',
      next_run: '2026-12-31T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('back + grp returns to the group model keyboard', () => {
    const ctx = fakeCtx();
    handleEffortPick(ctx as never, baseGroup(), 'chat@g.us', 'grp', 'back');
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toMatch(/Group model/);
  });

  it('back + task returns to the task model keyboard', () => {
    const ctx = fakeCtx();
    handleEffortPick(ctx as never, baseGroup(), 'chat@g.us', 't:tE', 'back');
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toMatch(/tE/);
  });

  it('grp reset clears effort', () => {
    const g = { ...baseGroup(), effort: 'high' };
    const ctx = fakeCtx();
    handleEffortPick(ctx as never, g, 'chat@g.us', 'grp', 'reset');
    expect(g.effort).toBeUndefined();
    expect(getRegisteredGroup('chat@g.us')?.effort).toBeUndefined();
  });

  it('grp level sets effort and persists', () => {
    const g = baseGroup();
    const ctx = fakeCtx();
    handleEffortPick(ctx as never, g, 'chat@g.us', 'grp', 'high');
    expect(g.effort).toBe('high');
    expect(getRegisteredGroup('chat@g.us')?.effort).toBe('high');
  });

  it('task reset clears effort', () => {
    const ctx = fakeCtx();
    handleEffortPick(ctx as never, baseGroup(), 'chat@g.us', 't:tE', 'reset');
    expect(getTaskById('tE')?.effort).toBeNull();
  });

  it('task level persists effort', () => {
    const ctx = fakeCtx();
    handleEffortPick(ctx as never, baseGroup(), 'chat@g.us', 't:tE', 'medium');
    expect(getTaskById('tE')?.effort).toBe('medium');
  });
});

describe('handleThinkingBudgetPick', () => {
  beforeEach(() => {
    createTask({
      id: 'tB',
      group_folder: 'folder-a',
      chat_jid: 'chat@g.us',
      prompt: 'p',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00',
      context_mode: 'isolated',
      next_run: '2026-12-31T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('back + grp returns to the effort keyboard', () => {
    const ctx = fakeCtx();
    handleThinkingBudgetPick(
      ctx as never,
      baseGroup(),
      'chat@g.us',
      'grp',
      'back',
    );
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toMatch(/Effort/);
  });

  it('back + task returns to the task effort keyboard', () => {
    const ctx = fakeCtx();
    handleThinkingBudgetPick(
      ctx as never,
      baseGroup(),
      'chat@g.us',
      't:tB',
      'back',
    );
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toMatch(/tB/);
  });

  it('grp sets thinking_budget and ends the flow', () => {
    const g = baseGroup();
    const ctx = fakeCtx();
    handleThinkingBudgetPick(ctx as never, g, 'chat@g.us', 'grp', 'adaptive');
    expect(g.thinking_budget).toBe('adaptive');
    expect(getRegisteredGroup('chat@g.us')?.thinking_budget).toBe('adaptive');
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toBe('Configuration complete.');
  });

  it('task sets thinking_budget and ends the flow', () => {
    const ctx = fakeCtx();
    handleThinkingBudgetPick(
      ctx as never,
      baseGroup(),
      'chat@g.us',
      't:tB',
      'high',
    );
    expect(getTaskById('tB')?.thinking_budget).toBe('high');
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toContain('tB');
  });
});
