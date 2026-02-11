import { describe, it, expect, vi, beforeEach } from 'vitest';

import { _initTestDatabase, _getTestDatabase, runMigrations, getComplaintSession, setComplaintSession, isUserBlocked } from './db.js';

// Mock the Agent SDK before importing the handler
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  tool: vi.fn((_name, _desc, _schema, handler) => ({
    name: _name,
    description: _desc,
    inputSchema: _schema,
    handler,
  })),
  createSdkMcpServer: vi.fn((_opts) => ({
    type: 'sdk',
    name: _opts.name,
    instance: {},
  })),
}));

import { query as mockQuery } from '@anthropic-ai/claude-agent-sdk';
import { handleComplaintMessage, _clearPromptCache } from './complaint-handler.js';

// Helper: create a mock async generator for SDK messages
async function* createMockQueryIterator(messages: Array<{ type: string; subtype?: string; session_id: string; result?: string }>) {
  yield* messages;
}

/** Shorthand to set up mockQuery returning a result. */
function mockQueryReturning(result: string, sessionId = 'sess-1') {
  const iter = createMockQueryIterator([
    { type: 'result', subtype: 'success', session_id: sessionId, result },
  ]);
  (mockQuery as ReturnType<typeof vi.fn>).mockReturnValue(iter);
}

beforeEach(() => {
  _initTestDatabase();
  const db = _getTestDatabase();
  runMigrations(db);
  _clearPromptCache();
  vi.clearAllMocks();

  // Seed tenant config
  db.prepare("INSERT OR REPLACE INTO tenant_config (key, value) VALUES ('complaint_id_prefix', 'RK')").run();
});

// ============================================================
// DB session helpers
// ============================================================

describe('complaint session persistence', () => {
  it('getComplaintSession returns undefined for unknown phone', () => {
    expect(getComplaintSession('919876543210')).toBeUndefined();
  });

  it('setComplaintSession and getComplaintSession round-trip', () => {
    setComplaintSession('919876543210', 'session-abc-123');
    expect(getComplaintSession('919876543210')).toBe('session-abc-123');
  });

  it('setComplaintSession overwrites existing session', () => {
    setComplaintSession('919876543210', 'session-1');
    setComplaintSession('919876543210', 'session-2');
    expect(getComplaintSession('919876543210')).toBe('session-2');
  });

  it('sessions are isolated per phone', () => {
    setComplaintSession('919876543210', 'session-A');
    setComplaintSession('919999999999', 'session-B');
    expect(getComplaintSession('919876543210')).toBe('session-A');
    expect(getComplaintSession('919999999999')).toBe('session-B');
  });
});

// ============================================================
// isUserBlocked
// ============================================================

describe('isUserBlocked', () => {
  it('returns false for unknown phone', () => {
    expect(isUserBlocked('919876543210')).toBe(false);
  });

  it('returns false for non-blocked user', () => {
    const db = _getTestDatabase();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO users (phone, is_blocked, first_seen, last_seen) VALUES (?, 0, ?, ?)',
    ).run('919876543210', now, now);

    expect(isUserBlocked('919876543210')).toBe(false);
  });

  it('returns true for blocked user', () => {
    const db = _getTestDatabase();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO users (phone, is_blocked, block_reason, first_seen, last_seen) VALUES (?, 1, ?, ?, ?)',
    ).run('919876543210', 'Spam', now, now);

    expect(isUserBlocked('919876543210')).toBe(true);
  });
});

// ============================================================
// handleComplaintMessage
// ============================================================

describe('handleComplaintMessage', () => {
  it('calls Agent SDK query with correct options', async () => {
    const mockIter = createMockQueryIterator([
      { type: 'system', subtype: 'init', session_id: 'sess-123' },
      { type: 'result', subtype: 'success', session_id: 'sess-123', result: 'Hello! How can I help?' },
    ]);
    (mockQuery as ReturnType<typeof vi.fn>).mockReturnValue(mockIter);

    const result = await handleComplaintMessage('919876543210', 'Rajesh', 'I have a water issue');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Verify prompt includes user context
    expect(callArgs.prompt).toContain('919876543210');
    expect(callArgs.prompt).toContain('Rajesh');
    expect(callArgs.prompt).toContain('I have a water issue');

    // Verify options
    expect(callArgs.options.allowedTools).toEqual(['mcp__complaint__*']);
    expect(callArgs.options.permissionMode).toBe('bypassPermissions');
    expect(callArgs.options.maxTurns).toBe(10);
    expect(callArgs.options.mcpServers).toHaveProperty('complaint');

    // Verify result
    expect(result).toBe('Hello! How can I help?');
  });

  it('persists session ID for conversation continuity', async () => {
    mockQueryReturning('Response', 'sess-new');

    await handleComplaintMessage('919876543210', 'Rajesh', 'Hello');

    expect(getComplaintSession('919876543210')).toBe('sess-new');
  });

  it('passes saved session ID on subsequent calls (resume)', async () => {
    // Set a pre-existing session
    setComplaintSession('919876543210', 'sess-previous');

    mockQueryReturning('Resumed response', 'sess-resumed');

    await handleComplaintMessage('919876543210', 'Rajesh', 'What is my complaint status?');

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.options.resume).toBe('sess-previous');
  });

  it('does not pass resume for new users (no session)', async () => {
    mockQueryReturning('Welcome', 'sess-new');

    await handleComplaintMessage('910000000000', 'NewUser', 'Hi');

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.options.resume).toBeUndefined();
  });

  it('serializes concurrent messages from the same user', async () => {
    const callOrder: number[] = [];
    let callCount = 0;

    (mockQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const index = callCount++;
      return createMockQueryIterator([
        {
          type: 'result',
          subtype: 'success',
          session_id: `sess-${index}`,
          result: `Response ${index}`,
        },
      ]);
    });

    // Fire two concurrent messages from the same user
    const p1 = handleComplaintMessage('919876543210', 'Rajesh', 'Message 1').then(() => callOrder.push(1));
    const p2 = handleComplaintMessage('919876543210', 'Rajesh', 'Message 2').then(() => callOrder.push(2));

    await Promise.all([p1, p2]);

    // Both should complete, and in order (serialized)
    expect(callOrder).toEqual([1, 2]);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('allows concurrent messages from different users', async () => {
    (mockQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return createMockQueryIterator([
        { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'OK' },
      ]);
    });

    const p1 = handleComplaintMessage('919876543210', 'User1', 'Hello');
    const p2 = handleComplaintMessage('919999999999', 'User2', 'Hello');

    await Promise.all([p1, p2]);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('propagates SDK errors', async () => {
    (mockQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return (async function* () {
        throw new Error('SDK connection failed');
      })();
    });

    await expect(
      handleComplaintMessage('919876543210', 'Rajesh', 'Hello'),
    ).rejects.toThrow('SDK connection failed');
  });

  it('disallows dangerous tools (Bash, Read, Write, etc.)', async () => {
    mockQueryReturning('OK');

    await handleComplaintMessage('919876543210', 'Rajesh', 'Hello');

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.options.disallowedTools).toContain('Bash');
    expect(callArgs.options.disallowedTools).toContain('Read');
    expect(callArgs.options.disallowedTools).toContain('Write');
    expect(callArgs.options.disallowedTools).toContain('Edit');
  });

  it('loads system prompt from CLAUDE.md with MCP tool references', async () => {
    mockQueryReturning('OK');

    await handleComplaintMessage('919876543210', 'Rajesh', 'Hello');

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // System prompt should reference MCP tools, not shell scripts
    expect(callArgs.options.systemPrompt).toContain('create_complaint');
    expect(callArgs.options.systemPrompt).toContain('query_complaints');
    expect(callArgs.options.systemPrompt).toContain('get_user');
    expect(callArgs.options.systemPrompt).toContain('block_user');
    expect(callArgs.options.systemPrompt).not.toContain('create-complaint.sh');
  });

  it('XML-escapes phone and userName in prompt', async () => {
    mockQueryReturning('OK');

    await handleComplaintMessage('919876543210', 'Test "User" <script>', 'Hello');

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.prompt).toContain('&quot;User&quot;');
    expect(callArgs.prompt).toContain('&lt;script&gt;');
    expect(callArgs.prompt).not.toContain('"User"');
  });
});
