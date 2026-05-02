import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mock child_process.execFile so we never actually call mongosh
// ---------------------------------------------------------------------------

const execFileMock: Mock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  addComment,
  validateObjectId,
  validatePriority,
  type Task,
} from './mongodb-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate a successful mongosh invocation returning `stdout`. */
function mockMongoshSuccess(stdout: string) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, stdout, '');
    },
  );
}

/** Simulate a failed mongosh invocation. */
function mockMongoshFailure(message: string) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(new Error(message), '', 'some stderr');
    },
  );
}

/** Create a fake EJSON-style task document as mongosh would emit it. */
function ejsonTask(overrides: Partial<Record<string, unknown>> = {}): string {
  const base = {
    _id: { $oid: 'aabbccddee1122334455ff00' },
    bot: 'db',
    title: 'Run migration',
    description: 'Execute v2.3 migration',
    priority: 2,
    status: 'assigned',
    created_at: { $date: '2026-03-27T00:00:00.000Z' },
    updated_at: { $date: '2026-03-27T00:00:00.000Z' },
    deadline: { $date: '2026-04-01T00:00:00.000Z' },
    assigned_via: 'notice',
    notice_id: '',
    depends_on: [],
    outcome: '',
    lessons: '',
    ...overrides,
  };
  return JSON.stringify(base);
}

function ejsonComment(overrides: Partial<Record<string, unknown>> = {}): string {
  const base = {
    _id: { $oid: 'ccccddddeeee111122223333' },
    task_id: 'aabbccddee1122334455ff00',
    author: 'relay',
    body: 'Work started',
    created_at: { $date: '2026-03-27T01:00:00.000Z' },
    ...overrides,
  };
  return JSON.stringify(base);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MONGODB_URI = 'mongodb+srv://test:test@cluster.example.com/relay';
});

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

describe('createTask', () => {
  it('inserts a task and returns the parsed document', async () => {
    mockMongoshSuccess(ejsonTask());

    const task = await createTask({
      bot: 'db',
      title: 'Run migration',
      description: 'Execute v2.3 migration',
      priority: 2,
      deadline: '2026-04-01T00:00:00.000Z',
    });

    expect(task._id).toBe('aabbccddee1122334455ff00');
    expect(task.bot).toBe('db');
    expect(task.title).toBe('Run migration');
    expect(task.status).toBe('assigned');
    expect(task.priority).toBe(2);

    // Verify mongosh was called with the URI
    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('mongosh');
    expect(args[0]).toBe('mongodb+srv://test:test@cluster.example.com/relay');
    expect(args[1]).toBe('--quiet');
    expect(args[2]).toBe('--eval');
  });

  it('uses default values when optional fields are omitted', async () => {
    mockMongoshSuccess(ejsonTask({ priority: 3, deadline: null }));

    const task = await createTask({ bot: 'nook', title: 'Quick task' });

    expect(task.priority).toBe(3);

    // The eval expression should contain priority: 3 (the default)
    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain("priority: 3");
    expect(evalArg).toContain("status: 'assigned'");
  });

  it('throws when MONGODB_URI is not set', async () => {
    delete process.env.MONGODB_URI;
    await expect(createTask({ bot: 'x', title: 'Fail' })).rejects.toThrow(
      'MONGODB_URI not configured',
    );
  });

  it('throws when mongosh fails', async () => {
    mockMongoshFailure('connection refused');
    await expect(createTask({ bot: 'x', title: 'Fail' })).rejects.toThrow(
      'mongosh error',
    );
  });

  it('rejects invalid priority', async () => {
    await expect(createTask({ bot: 'x', title: 'Bad priority', priority: 0 })).rejects.toThrow(
      'Invalid priority',
    );
    await expect(createTask({ bot: 'x', title: 'Bad priority', priority: 6 })).rejects.toThrow(
      'Invalid priority',
    );
  });

  it('passes depends_on array into the eval expression', async () => {
    mockMongoshSuccess(ejsonTask({ depends_on: ['dep1', 'dep2'] }));

    await createTask({
      bot: 'db',
      title: 'Depends task',
      depends_on: ['dep1', 'dep2'],
    });

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain("'dep1'");
    expect(evalArg).toContain("'dep2'");
  });
});

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

describe('getTask', () => {
  it('returns a task by ID', async () => {
    mockMongoshSuccess(ejsonTask());

    const task = await getTask('aabbccddee1122334455ff00');
    expect(task).not.toBeNull();
    expect(task!._id).toBe('aabbccddee1122334455ff00');
    expect(task!.bot).toBe('db');
  });

  it('returns null when task is not found', async () => {
    mockMongoshSuccess('null');

    const task = await getTask('000000000000000000000000');
    expect(task).toBeNull();
  });

  it('rejects invalid ObjectId', async () => {
    await expect(getTask('not-an-objectid')).rejects.toThrow('Invalid ObjectId');
    await expect(getTask("'; db.drop();//")).rejects.toThrow('Invalid ObjectId');
  });
});

// ---------------------------------------------------------------------------
// listTasks
// ---------------------------------------------------------------------------

describe('listTasks', () => {
  it('returns all tasks when no filter is given', async () => {
    const docs = [
      JSON.parse(ejsonTask()),
      JSON.parse(ejsonTask({ _id: { $oid: '112233445566778899aabb00' }, bot: 'nook', title: 'Second' })),
    ];
    mockMongoshSuccess(JSON.stringify(docs));

    const tasks = await listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].bot).toBe('db');
    expect(tasks[1].bot).toBe('nook');
  });

  it('filters by single status', async () => {
    mockMongoshSuccess(JSON.stringify([JSON.parse(ejsonTask())]));

    await listTasks({ status: 'assigned' });

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain("status: 'assigned'");
  });

  it('filters by multiple statuses', async () => {
    mockMongoshSuccess(JSON.stringify([JSON.parse(ejsonTask())]));

    await listTasks({ status: ['assigned', 'in_progress'] });

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain("$in");
    expect(evalArg).toContain("'assigned'");
    expect(evalArg).toContain("'in_progress'");
  });

  it('filters by bot', async () => {
    mockMongoshSuccess(JSON.stringify([JSON.parse(ejsonTask())]));

    await listTasks({ bot: 'db' });

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain("bot: 'db'");
  });

  it('filters by assignee (alias for bot)', async () => {
    mockMongoshSuccess(JSON.stringify([JSON.parse(ejsonTask())]));

    await listTasks({ assignee: 'nook' });

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain("bot: 'nook'");
  });

  it('combines bot and status filters', async () => {
    mockMongoshSuccess(JSON.stringify([JSON.parse(ejsonTask())]));

    await listTasks({ bot: 'db', status: 'completed' });

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain("bot: 'db'");
    expect(evalArg).toContain("status: 'completed'");
  });

  it('returns empty array when no tasks match', async () => {
    mockMongoshSuccess('[]');

    const tasks = await listTasks({ bot: 'nonexistent' });
    expect(tasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateTask
// ---------------------------------------------------------------------------

describe('updateTask', () => {
  it('updates status and returns the updated task', async () => {
    mockMongoshSuccess(ejsonTask({ status: 'in_progress' }));

    const task = await updateTask('aabbccddee1122334455ff00', {
      status: 'in_progress',
    });

    expect(task).not.toBeNull();
    expect(task!.status).toBe('in_progress');

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain("status: 'in_progress'");
    expect(evalArg).toContain('updated_at: new Date()');
  });

  it('updates outcome and lessons on completion', async () => {
    mockMongoshSuccess(
      ejsonTask({
        status: 'completed',
        outcome: 'Migration done',
        lessons: 'Always backup first',
      }),
    );

    const task = await updateTask('aabbccddee1122334455ff00', {
      status: 'completed',
      outcome: 'Migration done',
      lessons: 'Always backup first',
    });

    expect(task!.status).toBe('completed');
    expect(task!.outcome).toBe('Migration done');
    expect(task!.lessons).toBe('Always backup first');
  });

  it('returns null when task does not exist', async () => {
    mockMongoshSuccess('null');

    const task = await updateTask('000000000000000000000000', {
      status: 'completed',
    });
    expect(task).toBeNull();
  });

  it('updates notice_id', async () => {
    mockMongoshSuccess(ejsonTask({ notice_id: 'n-abc-123' }));

    await updateTask('aabbccddee1122334455ff00', { notice_id: 'n-abc-123' });

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain("notice_id: 'n-abc-123'");
  });

  it('updates priority', async () => {
    mockMongoshSuccess(ejsonTask({ priority: 1 }));

    await updateTask('aabbccddee1122334455ff00', { priority: 1 });

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain('priority: 1');
  });
});

// ---------------------------------------------------------------------------
// addComment
// ---------------------------------------------------------------------------

describe('addComment', () => {
  it('inserts a comment and returns the parsed document', async () => {
    mockMongoshSuccess(ejsonComment());

    const comment = await addComment(
      'aabbccddee1122334455ff00',
      'relay',
      'Work started',
    );

    expect(comment._id).toBe('ccccddddeeee111122223333');
    expect(comment.task_id).toBe('aabbccddee1122334455ff00');
    expect(comment.author).toBe('relay');
    expect(comment.body).toBe('Work started');

    const evalArg = execFileMock.mock.calls[0][1][3] as string;
    expect(evalArg).toContain('task_comments');
  });

  it('throws when mongosh fails', async () => {
    mockMongoshFailure('auth failed');
    await expect(
      addComment('aabbccddee1122334455ff00', 'relay', 'test'),
    ).rejects.toThrow('mongosh error');
  });
});

// ---------------------------------------------------------------------------
// Task lifecycle transitions
// ---------------------------------------------------------------------------

describe('Task lifecycle transitions', () => {
  it('assigned -> in_progress', async () => {
    mockMongoshSuccess(ejsonTask({ status: 'in_progress' }));

    const task = await updateTask('aabbccddee1122334455ff00', {
      status: 'in_progress',
    });
    expect(task!.status).toBe('in_progress');
  });

  it('in_progress -> completed with outcome and lessons', async () => {
    mockMongoshSuccess(
      ejsonTask({
        status: 'completed',
        outcome: 'Done successfully',
        lessons: 'Use docker compose up -d',
      }),
    );

    const task = await updateTask('aabbccddee1122334455ff00', {
      status: 'completed',
      outcome: 'Done successfully',
      lessons: 'Use docker compose up -d',
    });
    expect(task!.status).toBe('completed');
    expect(task!.outcome).toBe('Done successfully');
    expect(task!.lessons).toBe('Use docker compose up -d');
  });

  it('assigned -> blocked', async () => {
    mockMongoshSuccess(ejsonTask({ status: 'blocked' }));

    const task = await updateTask('aabbccddee1122334455ff00', {
      status: 'blocked',
    });
    expect(task!.status).toBe('blocked');
  });

  it('in_progress -> escalated', async () => {
    mockMongoshSuccess(ejsonTask({ status: 'escalated' }));

    const task = await updateTask('aabbccddee1122334455ff00', {
      status: 'escalated',
    });
    expect(task!.status).toBe('escalated');
  });

  it('in_progress -> failed', async () => {
    mockMongoshSuccess(
      ejsonTask({
        status: 'failed',
        outcome: 'Migration threw FK violation',
      }),
    );

    const task = await updateTask('aabbccddee1122334455ff00', {
      status: 'failed',
      outcome: 'Migration threw FK violation',
    });
    expect(task!.status).toBe('failed');
    expect(task!.outcome).toBe('Migration threw FK violation');
  });

  it('blocked -> assigned (unblocked)', async () => {
    mockMongoshSuccess(ejsonTask({ status: 'assigned' }));

    const task = await updateTask('aabbccddee1122334455ff00', {
      status: 'assigned',
    });
    expect(task!.status).toBe('assigned');
  });

  it('rejects invalid ObjectId in updateTask', async () => {
    await expect(
      updateTask("'; db.dropDatabase();//", { status: 'completed' }),
    ).rejects.toThrow('Invalid ObjectId');
  });

  it('rejects invalid priority in updateTask', async () => {
    await expect(
      updateTask('aabbccddee1122334455ff00', { priority: 0 }),
    ).rejects.toThrow('Invalid priority');

    await expect(
      updateTask('aabbccddee1122334455ff00', { priority: 6 }),
    ).rejects.toThrow('Invalid priority');
  });

  it('full lifecycle: create -> in_progress -> completed', async () => {
    // Step 1: Create
    mockMongoshSuccess(ejsonTask({ status: 'assigned' }));
    const created = await createTask({ bot: 'db', title: 'Full lifecycle test' });
    expect(created.status).toBe('assigned');

    // Step 2: Start
    mockMongoshSuccess(ejsonTask({ status: 'in_progress' }));
    const started = await updateTask(created._id, { status: 'in_progress' });
    expect(started!.status).toBe('in_progress');

    // Step 3: Complete
    mockMongoshSuccess(
      ejsonTask({
        status: 'completed',
        outcome: 'All good',
        lessons: 'Learned something',
      }),
    );
    const completed = await updateTask(created._id, {
      status: 'completed',
      outcome: 'All good',
      lessons: 'Learned something',
    });
    expect(completed!.status).toBe('completed');
    expect(completed!.outcome).toBe('All good');
    expect(completed!.lessons).toBe('Learned something');
  });
});

// ---------------------------------------------------------------------------
// validateObjectId
// ---------------------------------------------------------------------------

describe('validateObjectId', () => {
  it('accepts a valid 24-char hex string', () => {
    expect(validateObjectId('aabbccddee1122334455ff00')).toBe('aabbccddee1122334455ff00');
  });

  it('rejects strings that are not 24-char hex', () => {
    expect(() => validateObjectId('not-an-objectid')).toThrow('Invalid ObjectId');
    expect(() => validateObjectId('short')).toThrow('Invalid ObjectId');
    expect(() => validateObjectId('')).toThrow('Invalid ObjectId');
  });

  it('rejects injection attempts', () => {
    expect(() => validateObjectId("'; db.drop();//")).toThrow('Invalid ObjectId');
    expect(() => validateObjectId("aabbccddee1122334455ff0' + ''")).toThrow('Invalid ObjectId');
  });
});

// ---------------------------------------------------------------------------
// validatePriority
// ---------------------------------------------------------------------------

describe('validatePriority', () => {
  it('accepts priorities 1 through 5', () => {
    for (let i = 1; i <= 5; i++) {
      expect(validatePriority(i)).toBe(i);
    }
  });

  it('rejects 0', () => {
    expect(() => validatePriority(0)).toThrow('Invalid priority');
  });

  it('rejects 6', () => {
    expect(() => validatePriority(6)).toThrow('Invalid priority');
  });

  it('rejects NaN', () => {
    expect(() => validatePriority(NaN)).toThrow('Invalid priority');
  });

  it('rejects Infinity', () => {
    expect(() => validatePriority(Infinity)).toThrow('Invalid priority');
    expect(() => validatePriority(-Infinity)).toThrow('Invalid priority');
  });

  it('rejects negative numbers', () => {
    expect(() => validatePriority(-1)).toThrow('Invalid priority');
  });
});
