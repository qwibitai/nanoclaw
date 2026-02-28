import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'node:fs';
import {
  processHindsight,
  _resetForTesting,
  detectFrustration,
} from './hindsight.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('node:fs');
vi.mock('./group-folder.js');
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_HINDSIGHT_JSON = JSON.stringify({
  failureType: 'repeated misunderstanding',
  whatWentWrong: 'Bot kept giving wrong time for the meeting',
  whatShouldHaveBeen: 'Should have confirmed the correct time on first correction',
  actionableLearning: 'When user corrects a factual claim, update immediately and confirm',
  severity: 'moderate',
});

function mockLLMResponse(content?: string): Response {
  const body = content ?? DEFAULT_HINDSIGHT_JSON;
  return new Response(
    JSON.stringify({ choices: [{ message: { content: body } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function frustratedMessages() {
  return [
    {
      sender_name: 'brandon',
      content: "That's not what I asked, the meeting is at 3pm",
      timestamp: new Date().toISOString(),
    },
    {
      sender_name: 'brandon',
      content: 'You keep getting it wrong, this is frustrating',
      timestamp: new Date().toISOString(),
    },
    {
      sender_name: 'brandon',
      content: 'I already told you, it is 3pm not 2pm',
      timestamp: new Date().toISOString(),
    },
  ];
}

function normalMessages() {
  return [
    {
      sender_name: 'brandon',
      content: 'Can you check the weather for tomorrow?',
      timestamp: new Date().toISOString(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------
describe('hindsight', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    vi.restoreAllMocks();
    _resetForTesting();

    (resolveGroupFolderPath as Mock).mockImplementation(
      (folder: string) => `/tmp/test-groups/${folder}`,
    );

    (fs.existsSync as Mock).mockReturnValue(false);
    (fs.statSync as Mock).mockReturnValue({ size: 100 });
    (fs.readFileSync as Mock).mockReturnValue('');
    (fs.writeFileSync as Mock).mockImplementation(() => {});
    (fs.mkdirSync as Mock).mockImplementation(() => {});

    fetchMock = vi.fn().mockResolvedValue(mockLLMResponse());
    vi.stubGlobal('fetch', fetchMock);

    delete process.env.HINDSIGHT_ENABLED;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HINDSIGHT_ENABLED;
  });

  // -------------------------------------------------------------------------
  // detectFrustration
  // -------------------------------------------------------------------------
  describe('detectFrustration', () => {
    it('should detect frustration keywords', () => {
      const result = detectFrustration([
        { content: 'This is really frustrating' },
        { content: 'You keep getting it wrong' },
      ]);
      expect(result.detected).toBe(true);
      expect(result.signals.length).toBeGreaterThanOrEqual(2);
    });

    it('should detect abandonment signals', () => {
      const result = detectFrustration([
        { content: "Forget it, I'll do it myself" },
        { content: "This isn't helping at all" },
      ]);
      expect(result.detected).toBe(true);
      expect(result.signals.some((s) => s.includes('abandonment'))).toBe(true);
    });

    it('should detect repeated corrections', () => {
      const result = detectFrustration([
        { content: "No, it's 3pm not 2pm" },
        { content: "Actually, I said the blue one" },
        { content: "That's not right, try again" },
      ]);
      expect(result.correctionCount).toBeGreaterThanOrEqual(2);
    });

    it('should NOT trigger on normal messages', () => {
      const result = detectFrustration([
        { content: 'Thanks for the help!' },
        { content: 'Can you check the weather?' },
      ]);
      expect(result.detected).toBe(false);
    });

    it('should require >= 2 signals to trigger', () => {
      const result = detectFrustration([
        { content: 'This is a bit frustrating' },
      ]);
      // Only 1 signal — below threshold
      expect(result.detected).toBe(false);
    });

    it('should return empty signals for empty messages', () => {
      const result = detectFrustration([]);
      expect(result.detected).toBe(false);
      expect(result.signals).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // processHindsight — integration tests
  // -------------------------------------------------------------------------
  describe('processHindsight', () => {
    it('should call LLM and write hindsight when frustration detected', async () => {
      await processHindsight('main', frustratedMessages(), [
        'Your meeting is at 2pm',
        'The meeting is at 2pm',
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fs.writeFileSync).toHaveBeenCalled();

      const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
      expect(written).toContain('Hindsight');
      expect(written).toContain('repeated misunderstanding');
      expect(written).toContain('moderate');
    });

    it('should NOT call LLM for normal messages', async () => {
      await processHindsight('main', normalMessages(), ['The weather looks good']);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should skip when HINDSIGHT_ENABLED=false', async () => {
      process.env.HINDSIGHT_ENABLED = 'false';

      await processHindsight('main', frustratedMessages(), ['Got it']);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should skip for empty user messages', async () => {
      await processHindsight('main', [], ['Reply']);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should scrub credentials from LLM output', async () => {
      const leakedReport = JSON.stringify({
        failureType: 'credential exposure',
        whatWentWrong: 'Bot leaked sk-secret-key-abcdef12345',
        whatShouldHaveBeen: 'Should have scrubbed the key',
        actionableLearning: 'Always scrub credentials',
        severity: 'critical',
      });

      fetchMock.mockResolvedValueOnce(mockLLMResponse(leakedReport));

      await processHindsight('main', frustratedMessages(), ['Got it']);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
      expect(written).not.toContain('sk-secret-key-abcdef12345');
    });

    it('should handle LLM failure gracefully (never throws)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        processHindsight('main', frustratedMessages(), ['Reply']),
      ).resolves.toBeUndefined();
    });

    it('should skip when file exceeds 200KB', async () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.statSync as Mock).mockReturnValue({ size: 204800 });

      await processHindsight('main', frustratedMessages(), ['Reply']);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should append to existing LEARNINGS.md', async () => {
      const existing =
        '<!-- source: auto-learner -->\n## Learnings\n\n### 2026-02-27 \u2014 Old entry\n- old\n';

      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.statSync as Mock).mockReturnValue({ size: existing.length });
      (fs.readFileSync as Mock).mockReturnValue(existing);

      await processHindsight('main', frustratedMessages(), ['Got it']);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
      expect(written).toContain('Old entry');
      expect(written).toContain('Hindsight');
    });

    it('should create LEARNINGS.md with header if missing', async () => {
      (fs.existsSync as Mock).mockReturnValue(false);

      await processHindsight('main', frustratedMessages(), ['Got it']);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
      expect(written).toContain('<!-- source: hindsight -->');
      expect(written).toContain('## Learnings');
    });

    it('should wrap conversation in hard delimiters for LLM', async () => {
      await processHindsight('main', frustratedMessages(), ['Got it']);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const fullPayload = JSON.stringify(requestBody);

      expect(fullPayload).toContain('=== BEGIN UNTRUSTED CONVERSATION ===');
      expect(fullPayload).toContain('=== END UNTRUSTED CONVERSATION ===');
    });

    it('should only make 1 fetch call per hindsight (step budget)', async () => {
      await processHindsight('main', frustratedMessages(), ['Got it']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should enforce per-group cooldown', async () => {
      await processHindsight('main', frustratedMessages(), ['Got it']);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second call — same group, within cooldown
      await processHindsight('main', frustratedMessages(), ['Got it']);
      expect(fetchMock).toHaveBeenCalledTimes(1); // still 1

      // Different group
      await processHindsight('other-group', frustratedMessages(), ['Got it']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should include severity emoji in output', async () => {
      await processHindsight('main', frustratedMessages(), ['Got it']);

      const written = (fs.writeFileSync as Mock).mock.calls[0][1] as string;
      // moderate = 🟡
      expect(written).toContain('\uD83D\uDFE1');
    });

    it('should use resolveGroupFolderPath', async () => {
      await processHindsight('test-group', frustratedMessages(), ['Got it']);
      expect(resolveGroupFolderPath).toHaveBeenCalledWith('test-group');
    });
  });
});
