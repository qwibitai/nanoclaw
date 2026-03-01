/**
 * Observer Eval Suite
 *
 * Two categories:
 *   EVAL-FIRST  — assertion-based boundary evals (run now, expect FAIL before implementation)
 *   SCAFFOLD    — LLM-as-judge + outcome evals (skip now, score after implementation)
 *
 * The module under test (./observer.ts) does not yet exist. We use dynamic
 * import() inside each test so vitest can register all tests and report
 * per-test pass/fail rather than a single suite-level import error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (must be declared before module import) ──────────────────────────

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    existsSync: vi.fn(),
  },
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// ── Imports (after mocks — fs is mocked, observer loaded dynamically) ──────

import fs from 'node:fs';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Dynamically import the module under test. */
async function loadObserver() {
  const mod = await import('./observer.js');
  return {
    observeConversation: mod.observeConversation as (
      groupFolder: string,
      userMessages: Array<{
        sender_name: string;
        content: string;
        timestamp: string;
      }>,
      botResponses: string[],
    ) => Promise<void>,
    _resetCooldownsForTesting: mod._resetCooldownsForTesting as () => void,
  };
}

/** Build a minimal successful LLM response body. */
function makeLlmResponse(observationText: string): string {
  return JSON.stringify({
    choices: [
      {
        message: {
          content: observationText,
        },
      },
    ],
  });
}

/** Sample conversation about a decision (used across multiple evals). */
const decisionConversation = {
  userMessages: [
    {
      sender_name: 'brandon',
      content:
        "We're switching the main model from Haiku to Sonnet 4.6 starting tomorrow. Update all five bot configs.",
      timestamp: '2026-02-27T10:00:00Z',
    },
    {
      sender_name: 'brandon',
      content:
        'Also bump the compaction threshold to 60k tokens while you are at it.',
      timestamp: '2026-02-27T10:01:00Z',
    },
  ],
  botResponses: [
    "Got it. I'll update all five openclaw.json configs to use claude-sonnet-4.6 and set softThresholdTokens to 60000.",
    'Done. All configs updated and containers force-recreated. Health checks passing.',
  ],
};

/** Sample pleasantries conversation. */
const pleasantriesConversation = {
  userMessages: [
    {
      sender_name: 'brandon',
      content: 'Hey, good morning!',
      timestamp: '2026-02-27T08:00:00Z',
    },
    {
      sender_name: 'brandon',
      content: 'How are you doing today?',
      timestamp: '2026-02-27T08:00:30Z',
    },
  ],
  botResponses: [
    'Good morning! I am doing well, thank you for asking.',
    'Ready to help whenever you need me.',
  ],
};

// ── Setup ──────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  // Reset circuit breaker state between tests (best-effort if module loaded)
  // _resetCooldownsForTesting is called inside each test after dynamic import

  // Restore env
  delete process.env.OBSERVER_ENABLED;

  // Default: fetch returns a valid JSON observation (matches ObservationOutputSchema)
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () =>
      JSON.parse(
        makeLlmResponse(
          JSON.stringify({
            observations: [
              {
                time: '08:00',
                topic: 'Routine greeting',
                priority: 'noise',
                points: ['Standard morning greeting'],
                referencedDates: [],
              },
            ],
          }),
        ),
      ),
  });
  vi.stubGlobal('fetch', mockFetch);

  // Default fs mocks
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockReturnValue('');
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OBSERVER_ENABLED;
});

// ═══════════════════════════════════════════════════════════════════════════
// EVAL-FIRST — Assertion evals for BOUNDARY rules
// These MUST all fail before implementation exists.
// ═══════════════════════════════════════════════════════════════════════════

describe('EVAL-FIRST: Observer Boundary Assertions', () => {
  // ── BOUNDARY: output must not contain credential patterns ──────────────

  it('BOUNDARY: output must not contain credential patterns', async () => {
    const { observeConversation, _resetCooldownsForTesting } =
      await loadObserver();
    _resetCooldownsForTesting();

    // Mock fetch returns a valid JSON observation that contains leaked credentials.
    // The implementation MUST scrub these before writing to disk.
    const leakedObservation = JSON.stringify({
      observations: [
        {
          time: '14:00',
          topic: 'User shared API key sk-proj-abc123def456 during conversation',
          priority: 'critical',
          points: [
            'Found GitHub token ghp_1234567890abcdef1234567890abcdef12345678 in logs',
            'AWS key AKIAIOSFODNN7EXAMPLE was mentioned',
            'Another secret: sk-ant-api03-xxxxxxxxxxxx',
          ],
          referencedDates: [],
        },
      ],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => JSON.parse(makeLlmResponse(leakedObservation)),
    });

    await observeConversation(
      'main',
      decisionConversation.userMessages,
      decisionConversation.botResponses,
    );

    // Verify writeFileSync was called
    expect(fs.writeFileSync).toHaveBeenCalled();

    const writtenContent = vi.mocked(fs.writeFileSync).mock
      .calls[0][1] as string;

    // Credential patterns that MUST NOT appear in output
    const credentialPatterns = [
      /sk-[a-zA-Z0-9_-]{10,}/, // OpenAI / Anthropic keys
      /ghp_[a-zA-Z0-9]{36,}/, // GitHub personal access tokens
      /AKIA[0-9A-Z]{16}/, // AWS access key IDs
      /sk-ant-api\d{2}-[a-zA-Z0-9_-]+/, // Anthropic API keys
    ];

    for (const pattern of credentialPatterns) {
      expect(
        writtenContent,
        `Credential pattern ${pattern} found in written output — scrubbing failed`,
      ).not.toMatch(pattern);
    }
  });

  // ── BOUNDARY: existing file content must not be modified ───────────────

  it('BOUNDARY: existing file content must not be modified', async () => {
    const { observeConversation, _resetCooldownsForTesting } =
      await loadObserver();
    _resetCooldownsForTesting();

    const preExistingContent = [
      '# Daily Observer Notes',
      '',
      '## 2026-02-27T09:00:00Z — Previous Observation',
      'User discussed deployment strategy.',
      'Priority: Important',
      '',
    ].join('\n');

    // File already exists with content
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(preExistingContent);

    await observeConversation(
      'main',
      decisionConversation.userMessages,
      decisionConversation.botResponses,
    );

    expect(fs.writeFileSync).toHaveBeenCalled();

    const writtenContent = vi.mocked(fs.writeFileSync).mock
      .calls[0][1] as string;

    // The pre-existing content MUST still appear, unchanged, in the written output.
    // The observer appends; it never overwrites or modifies previous sections.
    expect(
      writtenContent,
      'Pre-existing file content was modified or removed by observer',
    ).toContain(preExistingContent);
  });

  // ── BOUNDARY: circuit breaker disables after 3 consecutive failures ────

  it('BOUNDARY: circuit breaker disables after 3 consecutive failures', async () => {
    const { observeConversation, _resetCooldownsForTesting } =
      await loadObserver();
    _resetCooldownsForTesting();

    // First 3 calls: fetch rejects (simulating LLM failures)
    mockFetch
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockRejectedValueOnce(new Error('LLM 500'))
      .mockRejectedValueOnce(new Error('LLM rate limit'));

    const args = [
      'main',
      pleasantriesConversation.userMessages,
      pleasantriesConversation.botResponses,
    ] as const;

    // Trigger 3 failures (should return silently, not throw)
    await observeConversation(...args);
    await observeConversation(...args);
    await observeConversation(...args);

    // Reset the mock call count so we can verify the 4th call behaviour
    mockFetch.mockClear();

    // Provide a successful response — but circuit breaker should prevent the call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        JSON.parse(
          makeLlmResponse('## Observation\nThis should never be written.'),
        ),
    });

    // 4th call: circuit breaker engaged — fetch must NOT be called
    await observeConversation(...args);

    expect(
      mockFetch,
      'Circuit breaker failed to engage — fetch was called after 3 consecutive failures',
    ).not.toHaveBeenCalled();
  });

  // ── BOUNDARY: kill switch prevents LLM call ────────────────────────────

  it('BOUNDARY: kill switch prevents LLM call when OBSERVER_ENABLED=false', async () => {
    const { observeConversation, _resetCooldownsForTesting } =
      await loadObserver();
    _resetCooldownsForTesting();

    process.env.OBSERVER_ENABLED = 'false';

    await observeConversation(
      'main',
      decisionConversation.userMessages,
      decisionConversation.botResponses,
    );

    expect(
      mockFetch,
      'Kill switch failed — fetch was called even though OBSERVER_ENABLED=false',
    ).not.toHaveBeenCalled();
  });

  // ── BOUNDARY: only 1 fetch call per observation (step budget) ──────────

  it('BOUNDARY: only 1 fetch call per observation (step budget)', async () => {
    const { observeConversation, _resetCooldownsForTesting } =
      await loadObserver();
    _resetCooldownsForTesting();

    await observeConversation(
      'main',
      decisionConversation.userMessages,
      decisionConversation.botResponses,
    );

    expect(
      mockFetch,
      `Step budget violated — fetch called ${mockFetch.mock.calls.length} times instead of exactly 1`,
    ).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCAFFOLD — LLM-as-judge evals (skip until implementation exists)
// ═══════════════════════════════════════════════════════════════════════════

describe('SCAFFOLD: LLM-as-Judge Evals', () => {
  // SCAFFOLD — score after implementation
  it.skip('SCAFFOLD: decision conversation gets Critical priority', async () => {
    // Scoring: 1-5 scale, pass@3 >= 3.0
    //
    // Setup: Use real (unmocked) fetch for LLM call, or mock fetch to return
    // a plausible LLM response that assigns priority.
    // After observeConversation completes, read the written file and verify
    // it contains a Critical priority marker.

    const { observeConversation, _resetCooldownsForTesting } =
      await loadObserver();
    _resetCooldownsForTesting();

    // For now, mock fetch to return a response with Critical marker
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        JSON.parse(
          makeLlmResponse(
            '## Observation\nDecision: Switch model from Haiku to Sonnet 4.6 across all bots.\nPriority: Critical',
          ),
        ),
    });

    await observeConversation(
      'main',
      decisionConversation.userMessages,
      decisionConversation.botResponses,
    );

    expect(fs.writeFileSync).toHaveBeenCalled();
    const writtenContent = vi.mocked(fs.writeFileSync).mock
      .calls[0][1] as string;

    // Judge criterion: written output must contain Critical priority indicator
    expect(writtenContent).toMatch(/critical/i);
  });

  // SCAFFOLD — score after implementation
  it.skip('SCAFFOLD: pleasantries conversation gets Noise priority', async () => {
    // Scoring: 1-5 scale, pass@3 >= 3.0
    //
    // After observeConversation completes, read the written file and verify
    // it contains a Noise priority marker and does NOT fabricate decisions
    // or commitments that were not in the conversation.

    const { observeConversation, _resetCooldownsForTesting } =
      await loadObserver();
    _resetCooldownsForTesting();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        JSON.parse(
          makeLlmResponse(
            '## Observation\nRoutine greetings exchanged. No decisions or commitments.\nPriority: Noise',
          ),
        ),
    });

    await observeConversation(
      'main',
      pleasantriesConversation.userMessages,
      pleasantriesConversation.botResponses,
    );

    expect(fs.writeFileSync).toHaveBeenCalled();
    const writtenContent = vi.mocked(fs.writeFileSync).mock
      .calls[0][1] as string;

    // Judge criterion: Noise marker present, no fabricated decisions
    expect(writtenContent).toMatch(/noise/i);
    expect(writtenContent).not.toMatch(/decision|commitment|action item/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCAFFOLD — Outcome evals (skip until implementation exists)
// ═══════════════════════════════════════════════════════════════════════════

describe('SCAFFOLD: Outcome Evals', () => {
  // SCAFFOLD — verify after implementation
  it.skip("SCAFFOLD: file created at correct path with daily/observer/ and today's date", async () => {
    const { observeConversation, _resetCooldownsForTesting } =
      await loadObserver();
    _resetCooldownsForTesting();

    await observeConversation(
      'main',
      decisionConversation.userMessages,
      decisionConversation.botResponses,
    );

    expect(fs.writeFileSync).toHaveBeenCalled();

    const writtenPath = vi.mocked(fs.writeFileSync).mock.calls[0][0] as string;

    // Path must include daily/observer/ directory structure
    expect(writtenPath).toContain('daily/observer/');

    // Path must include today's date (YYYY-MM-DD format)
    const today = new Date().toISOString().split('T')[0]; // e.g. "2026-02-27"
    expect(
      writtenPath,
      `File path does not contain today's date (${today})`,
    ).toContain(today);
  });

  // SCAFFOLD — verify after implementation
  it.skip('SCAFFOLD: referenced dates appear in output', async () => {
    const { observeConversation, _resetCooldownsForTesting } =
      await loadObserver();
    _resetCooldownsForTesting();

    const conversationWithDate = {
      userMessages: [
        {
          sender_name: 'brandon',
          content:
            'We have a meeting next Tuesday on March 5th to discuss the roadmap.',
          timestamp: '2026-02-27T14:00:00Z',
        },
      ],
      botResponses: [
        'Noted. I will prepare a summary for the March 5th meeting.',
      ],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        JSON.parse(
          makeLlmResponse(
            '## Observation\nUpcoming meeting scheduled for March 5th to discuss roadmap.\nPriority: Important',
          ),
        ),
    });

    await observeConversation(
      'main',
      conversationWithDate.userMessages,
      conversationWithDate.botResponses,
    );

    expect(fs.writeFileSync).toHaveBeenCalled();
    const writtenContent = vi.mocked(fs.writeFileSync).mock
      .calls[0][1] as string;

    // Output must reference the date mentioned in conversation
    const containsDate =
      writtenContent.includes('March 5') ||
      writtenContent.includes('2026-03-05');
    expect(
      containsDate,
      'Referenced date (March 5 / 2026-03-05) not found in observer output',
    ).toBe(true);
  });
});
