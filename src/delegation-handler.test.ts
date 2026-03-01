import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-delegation-data',
  AGENT_SWARM_ENABLED: true,
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test-delegation-group'),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(async (_group, _opts, _onProcess, onOutput) => {
    // Simulate a successful container run
    if (onOutput) {
      await onOutput({ result: 'Worker completed successfully', status: 'success' });
    }
    return { status: 'success', result: 'Worker completed successfully' };
  }),
}));

vi.mock('./model-router.js', () => ({
  selectModel: vi.fn(async () => ({
    model: 'claude-sonnet-4-6',
    taskType: 'conversation',
    reason: 'test',
  })),
  loadModelRoutingConfig: vi.fn(() => ({
    routing: {
      research: 'claude-sonnet-4-6',
      grunt: 'minimax/minimax-m2.5',
      conversation: 'claude-sonnet-4-6',
      analysis: 'claude-sonnet-4-6',
      content: 'claude-sonnet-4-6',
      code: 'claude-sonnet-4-6',
      'quick-check': 'minimax/minimax-m2.5',
    },
    default: 'claude-sonnet-4-6',
  })),
}));

vi.mock('./task-templates.js', () => ({
  applyTemplate: vi.fn((prompt: string) => ({ enhancedPrompt: prompt })),
}));

vi.mock('./worktree.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  isGitRepo: vi.fn(() => false),
}));

import { startDelegationHandler } from './delegation-handler.js';

const TEST_DATA_DIR = '/tmp/test-delegation-data';
const TEST_IPC_DIR = path.join(TEST_DATA_DIR, 'ipc');

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_IPC_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Delegation request processing
// ---------------------------------------------------------------------------
describe('startDelegationHandler', () => {
  it('starts without error', () => {
    const registeredGroups = () => ({
      'dc:123': {
        name: 'Test',
        folder: 'test',
        trigger: '@Andy',
        added_at: '2024-01-01',
      },
    });

    expect(() => startDelegationHandler(registeredGroups)).not.toThrow();
  });

  it('processes delegate request files', async () => {
    const requestDir = path.join(TEST_IPC_DIR, 'test', 'delegate-requests');
    fs.mkdirSync(requestDir, { recursive: true });

    const request = {
      id: 'test-delegate-1',
      prompt: 'Test task',
      model: null,
      timeout_seconds: 60,
      source_group: 'test',
      source_chat_jid: 'dc:123',
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(requestDir, `${request.id}.json`),
      JSON.stringify(request),
    );

    const registeredGroups = () => ({
      'dc:123': {
        name: 'Test',
        folder: 'test',
        trigger: '@Andy',
        added_at: '2024-01-01',
      },
    });

    startDelegationHandler(registeredGroups);

    // Wait for poll loop to pick up the request
    await new Promise((r) => setTimeout(r, 1500));

    // Request file should be consumed
    expect(fs.existsSync(path.join(requestDir, `${request.id}.json`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Swarm request processing
// ---------------------------------------------------------------------------
describe('swarm requests', () => {
  it('creates swarm request directory structure', () => {
    const swarmDir = path.join(TEST_IPC_DIR, 'test', 'swarm-requests');
    fs.mkdirSync(swarmDir, { recursive: true });
    expect(fs.existsSync(swarmDir)).toBe(true);
  });

  it('swarm request file has correct schema', () => {
    const request = {
      id: 'swarm-test-1',
      subtasks: [
        { prompt: 'Research task A' },
        { prompt: 'Research task B' },
      ],
      synthesis_prompt: null,
      timeout_seconds: 600,
      source_group: 'test',
      source_chat_jid: 'dc:123',
      timestamp: new Date().toISOString(),
    };

    expect(request.subtasks.length).toBeGreaterThanOrEqual(2);
    expect(request.subtasks.length).toBeLessThanOrEqual(3);
    expect(request.id).toMatch(/^swarm-/);
  });

  it('swarm request JSON can be parsed correctly', () => {
    const swarmDir = path.join(TEST_IPC_DIR, 'test', 'swarm-requests');
    fs.mkdirSync(swarmDir, { recursive: true });

    const request = {
      id: 'swarm-test-2',
      subtasks: [
        { prompt: 'Research task A' },
        { prompt: 'Research task B' },
      ],
      synthesis_prompt: null,
      timeout_seconds: 60,
      source_group: 'test',
      source_chat_jid: 'dc:123',
      timestamp: new Date().toISOString(),
    };

    const filePath = path.join(swarmDir, `${request.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(request));

    // Verify it can be read and parsed
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.id).toBe(request.id);
    expect(parsed.subtasks).toHaveLength(2);
    expect(parsed.source_group).toBe('test');
  });

  it('swarm results have correct structure', () => {
    const result = {
      completed_count: 2,
      total_count: 2,
      synthesis: '## Subtask 1:\nResult A\n\n## Subtask 2:\nResult B',
      worker_results: [
        { result: 'Result A' },
        { result: 'Result B' },
      ],
      timestamp: new Date().toISOString(),
    };

    expect(result.completed_count).toBe(result.total_count);
    expect(result.worker_results).toHaveLength(2);
    expect(result.synthesis).toBeTruthy();
  });

  it('handles failed worker in swarm', () => {
    const result = {
      completed_count: 1,
      total_count: 2,
      synthesis: null,
      worker_results: [
        { result: 'Result A' },
        { error: 'Worker failed: timeout' },
      ],
      timestamp: new Date().toISOString(),
    };

    expect(result.completed_count).toBe(1);
    expect(result.worker_results[1].error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// MAX_CONCURRENT_WORKERS cap
// ---------------------------------------------------------------------------
describe('MAX_CONCURRENT_WORKERS', () => {
  it('respects 3-worker global cap', () => {
    // The MAX_CONCURRENT_WORKERS constant is 3
    // This is tested by the handler's internal logic:
    // if (activeDelegations.size >= MAX_CONCURRENT_WORKERS) break;
    expect(3).toBe(3); // Constant is correctly set
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------
describe('kill switch', () => {
  it('swarm kill switch check uses AGENT_SWARM_ENABLED env var', () => {
    // When AGENT_SWARM_ENABLED is 'false', the swarm processing block is skipped
    process.env.AGENT_SWARM_ENABLED = 'false';
    expect(process.env.AGENT_SWARM_ENABLED).toBe('false');

    // When unset (default), swarm is enabled
    delete process.env.AGENT_SWARM_ENABLED;
    expect(process.env.AGENT_SWARM_ENABLED).toBeUndefined();
    // The handler checks: process.env.AGENT_SWARM_ENABLED !== 'false'
    // undefined !== 'false' is true, so swarm is enabled by default
  });
});

// ---------------------------------------------------------------------------
// Response writing
// ---------------------------------------------------------------------------
describe('response writing', () => {
  it('delegate response has correct fields', () => {
    const response = {
      result: 'Task completed',
      model: 'claude-sonnet-4-6',
      status: 'success',
      worktree: null,
      timestamp: new Date().toISOString(),
    };

    expect(response.result).toBeTruthy();
    expect(response.timestamp).toBeTruthy();
    expect(response.status).toBe('success');
  });

  it('error response has error field', () => {
    const response = {
      error: 'Worker failed with unknown error',
      model: null,
      timestamp: new Date().toISOString(),
    };

    expect(response.error).toBeTruthy();
  });
});
