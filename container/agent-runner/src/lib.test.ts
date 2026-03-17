import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  sanitizeFilename,
  generateFallbackName,
  parseTranscript,
  formatTranscriptMarkdown,
  loadGlobalPolicy,
  discoverExtraDirs,
  buildSystemPrompt,
  buildMcpConfig,
  buildInitialPrompt,
  getSessionSummary,
  drainIpcInput,
  shouldClose,
  ALLOWED_TOOLS,
} from './lib.js';

// Helpers

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-test-'));
}

// sanitizeFilename

describe('sanitizeFilename', () => {
  /**
   * INVARIANT: sanitizeFilename always returns a string safe for use as a filename —
   * lowercase, alphanumeric with hyphens, no leading/trailing hyphens, max 50 chars.
   */
  it('converts mixed-case string to lowercase kebab', () => {
    expect(sanitizeFilename('Hello World Test')).toBe('hello-world-test');
  });

  it('strips special characters', () => {
    expect(sanitizeFilename('Fix #123: bug in @auth!')).toBe('fix-123-bug-in-auth');
  });

  it('removes leading and trailing hyphens', () => {
    expect(sanitizeFilename('---leading---trailing---')).toBe('leading-trailing');
  });

  it('truncates to 50 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeFilename(long).length).toBe(50);
  });

  it('handles empty string', () => {
    expect(sanitizeFilename('')).toBe('');
  });

  it('collapses consecutive special chars into single hyphen', () => {
    expect(sanitizeFilename('hello___world---test')).toBe('hello-world-test');
  });
});

// generateFallbackName

describe('generateFallbackName', () => {
  /**
   * INVARIANT: generateFallbackName returns "conversation-HHMM" using the provided date.
   */
  it('formats time with zero-padded hours and minutes', () => {
    const date = new Date(2026, 2, 17, 9, 5); // 09:05
    expect(generateFallbackName(date)).toBe('conversation-0905');
  });

  it('handles midnight', () => {
    const date = new Date(2026, 0, 1, 0, 0);
    expect(generateFallbackName(date)).toBe('conversation-0000');
  });

  it('handles 23:59', () => {
    const date = new Date(2026, 0, 1, 23, 59);
    expect(generateFallbackName(date)).toBe('conversation-2359');
  });
});

// parseTranscript

describe('parseTranscript', () => {
  /**
   * INVARIANT: parseTranscript extracts user and assistant messages from NDJSON transcript,
   * returning only messages with non-empty text content.
   */
  it('parses user messages with string content', () => {
    const ndjson = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Hello' },
    });
    const result = parseTranscript(ndjson);
    expect(result).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('parses user messages with array content (multimodal)', () => {
    const ndjson = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ text: 'Part 1' }, { text: 'Part 2' }] },
    });
    const result = parseTranscript(ndjson);
    expect(result).toEqual([{ role: 'user', content: 'Part 1Part 2' }]);
  });

  it('parses assistant messages filtering to text blocks', () => {
    const ndjson = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Response' },
          { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
        ],
      },
    });
    const result = parseTranscript(ndjson);
    expect(result).toEqual([{ role: 'assistant', content: 'Response' }]);
  });

  it('skips empty lines and malformed JSON', () => {
    const input = '\n\nbad json\n' + JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Valid' },
    });
    const result = parseTranscript(input);
    expect(result).toEqual([{ role: 'user', content: 'Valid' }]);
  });

  it('skips messages with empty text', () => {
    const ndjson = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '' },
    });
    const result = parseTranscript(ndjson);
    expect(result).toEqual([]);
  });

  it('handles multi-line NDJSON with mixed types', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Q1' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A1' }] } }),
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Q2' } }),
    ].join('\n');
    const result = parseTranscript(lines);
    expect(result).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseTranscript('')).toEqual([]);
  });
});

// formatTranscriptMarkdown

describe('formatTranscriptMarkdown', () => {
  /**
   * INVARIANT: formatTranscriptMarkdown produces valid Markdown with title, archive date,
   * and formatted messages, truncating content at 2000 chars.
   */
  const fixedDate = new Date(2026, 2, 17, 14, 30);

  it('includes title and formatted messages', () => {
    const md = formatTranscriptMarkdown(
      [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi!' }],
      'Test Chat',
      undefined,
      fixedDate,
    );
    expect(md).toContain('# Test Chat');
    expect(md).toContain('**User**: Hello');
    expect(md).toContain('**Assistant**: Hi!');
  });

  it('uses "Conversation" as default title', () => {
    const md = formatTranscriptMarkdown([], null, undefined, fixedDate);
    expect(md).toContain('# Conversation');
  });

  it('uses custom assistant name', () => {
    const md = formatTranscriptMarkdown(
      [{ role: 'assistant', content: 'Hi' }],
      null,
      'Andy',
      fixedDate,
    );
    expect(md).toContain('**Andy**: Hi');
  });

  it('truncates long messages at 2000 chars', () => {
    const longContent = 'x'.repeat(3000);
    const md = formatTranscriptMarkdown(
      [{ role: 'user', content: longContent }],
      null,
      undefined,
      fixedDate,
    );
    expect(md).toContain('x'.repeat(2000) + '...');
    expect(md).not.toContain('x'.repeat(2001));
  });

  it('includes archive date', () => {
    const md = formatTranscriptMarkdown([], null, undefined, fixedDate);
    expect(md).toContain('Archived:');
  });
});

// loadGlobalPolicy

describe('loadGlobalPolicy', () => {
  /**
   * INVARIANT: loadGlobalPolicy returns file contents when file exists, undefined otherwise.
   */
  it('returns file contents when file exists', () => {
    const dir = mkTmpDir();
    const filePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(filePath, '# Global Policy');
    expect(loadGlobalPolicy(filePath)).toBe('# Global Policy');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns undefined when file does not exist', () => {
    expect(loadGlobalPolicy('/nonexistent/CLAUDE.md')).toBeUndefined();
  });
});

// discoverExtraDirs

describe('discoverExtraDirs', () => {
  /**
   * INVARIANT: discoverExtraDirs returns absolute paths of all subdirectories
   * under the given base, or empty array if base doesn't exist.
   */
  it('returns directories under the base path', () => {
    const base = mkTmpDir();
    fs.mkdirSync(path.join(base, 'vertical-a'));
    fs.mkdirSync(path.join(base, 'vertical-b'));
    fs.writeFileSync(path.join(base, 'not-a-dir.txt'), 'file');

    const dirs = discoverExtraDirs(base);
    expect(dirs.length).toBe(2);
    expect(dirs).toContain(path.join(base, 'vertical-a'));
    expect(dirs).toContain(path.join(base, 'vertical-b'));
    fs.rmSync(base, { recursive: true });
  });

  it('returns empty array when base does not exist', () => {
    expect(discoverExtraDirs('/nonexistent/extra')).toEqual([]);
  });

  it('returns empty array when base has no subdirectories', () => {
    const base = mkTmpDir();
    fs.writeFileSync(path.join(base, 'file.txt'), 'data');
    expect(discoverExtraDirs(base)).toEqual([]);
    fs.rmSync(base, { recursive: true });
  });
});

// buildSystemPrompt

describe('buildSystemPrompt', () => {
  /**
   * INVARIANT: buildSystemPrompt returns a preset config with appended policy when given content,
   * or undefined when given undefined.
   */
  it('returns preset config when policy exists', () => {
    const result = buildSystemPrompt('# My Policy');
    expect(result).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: '# My Policy',
    });
  });

  it('returns undefined when no policy', () => {
    expect(buildSystemPrompt(undefined)).toBeUndefined();
  });
});

// buildMcpConfig

describe('buildMcpConfig', () => {
  /**
   * INVARIANT: buildMcpConfig produces correct MCP server config with environment variables
   * matching the container input.
   */
  it('builds correct config with isMain=true', () => {
    const input = {
      prompt: 'test',
      groupFolder: 'telegram_main',
      chatJid: 'tg:-123',
      isMain: true,
    };
    const config = buildMcpConfig('/path/to/mcp.js', input);
    expect(config.nanoclaw.command).toBe('node');
    expect(config.nanoclaw.args).toEqual(['/path/to/mcp.js']);
    expect(config.nanoclaw.env.NANOCLAW_IS_MAIN).toBe('1');
    expect(config.nanoclaw.env.NANOCLAW_CHAT_JID).toBe('tg:-123');
    expect(config.nanoclaw.env.NANOCLAW_GROUP_FOLDER).toBe('telegram_main');
  });

  it('sets NANOCLAW_IS_MAIN to 0 when not main', () => {
    const input = {
      prompt: 'test',
      groupFolder: 'telegram_other',
      chatJid: 'tg:-456',
      isMain: false,
    };
    const config = buildMcpConfig('/path/to/mcp.js', input);
    expect(config.nanoclaw.env.NANOCLAW_IS_MAIN).toBe('0');
  });
});

// ALLOWED_TOOLS

describe('ALLOWED_TOOLS', () => {
  /**
   * INVARIANT: The allowed tools list contains all expected SDK tools and the MCP wildcard.
   */
  it('includes core tools', () => {
    expect(ALLOWED_TOOLS).toContain('Bash');
    expect(ALLOWED_TOOLS).toContain('Read');
    expect(ALLOWED_TOOLS).toContain('Write');
    expect(ALLOWED_TOOLS).toContain('Edit');
    expect(ALLOWED_TOOLS).toContain('Glob');
    expect(ALLOWED_TOOLS).toContain('Grep');
  });

  it('includes MCP wildcard', () => {
    expect(ALLOWED_TOOLS).toContain('mcp__nanoclaw__*');
  });

  it('includes agent teams tools', () => {
    expect(ALLOWED_TOOLS).toContain('TeamCreate');
    expect(ALLOWED_TOOLS).toContain('TeamDelete');
    expect(ALLOWED_TOOLS).toContain('SendMessage');
  });
});

// buildInitialPrompt

describe('buildInitialPrompt', () => {
  /**
   * INVARIANT: buildInitialPrompt prepends scheduled task header when isScheduledTask is true,
   * and appends pending messages when present.
   */
  it('returns base prompt unchanged when no flags', () => {
    expect(buildInitialPrompt('Hello', false, [])).toBe('Hello');
  });

  it('prepends scheduled task header', () => {
    const result = buildInitialPrompt('Do something', true, []);
    expect(result).toContain('[SCHEDULED TASK');
    expect(result).toContain('Do something');
  });

  it('appends pending messages', () => {
    const result = buildInitialPrompt('Hello', false, ['msg1', 'msg2']);
    expect(result).toBe('Hello\nmsg1\nmsg2');
  });

  it('handles both scheduled task and pending messages', () => {
    const result = buildInitialPrompt('Task', true, ['extra']);
    expect(result).toContain('[SCHEDULED TASK');
    expect(result).toContain('Task');
    expect(result).toContain('extra');
  });
});

// getSessionSummary

describe('getSessionSummary', () => {
  /**
   * INVARIANT: getSessionSummary returns the summary string for a matching session ID
   * from the sessions-index.json, or null if not found.
   */
  it('returns summary when session found', () => {
    const dir = mkTmpDir();
    const transcriptPath = path.join(dir, 'session-abc.jsonl');
    fs.writeFileSync(transcriptPath, ''); // doesn't need content
    const index = {
      entries: [
        { sessionId: 'abc', fullPath: '/path', summary: 'My Session', firstPrompt: 'hi' },
      ],
    };
    fs.writeFileSync(path.join(dir, 'sessions-index.json'), JSON.stringify(index));

    expect(getSessionSummary('abc', transcriptPath)).toBe('My Session');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns null when session not found', () => {
    const dir = mkTmpDir();
    const transcriptPath = path.join(dir, 'session.jsonl');
    fs.writeFileSync(transcriptPath, '');
    const index = { entries: [] };
    fs.writeFileSync(path.join(dir, 'sessions-index.json'), JSON.stringify(index));

    expect(getSessionSummary('nonexistent', transcriptPath)).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });

  it('returns null when index file missing', () => {
    expect(getSessionSummary('abc', '/tmp/nonexistent/session.jsonl')).toBeNull();
  });

  it('returns null when index is malformed', () => {
    const dir = mkTmpDir();
    const transcriptPath = path.join(dir, 'session.jsonl');
    fs.writeFileSync(transcriptPath, '');
    fs.writeFileSync(path.join(dir, 'sessions-index.json'), 'not json');

    expect(getSessionSummary('abc', transcriptPath)).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });
});

// drainIpcInput

describe('drainIpcInput', () => {
  /**
   * INVARIANT: drainIpcInput reads all .json files from the input directory,
   * extracts message texts, deletes the files, and returns the texts in sorted order.
   */
  it('reads and removes message files', () => {
    const dir = mkTmpDir();
    const inputDir = path.join(dir, 'input');
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, '001.json'),
      JSON.stringify({ type: 'message', text: 'First' }),
    );
    fs.writeFileSync(
      path.join(inputDir, '002.json'),
      JSON.stringify({ type: 'message', text: 'Second' }),
    );

    const messages = drainIpcInput(inputDir);
    expect(messages).toEqual(['First', 'Second']);

    // Files should be cleaned up
    expect(fs.readdirSync(inputDir).filter(f => f.endsWith('.json'))).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });

  it('ignores non-message type files', () => {
    const dir = mkTmpDir();
    const inputDir = path.join(dir, 'input');
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, '001.json'),
      JSON.stringify({ type: 'other', text: 'Ignored' }),
    );

    const messages = drainIpcInput(inputDir);
    expect(messages).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });

  it('handles malformed JSON gracefully', () => {
    const dir = mkTmpDir();
    const inputDir = path.join(dir, 'input');
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(path.join(inputDir, '001.json'), 'not json');
    fs.writeFileSync(
      path.join(inputDir, '002.json'),
      JSON.stringify({ type: 'message', text: 'Valid' }),
    );

    const messages = drainIpcInput(inputDir);
    expect(messages).toEqual(['Valid']);
    fs.rmSync(dir, { recursive: true });
  });

  it('creates input directory if missing', () => {
    const dir = mkTmpDir();
    const inputDir = path.join(dir, 'new-dir');

    const messages = drainIpcInput(inputDir);
    expect(messages).toEqual([]);
    expect(fs.existsSync(inputDir)).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns empty array on error', () => {
    // Pass a file path instead of directory to trigger error
    const dir = mkTmpDir();
    const filePath = path.join(dir, 'file.txt');
    fs.writeFileSync(filePath, 'data');

    // Use a mock fs that throws on mkdirSync
    const mockFs = {
      mkdirSync: () => { throw new Error('boom'); },
      readdirSync: fs.readdirSync,
      readFileSync: fs.readFileSync,
      unlinkSync: fs.unlinkSync,
    };
    const messages = drainIpcInput('/bad/path', mockFs as any);
    expect(messages).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });
});

// shouldClose

describe('shouldClose', () => {
  /**
   * INVARIANT: shouldClose returns true and removes the sentinel when it exists,
   * false when it doesn't.
   */
  it('returns true and removes sentinel when it exists', () => {
    const dir = mkTmpDir();
    const sentinel = path.join(dir, '_close');
    fs.writeFileSync(sentinel, '');

    expect(shouldClose(sentinel)).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns false when sentinel does not exist', () => {
    expect(shouldClose('/nonexistent/_close')).toBe(false);
  });
});
