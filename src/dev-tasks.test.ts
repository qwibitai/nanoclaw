import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetDispatchState,
  _setRepoDir,
  _setTasksDir,
  allocateId,
  cancelSession,
  createTask,
  deleteTask,
  dispatchTask,
  getActiveSessions,
  listTasks,
  parseTaskFile,
  readTask,
  readTaskBody,
  serializeTask,
  slugify,
  taskBranchName,
  transitionStatus,
  updateTask,
} from './dev-tasks.js';

describe('dev-tasks', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'dev-tasks-test-'));
    fs.writeFileSync(
      path.join(testDir, 'counter.json'),
      JSON.stringify({ next_id: 1 }),
    );
    _setTasksDir(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // --- ID allocation ---

  describe('allocateId', () => {
    it('returns 1 for fresh counter and increments', () => {
      expect(allocateId()).toBe(1);
      expect(allocateId()).toBe(2);
      expect(allocateId()).toBe(3);

      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, 'counter.json'), 'utf-8'),
      );
      expect(data.next_id).toBe(4);
    });

    it('works with non-1 starting counter', () => {
      fs.writeFileSync(
        path.join(testDir, 'counter.json'),
        JSON.stringify({ next_id: 42 }),
      );
      expect(allocateId()).toBe(42);
      expect(allocateId()).toBe(43);
    });

    it('skips IDs that already have task files on disk', () => {
      // Simulate counter drift: counter says 1, but files 1.md and 2.md exist
      fs.writeFileSync(path.join(testDir, '1.md'), '---\nid: 1\n---\n');
      fs.writeFileSync(path.join(testDir, '2.md'), '---\nid: 2\n---\n');

      const id = allocateId();
      expect(id).toBe(3);

      // Counter should be updated past the collision
      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, 'counter.json'), 'utf-8'),
      );
      expect(data.next_id).toBe(4);
    });
  });

  // --- Status transitions ---

  describe('transitionStatus', () => {
    it('allows open → working', () => {
      expect(() => transitionStatus('open', 'working')).not.toThrow();
    });

    it('allows open → done', () => {
      expect(() => transitionStatus('open', 'done')).not.toThrow();
    });

    it('allows working → pr_ready', () => {
      expect(() => transitionStatus('working', 'pr_ready')).not.toThrow();
    });

    it('allows working → needs_session', () => {
      expect(() => transitionStatus('working', 'needs_session')).not.toThrow();
    });

    it('allows working → open (reset)', () => {
      expect(() => transitionStatus('working', 'open')).not.toThrow();
    });

    it('allows pr_ready → done', () => {
      expect(() => transitionStatus('pr_ready', 'done')).not.toThrow();
    });

    it('allows needs_session → working', () => {
      expect(() => transitionStatus('needs_session', 'working')).not.toThrow();
    });

    it('allows done → open (reopen)', () => {
      expect(() => transitionStatus('done', 'open')).not.toThrow();
    });

    it('rejects open → pr_ready', () => {
      expect(() => transitionStatus('open', 'pr_ready')).toThrow(
        'Invalid status transition',
      );
    });

    it('rejects done → working', () => {
      expect(() => transitionStatus('done', 'working')).toThrow(
        'Invalid status transition',
      );
    });

    it('rejects open → needs_session', () => {
      expect(() => transitionStatus('open', 'needs_session')).toThrow(
        'Invalid status transition',
      );
    });

    // has_followups transitions
    it('allows done → has_followups', () => {
      expect(() => transitionStatus('done', 'has_followups')).not.toThrow();
    });

    it('allows has_followups → done', () => {
      expect(() => transitionStatus('has_followups', 'done')).not.toThrow();
    });

    it('allows has_followups → open', () => {
      expect(() => transitionStatus('has_followups', 'open')).not.toThrow();
    });

    it('rejects has_followups → working', () => {
      expect(() => transitionStatus('has_followups', 'working')).toThrow(
        'Invalid status transition',
      );
    });

    it('rejects open → has_followups', () => {
      expect(() => transitionStatus('open', 'has_followups')).toThrow(
        'Invalid status transition',
      );
    });
  });

  // --- Frontmatter parsing ---

  describe('parseTaskFile / serializeTask', () => {
    it('round-trips a task through serialize and parse', () => {
      const task = {
        id: 1,
        title: 'Fix the login bug',
        description: 'The login page throws a 500 on submit',
        status: 'open' as const,
        created_at: '2026-03-27T10:00:00.000Z',
        updated_at: '2026-03-27T10:00:00.000Z',
        source: 'fambot' as const,
      };

      const md = serializeTask(task);
      const parsed = parseTaskFile(md);

      expect(parsed.id).toBe(1);
      expect(parsed.title).toBe('Fix the login bug');
      expect(parsed.description).toBe('The login page throws a 500 on submit');
      expect(parsed.status).toBe('open');
      expect(parsed.source).toBe('fambot');
    });

    it('handles optional fields', () => {
      const task = {
        id: 5,
        title: 'Deploy fix',
        description: '',
        status: 'pr_ready' as const,
        created_at: '2026-03-27T10:00:00.000Z',
        updated_at: '2026-03-27T12:00:00.000Z',
        source: 'chat' as const,
        pr_url: 'https://github.com/user/repo/pull/42',
        branch: 'pip/task-5-deploy-fix',
      };

      const md = serializeTask(task);
      const parsed = parseTaskFile(md);

      expect(parsed.pr_url).toBe('https://github.com/user/repo/pull/42');
      expect(parsed.branch).toBe('pip/task-5-deploy-fix');
    });

    it('preserves body content', () => {
      const task = {
        id: 1,
        title: 'Test task',
        description: '',
        status: 'needs_session' as const,
        created_at: '2026-03-27T10:00:00.000Z',
        updated_at: '2026-03-27T10:00:00.000Z',
        source: 'claude-code' as const,
      };

      const body = "## Pip's Brief\n\nThis task needs more context.";
      const md = serializeTask(task, body);

      expect(md).toContain("## Pip's Brief");
      // Parse should still work — body is ignored for frontmatter
      const parsed = parseTaskFile(md);
      expect(parsed.id).toBe(1);
    });

    it('throws on missing frontmatter', () => {
      expect(() => parseTaskFile('No frontmatter here')).toThrow(
        'Missing YAML frontmatter',
      );
    });

    it('throws on invalid frontmatter data', () => {
      const bad = '---\ntitle: Test\n---\n';
      expect(() => parseTaskFile(bad)).toThrow(); // missing required fields
    });

    it('parses has_followups status', () => {
      const task = {
        id: 12,
        title: 'FamBot macOS app',
        description: 'Port FamBot to macOS',
        status: 'has_followups' as const,
        created_at: '2026-03-27T10:00:00.000Z',
        updated_at: '2026-03-27T10:00:00.000Z',
        source: 'claude-code' as const,
        pr_url: 'https://github.com/user/repo/pull/7',
        branch: 'feat/task-12-fambot-macos-app',
      };

      const md = serializeTask(task);
      const parsed = parseTaskFile(md);
      expect(parsed.status).toBe('has_followups');
    });

    it('parses claude source', () => {
      const task = {
        id: 13,
        title: 'Add has_followups status',
        description: '',
        status: 'open' as const,
        created_at: '2026-03-27T10:00:00.000Z',
        updated_at: '2026-03-27T10:00:00.000Z',
        source: 'claude' as const,
      };

      const md = serializeTask(task);
      const parsed = parseTaskFile(md);
      expect(parsed.source).toBe('claude');
    });
  });

  // --- CRUD ---

  describe('createTask', () => {
    it('creates a task file with auto-assigned ID', () => {
      const task = createTask({
        title: 'Add dark mode',
        description: 'Support dark color scheme',
        source: 'fambot',
      });

      expect(task.id).toBe(1);
      expect(task.title).toBe('Add dark mode');
      expect(task.status).toBe('open');
      expect(task.source).toBe('fambot');
      expect(task.created_at).toBeTruthy();

      // Verify file exists on disk
      const file = path.join(testDir, '1.md');
      expect(fs.existsSync(file)).toBe(true);

      // Verify it can be read back
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).toContain('title: Add dark mode');
      expect(content).toContain('status: open');
    });

    it('assigns sequential IDs', () => {
      const t1 = createTask({ title: 'Task 1', source: 'fambot' });
      const t2 = createTask({ title: 'Task 2', source: 'chat' });
      const t3 = createTask({ title: 'Task 3', source: 'claude-code' });

      expect(t1.id).toBe(1);
      expect(t2.id).toBe(2);
      expect(t3.id).toBe(3);
    });

    it('defaults description to empty string', () => {
      const task = createTask({ title: 'No desc', source: 'fambot' });
      expect(task.description).toBe('');
    });
  });

  describe('readTask', () => {
    it('reads a task by ID', () => {
      createTask({ title: 'Read me', source: 'fambot' });

      const task = readTask(1);
      expect(task).not.toBeNull();
      expect(task!.title).toBe('Read me');
      expect(task!.id).toBe(1);
    });

    it('returns null for non-existent task', () => {
      expect(readTask(999)).toBeNull();
    });

    it('returns null for malformed file', () => {
      fs.writeFileSync(path.join(testDir, '99.md'), 'garbage content');
      expect(readTask(99)).toBeNull();
    });
  });

  describe('readTaskBody', () => {
    it('reads body content after frontmatter', () => {
      const task = createTask({ title: 'Body test', source: 'fambot' });

      // Manually append body
      const file = path.join(testDir, `${task.id}.md`);
      const content = fs.readFileSync(file, 'utf-8');
      fs.writeFileSync(
        file,
        content + "\n## Pip's Brief\n\nSome context here.\n",
      );

      const body = readTaskBody(task.id);
      expect(body).toContain("## Pip's Brief");
      expect(body).toContain('Some context here.');
    });

    it('returns empty string for task with no body', () => {
      createTask({ title: 'No body', source: 'fambot' });
      expect(readTaskBody(1)).toBe('');
    });

    it('returns null for non-existent task', () => {
      expect(readTaskBody(999)).toBeNull();
    });
  });

  describe('updateTask', () => {
    it('updates title', () => {
      createTask({ title: 'Old title', source: 'fambot' });

      const updated = updateTask(1, { title: 'New title' });
      expect(updated.title).toBe('New title');

      // Verify persisted
      const read = readTask(1);
      expect(read!.title).toBe('New title');
    });

    it('updates status with valid transition', () => {
      createTask({ title: 'Status test', source: 'fambot' });

      const updated = updateTask(1, { status: 'working' });
      expect(updated.status).toBe('working');
    });

    it('rejects invalid status transition', () => {
      createTask({ title: 'Bad transition', source: 'fambot' });

      expect(() => updateTask(1, { status: 'pr_ready' })).toThrow(
        'Invalid status transition',
      );
    });

    it('throws for non-existent task', () => {
      expect(() => updateTask(999, { title: 'Nope' })).toThrow(
        'Task 999 not found',
      );
    });

    it('updates updated_at timestamp', async () => {
      const task = createTask({ title: 'Timestamp test', source: 'fambot' });
      const original = task.updated_at;

      // Wait 2ms to ensure different timestamp
      await new Promise((r) => setTimeout(r, 2));
      const updated = updateTask(1, { title: 'Changed' });
      expect(updated.updated_at).not.toBe(original);
    });

    it('preserves body content on update', () => {
      const task = createTask({ title: 'Body preserve', source: 'fambot' });

      // Manually add body
      const file = path.join(testDir, `${task.id}.md`);
      const content = fs.readFileSync(file, 'utf-8');
      fs.writeFileSync(file, content + '\n## Notes\n\nKeep this.\n');

      updateTask(task.id, { title: 'Updated title' });

      const body = readTaskBody(task.id);
      expect(body).toContain('Keep this.');
    });

    it('sets pr_url and branch', () => {
      createTask({ title: 'PR test', source: 'fambot' });
      updateTask(1, { status: 'working' });

      const updated = updateTask(1, {
        status: 'pr_ready',
        pr_url: 'https://github.com/user/repo/pull/1',
        branch: 'pip/task-1-pr-test',
      });

      expect(updated.pr_url).toBe('https://github.com/user/repo/pull/1');
      expect(updated.branch).toBe('pip/task-1-pr-test');
    });
  });

  describe('listTasks', () => {
    it('lists all tasks sorted by ID', () => {
      createTask({ title: 'Third', source: 'fambot' });
      createTask({ title: 'First', source: 'chat' });
      createTask({ title: 'Second', source: 'claude-code' });

      const tasks = listTasks();
      expect(tasks).toHaveLength(3);
      expect(tasks[0].id).toBe(1);
      expect(tasks[1].id).toBe(2);
      expect(tasks[2].id).toBe(3);
    });

    it('filters by status', () => {
      createTask({ title: 'Open one', source: 'fambot' });
      createTask({ title: 'Open two', source: 'fambot' });
      const t3 = createTask({ title: 'Will be working', source: 'fambot' });
      updateTask(t3.id, { status: 'working' });

      const open = listTasks({ status: 'open' });
      expect(open).toHaveLength(2);

      const working = listTasks({ status: 'working' });
      expect(working).toHaveLength(1);
      expect(working[0].title).toBe('Will be working');
    });

    it('returns empty array for empty directory', () => {
      expect(listTasks()).toHaveLength(0);
    });

    it('skips malformed files gracefully', () => {
      createTask({ title: 'Good task', source: 'fambot' });
      fs.writeFileSync(path.join(testDir, '99.md'), 'not valid frontmatter');

      const tasks = listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('Good task');
    });

    it('ignores non-task files', () => {
      createTask({ title: 'Real task', source: 'fambot' });
      fs.writeFileSync(path.join(testDir, 'counter.json'), '{"next_id":2}');
      fs.writeFileSync(path.join(testDir, '.gitkeep'), '');
      fs.writeFileSync(path.join(testDir, 'notes.txt'), 'random file');

      const tasks = listTasks();
      expect(tasks).toHaveLength(1);
    });
  });

  describe('deleteTask', () => {
    it('deletes an existing task', () => {
      createTask({ title: 'Delete me', source: 'fambot' });
      expect(deleteTask(1)).toBe(true);
      expect(readTask(1)).toBeNull();
      expect(fs.existsSync(path.join(testDir, '1.md'))).toBe(false);
    });

    it('returns false for non-existent task', () => {
      expect(deleteTask(999)).toBe(false);
    });
  });
});

// --- Dispatch and worktree tests ---
// These use a real git repo in /tmp for worktree operations.

describe('dispatch and worktree', () => {
  let testDir: string;
  let gitRepoDir: string;

  beforeEach(() => {
    // Create a temp git repo for worktree operations
    gitRepoDir = fs.mkdtempSync(path.join('/tmp', 'dev-tasks-git-'));
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: gitRepoDir,
    });

    // Tasks dir inside the git repo
    testDir = path.join(gitRepoDir, 'tasks');
    fs.mkdirSync(testDir);
    fs.writeFileSync(
      path.join(testDir, 'counter.json'),
      JSON.stringify({ next_id: 1 }),
    );

    _setTasksDir(testDir);
    _setRepoDir(gitRepoDir);
    _resetDispatchState();
  });

  afterEach(() => {
    // Clean up any worktrees we created
    _resetDispatchState();

    // Remove worktrees before deleting the repo
    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: gitRepoDir,
        encoding: 'utf-8',
      });
      const paths = output
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.replace('worktree ', ''))
        .filter((p) => p !== gitRepoDir);
      for (const p of paths) {
        try {
          execSync(`git worktree remove --force "${p}"`, { cwd: gitRepoDir });
        } catch {
          fs.rmSync(p, { recursive: true, force: true });
        }
      }
    } catch {
      // ignore
    }

    fs.rmSync(gitRepoDir, { recursive: true, force: true });
  });

  describe('slugify', () => {
    it('converts title to branch-safe slug', () => {
      expect(slugify('Fix the login bug')).toBe('fix-the-login-bug');
    });

    it('handles special characters', () => {
      expect(slugify('Add @mentions & #tags!')).toBe('add-mentions-tags');
    });

    it('truncates to 40 chars', () => {
      const long = 'a'.repeat(60);
      expect(slugify(long).length).toBe(40);
    });
  });

  describe('taskBranchName', () => {
    it('builds correct branch name', () => {
      expect(taskBranchName(42, 'Fix login bug')).toBe(
        'pip/task-42-fix-login-bug',
      );
    });
  });

  describe('dispatchTask', () => {
    it('creates worktree and updates task status', () => {
      createTask({ title: 'Dispatch me', source: 'fambot' });

      const { task, session } = dispatchTask(1);

      expect(task.status).toBe('working');
      expect(task.branch).toBe('pip/task-1-dispatch-me');
      expect(session.taskId).toBe(1);
      expect(fs.existsSync(session.worktreePath)).toBe(true);

      // Verify worktree is a git checkout
      const branch = execSync('git branch --show-current', {
        cwd: session.worktreePath,
        encoding: 'utf-8',
      }).trim();
      expect(branch).toBe('pip/task-1-dispatch-me');
    });

    it('rejects non-open tasks', () => {
      createTask({ title: 'Not open', source: 'fambot' });
      updateTask(1, { status: 'working' });

      expect(() => dispatchTask(1)).toThrow("must be 'open' to dispatch");
    });

    it('rejects duplicate dispatch', () => {
      createTask({ title: 'Double dispatch', source: 'fambot' });
      dispatchTask(1);

      // Create another open task with same ID scenario
      createTask({ title: 'Another task', source: 'fambot' });
      dispatchTask(2);

      createTask({ title: 'Third task', source: 'fambot' });
      dispatchTask(3);

      createTask({ title: 'Fourth task', source: 'fambot' });
      expect(() => dispatchTask(4)).toThrow('Maximum concurrent sessions');
    });

    it('rejects when task is already working', () => {
      createTask({ title: 'Already running', source: 'fambot' });
      dispatchTask(1);

      // Task is now 'working', so dispatch rejects on status check
      expect(() => dispatchTask(1)).toThrow("must be 'open' to dispatch");
    });

    it('tracks active sessions', () => {
      createTask({ title: 'Tracked', source: 'fambot' });
      dispatchTask(1);

      expect(getActiveSessions().size).toBe(1);
      expect(getActiveSessions().has(1)).toBe(true);
    });
  });

  describe('cancelSession', () => {
    it('cancels and cleans up', () => {
      createTask({ title: 'Cancel me', source: 'fambot' });
      const { session } = dispatchTask(1);
      const wtPath = session.worktreePath;

      cancelSession(1);

      expect(getActiveSessions().size).toBe(0);
      expect(fs.existsSync(wtPath)).toBe(false);

      const task = readTask(1);
      expect(task!.status).toBe('open');
    });
  });
});
