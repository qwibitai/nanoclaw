import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { buildRouterPrompt } from './router-prompt.js';
import { RouterRequest } from './router-types.js';

describe('buildRouterPrompt', () => {
  let originalDateNow: () => number;

  beforeEach(() => {
    // Fix Date.now for predictable time-since calculations
    originalDateNow = Date.now;
    Date.now = vi.fn(() => new Date('2025-03-17T12:00:00.000Z').getTime());
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  function makeRequest(overrides: Partial<RouterRequest> = {}): RouterRequest {
    return {
      type: 'route',
      requestId: 'test-req-1',
      messageText: 'Fix the auth bug',
      senderName: 'Aviad',
      groupFolder: 'telegram_garsson',
      cases: [
        {
          id: 'case-1',
          name: '260315-1430-fix-auth',
          type: 'dev',
          status: 'active',
          description: 'Fix authentication flow',
          lastMessage: 'Working on OAuth redirect',
          lastActivityAt: '2025-03-17T11:30:00.000Z',
        },
        {
          id: 'case-2',
          name: '260316-0900-add-tests',
          type: 'dev',
          status: 'active',
          description: 'Add integration tests for API',
          lastMessage: 'All endpoints covered',
          lastActivityAt: '2025-03-17T10:00:00.000Z',
        },
      ],
      ...overrides,
    };
  }

  /**
   * INVARIANT: Prompt must include all case details for routing decisions
   * SUT: buildRouterPrompt output
   * VERIFICATION: Every case's ID, name, type, status, and description appear in the prompt
   */
  it('includes all case details in the prompt', () => {
    const request = makeRequest();
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain('case-1');
    expect(prompt).toContain('260315-1430-fix-auth');
    expect(prompt).toContain('dev');
    expect(prompt).toContain('Fix authentication flow');
    expect(prompt).toContain('Working on OAuth redirect');

    expect(prompt).toContain('case-2');
    expect(prompt).toContain('260316-0900-add-tests');
    expect(prompt).toContain('Add integration tests for API');
  });

  /**
   * INVARIANT: Prompt must include the incoming message and sender name
   * SUT: buildRouterPrompt output
   * VERIFICATION: Message text and sender name appear in the prompt
   */
  it('includes the message text and sender name', () => {
    const request = makeRequest({
      messageText: 'Can you check the OAuth redirect?',
      senderName: 'Liraz',
    });
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain('Can you check the OAuth redirect?');
    expect(prompt).toContain('Liraz');
  });

  /**
   * INVARIANT: Prompt must include the actual requestId value so the agent
   * echoes it back in the route_decision tool call. Without this, the host
   * cannot find the result file (it looks for {requestId}.json).
   * SUT: buildRouterPrompt output
   * VERIFICATION: The exact requestId value appears in the prompt text
   */
  it('includes the actual requestId value in the prompt', () => {
    const request = makeRequest({ requestId: 'route-1773738908605-pwnz' });
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain('route-1773738908605-pwnz');
    expect(prompt).toContain('request_id');
  });

  /**
   * INVARIANT: Prompt handles cases with null lastMessage and lastActivityAt
   * SUT: buildRouterPrompt with null case fields
   * VERIFICATION: Prompt is generated without errors and uses fallback text
   */
  it('handles cases with null lastMessage and lastActivityAt', () => {
    const request = makeRequest({
      cases: [
        {
          id: 'case-new',
          name: '260317-0000-new',
          type: 'work',
          status: 'active',
          description: 'Brand new case',
          lastMessage: null,
          lastActivityAt: null,
        },
      ],
    });
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain('none');
    expect(prompt).toContain('no activity');
    expect(prompt).toContain('Brand new case');
  });

  /**
   * INVARIANT: Prompt includes rejection history when present
   * SUT: buildRouterPrompt with rejectionHistory
   * VERIFICATION: Rejection entries appear in the prompt
   */
  it('includes rejection history when provided', () => {
    const request = makeRequest({
      rejectionHistory: [
        {
          caseId: 'case-1',
          caseName: 'fix-auth',
          reason: 'Not about authentication',
        },
      ],
    });
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain('Previously rejected routings');
    expect(prompt).toContain('fix-auth');
    expect(prompt).toContain('Not about authentication');
    expect(prompt).toContain('do NOT route to these again');
  });

  /**
   * INVARIANT: Prompt omits rejection section when rejectionHistory is empty
   * SUT: buildRouterPrompt without rejectionHistory
   * VERIFICATION: No rejection-related text in the prompt
   */
  it('omits rejection section when no rejection history', () => {
    const request = makeRequest();
    const prompt = buildRouterPrompt(request);

    expect(prompt).not.toContain('Previously rejected routings');
  });

  /**
   * INVARIANT: Prompt truncates long messages to prevent excessive token usage
   * SUT: buildRouterPrompt message truncation
   * VERIFICATION: Messages longer than 1000 chars are cut off
   */
  it('truncates long messages to 1000 characters', () => {
    const longMessage = 'x'.repeat(2000);
    const request = makeRequest({ messageText: longMessage });
    const prompt = buildRouterPrompt(request);

    // The prompt should contain the truncated message, not the full 2000-char one
    const messageInPrompt = prompt.split('"')[1]; // Content between first pair of quotes after "message from"
    // Verify the message is included but truncated
    expect(prompt).toContain('x'.repeat(1000));
    expect(prompt).not.toContain('x'.repeat(1001));
  });

  /**
   * INVARIANT: Prompt includes confidence threshold and bias instructions
   * SUT: buildRouterPrompt routing rules section
   * VERIFICATION: Key routing rules are present in the prompt
   */
  it('includes routing rules for confidence threshold and recency bias', () => {
    const request = makeRequest();
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain('0.4');
    expect(prompt).toContain('most recently active');
    expect(prompt).toContain('direct_answer');
    expect(prompt).toContain('suggest_new');
    expect(prompt).toContain('route_to_case');
  });

  /**
   * INVARIANT: Prompt formats relative time correctly for last activity
   * SUT: buildRouterPrompt time formatting
   * VERIFICATION: Activity times are displayed as human-readable relative times
   */
  it('formats last activity as relative time', () => {
    const request = makeRequest({
      cases: [
        {
          id: 'case-recent',
          name: 'recent-case',
          type: 'work',
          status: 'active',
          description: 'Recently active',
          lastMessage: 'msg',
          lastActivityAt: '2025-03-17T11:30:00.000Z', // 30 min ago
        },
        {
          id: 'case-old',
          name: 'old-case',
          type: 'work',
          status: 'active',
          description: 'Old activity',
          lastMessage: 'msg',
          lastActivityAt: '2025-03-16T12:00:00.000Z', // 24h ago
        },
      ],
    });
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain('30m ago');
    expect(prompt).toContain('1d ago');
  });

  /**
   * INVARIANT: Prompt instructs agent to call the route_decision tool
   * SUT: buildRouterPrompt response format instructions
   * VERIFICATION: Tool-based instruction is present instead of raw JSON
   */
  it('instructs the agent to call the route_decision tool', () => {
    const request = makeRequest();
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain('route_decision');
    expect(prompt).toContain('MUST call');
    expect(prompt).toContain('Do NOT output raw JSON');
  });
});
