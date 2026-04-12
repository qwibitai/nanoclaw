import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempRoot = '';
let dataDir = '';
let groupsDir = '';
let memoryRoot = '';

function writeTranscript(options: {
  groupFolder: string;
  sessionId: string;
  projectDir?: string;
  lines: string[];
  sessionsIndex?: object;
}): void {
  const projectDir = options.projectDir ?? '-workspace-group';
  const transcriptDir = path.join(
    dataDir,
    'sessions',
    options.groupFolder,
    '.claude',
    'projects',
    projectDir,
  );
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(transcriptDir, `${options.sessionId}.jsonl`),
    `${options.lines.join('\n')}\n`,
  );

  if (options.sessionsIndex) {
    fs.writeFileSync(
      path.join(transcriptDir, 'sessions-index.json'),
      JSON.stringify(options.sessionsIndex),
    );
  }
}

async function loadArchiveModule() {
  vi.resetModules();
  vi.doMock('../core/config.js', () => ({
    DATA_DIR: dataDir,
    GROUPS_DIR: groupsDir,
    AGENT_MEMORY_ROOT: memoryRoot,
  }));
  return import('./session-transcript-archive.js');
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-session-archive-'),
  );
  dataDir = path.join(tempRoot, 'data');
  groupsDir = path.join(tempRoot, 'groups');
  memoryRoot = path.join(tempRoot, 'agent-memory');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../core/config.js');
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('archiveSessionTranscript', () => {
  it('archives a valid transcript into AGENT_MEMORY_ROOT sessions', async () => {
    writeTranscript({
      groupFolder: 'team1',
      sessionId: 'sess-1',
      lines: [
        JSON.stringify({ type: 'user', message: { content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi there' }] },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team1',
      sessionId: 'sess-1',
      assistantName: 'NanoClaw',
    });

    expect(filePath).toBeTruthy();
    expect(filePath).toContain(path.join('agent-memory', 'sessions'));
    expect(fs.existsSync(filePath!)).toBe(true);

    const markdown = fs.readFileSync(filePath!, 'utf-8');
    expect(markdown).toContain('# Conversation');
    expect(markdown).toContain('**User**: hello');
    expect(markdown).toContain('**NanoClaw**: hi there');
  });

  it('uses summary from sessions-index.json when present', async () => {
    writeTranscript({
      groupFolder: 'team2',
      sessionId: 'sess-2',
      lines: [
        JSON.stringify({ type: 'user', message: { content: 'status?' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'all green' }] },
        }),
      ],
      sessionsIndex: {
        entries: [
          {
            sessionId: 'sess-2',
            summary: 'Weekly Status Review',
          },
        ],
      },
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team2',
      sessionId: 'sess-2',
      assistantName: 'NanoClaw',
    });

    expect(filePath).toBeTruthy();
    expect(path.basename(filePath!)).toMatch(
      /^\d{6}-new-session-weekly-status-review\.md$/,
    );
    const markdown = fs.readFileSync(filePath!, 'utf-8');
    expect(markdown).toContain('# Weekly Status Review');
  });

  it('falls back to timestamp-based filename when summary is missing', async () => {
    writeTranscript({
      groupFolder: 'team3',
      sessionId: 'sess-3',
      projectDir: 'custom-workspace',
      lines: [
        JSON.stringify({ type: 'user', message: { content: 'reset please' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'done' }] },
        }),
      ],
      sessionsIndex: {
        entries: [
          {
            sessionId: 'sess-3',
          },
        ],
      },
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team3',
      sessionId: 'sess-3',
      assistantName: 'NanoClaw',
    });

    expect(filePath).toBeTruthy();
    expect(path.basename(filePath!)).toMatch(
      /^\d{6}-new-session-conversation-\d{8}-\d{6}\.md$/,
    );
  });

  it('no-ops cleanly when transcript file is absent', async () => {
    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team4',
      sessionId: 'missing-session',
      assistantName: 'NanoClaw',
    });

    expect(filePath).toBeNull();
    const sessionsDir = path.join(memoryRoot, 'sessions');
    const sessionFiles = fs.existsSync(sessionsDir)
      ? fs
          .readdirSync(sessionsDir, { recursive: true })
          .filter((entry) => String(entry).endsWith('.md'))
      : [];
    expect(sessionFiles).toHaveLength(0);
  });

  // ── extractAssistantText / extractUserText edge cases ────────────────────

  it('handles string content directly for assistant messages', async () => {
    writeTranscript({
      groupFolder: 'team-str',
      sessionId: 'sess-str',
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: { content: 'plain string reply' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-str',
      sessionId: 'sess-str',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('**Assistant**: plain string reply');
  });

  it('returns empty for non-string non-array assistant content', async () => {
    writeTranscript({
      groupFolder: 'team-obj',
      sessionId: 'sess-obj',
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: { content: { nested: true } },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: 'keep this' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-obj',
      sessionId: 'sess-obj',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).not.toContain('**Assistant**');
    expect(md).toContain('**User**: keep this');
  });

  it('returns empty for non-string non-array user content', async () => {
    writeTranscript({
      groupFolder: 'team-num',
      sessionId: 'sess-num',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 42 },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: 'real question' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-num',
      sessionId: 'sess-num',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    // Only the second message should produce a User entry
    expect(md.match(/\*\*User\*\*/g)?.length).toBe(1);
    expect(md).toContain('**User**: real question');
  });

  it('extracts text parts and skips non-text parts in user array content', async () => {
    writeTranscript({
      groupFolder: 'team-uarr',
      sessionId: 'sess-uarr',
      lines: [
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { text: 'First part' },
              { notText: 'ignored' },
              null,
              42,
              { text: ' Second part' },
            ],
          },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-uarr',
      sessionId: 'sess-uarr',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('**User**: First part Second part');
  });

  it('filters assistant array content to only type=text parts', async () => {
    writeTranscript({
      groupFolder: 'team-afilter',
      sessionId: 'sess-afilter',
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Alpha' },
              { type: 'tool_use', id: 'tool1' },
              { type: 'text', text: ' Beta' },
              { type: 'image', url: 'http://img.png' },
            ],
          },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-afilter',
      sessionId: 'sess-afilter',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('**Assistant**: Alpha Beta');
  });

  // ── parseTranscript: malformed lines ─────────────────────────────────────

  it('gracefully skips malformed JSON lines', async () => {
    writeTranscript({
      groupFolder: 'team-bad',
      sessionId: 'sess-bad',
      lines: [
        'not valid json',
        JSON.stringify({
          type: 'user',
          message: { content: 'After bad line' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-bad',
      sessionId: 'sess-bad',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('**User**: After bad line');
  });

  it('skips blank lines in transcript', async () => {
    writeTranscript({
      groupFolder: 'team-blank',
      sessionId: 'sess-blank',
      lines: [
        '',
        '   ',
        JSON.stringify({
          type: 'user',
          message: { content: 'Present' },
        }),
        '',
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-blank',
      sessionId: 'sess-blank',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('**User**: Present');
  });

  // ── parseTranscript: unknown entry type ──────────────────────────────────

  it('skips entries with unknown type', async () => {
    writeTranscript({
      groupFolder: 'team-unk',
      sessionId: 'sess-unk',
      lines: [
        JSON.stringify({ type: 'system', message: { content: 'init' } }),
        JSON.stringify({
          type: 'user',
          message: { content: 'Visible' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-unk',
      sessionId: 'sess-unk',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('**User**: Visible');
    expect(md).not.toContain('init');
  });

  // ── formatTranscriptMarkdown: clipping ───────────────────────────────────

  it('clips messages longer than 2000 characters', async () => {
    const longContent = 'x'.repeat(3000);
    writeTranscript({
      groupFolder: 'team-clip',
      sessionId: 'sess-clip',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: longContent },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-clip',
      sessionId: 'sess-clip',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('x'.repeat(2000) + '...');
    expect(md).not.toContain('x'.repeat(2001));
  });

  // ── formatTranscriptMarkdown: default assistant name ─────────────────────

  it('uses "Assistant" when assistantName is not provided', async () => {
    writeTranscript({
      groupFolder: 'team-noname',
      sessionId: 'sess-noname',
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: { content: 'hi there' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-noname',
      sessionId: 'sess-noname',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('**Assistant**: hi there');
  });

  // ── Empty transcript (no user/assistant messages) ────────────────────────

  it('returns null for transcript with only non-user/assistant entries', async () => {
    writeTranscript({
      groupFolder: 'team-empty',
      sessionId: 'sess-empty',
      lines: [
        JSON.stringify({ type: 'system', message: { content: 'boot' } }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const result = archiveSessionTranscript({
      groupFolder: 'team-empty',
      sessionId: 'sess-empty',
    });

    expect(result).toBeNull();
  });

  // ── writePlaceholderOnMissing with empty transcript ──────────────────────

  it('writes placeholder when transcript has no messages and writePlaceholderOnMissing is true', async () => {
    writeTranscript({
      groupFolder: 'team-ph',
      sessionId: 'sess-ph',
      lines: [
        JSON.stringify({ type: 'system', message: { content: 'x' } }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-ph',
      sessionId: 'sess-ph',
      writePlaceholderOnMissing: true,
      cause: 'abandoned-session',
      errorSummary: 'Container died',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('No valid transcript content was available');
    expect(md).toContain('Cause: abandoned-session');
    expect(md).toContain('Error: Container died');
  });

  // ── writePlaceholderOnMissing with missing transcript ────────────────────

  it('writes placeholder when transcript file is missing and writePlaceholderOnMissing is true', async () => {
    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-ph-miss',
      sessionId: 'sess-ph-miss',
      writePlaceholderOnMissing: true,
      cause: 'stale-session',
      errorSummary: 'Session timed out',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('Session sess-ph-miss');
    expect(md).toContain('No valid transcript content was available');
    expect(md).toContain('Error: Session timed out');
    expect(md).toContain('Cause: stale-session');
  });

  // ── writePlaceholderOnMissing placeholder without errorSummary ───────────

  it('placeholder omits error line when errorSummary is not provided', async () => {
    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-ph-noerr',
      sessionId: 'sess-ph-noerr',
      writePlaceholderOnMissing: true,
      cause: 'new-session',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).not.toContain('Error:');
    expect(md).toContain('Cause: new-session');
  });

  // ── cause defaults to 'new-session' ─────────────────────────────────────

  it('defaults cause to new-session', async () => {
    writeTranscript({
      groupFolder: 'team-def',
      sessionId: 'sess-def',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'hi' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-def',
      sessionId: 'sess-def',
    });

    expect(filePath).toBeTruthy();
    expect(path.basename(filePath!)).toContain('new-session');
  });

  it('passes provided cause through to the archive', async () => {
    writeTranscript({
      groupFolder: 'team-cause',
      sessionId: 'sess-cause',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'hi' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-cause',
      sessionId: 'sess-cause',
      cause: 'manual-compact',
    });

    expect(filePath).toBeTruthy();
    expect(path.basename(filePath!)).toContain('manual-compact');
  });

  // ── getSessionSummary: corrupt sessions-index.json ───────────────────────

  it('handles corrupt sessions-index.json gracefully', async () => {
    const transcriptDir = path.join(
      dataDir,
      'sessions',
      'team-corrupt',
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, 'sess-corrupt.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'test' } }) + '\n',
    );
    fs.writeFileSync(
      path.join(transcriptDir, 'sessions-index.json'),
      '{ broken json !!!',
    );

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-corrupt',
      sessionId: 'sess-corrupt',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    // Falls back to 'Conversation' title
    expect(md).toContain('# Conversation');
  });

  // ── getSessionSummary: empty summary string ──────────────────────────────

  it('handles sessions-index entry with whitespace-only summary', async () => {
    writeTranscript({
      groupFolder: 'team-ws',
      sessionId: 'sess-ws',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'hi' },
        }),
      ],
      sessionsIndex: {
        entries: [{ sessionId: 'sess-ws', summary: '   ' }],
      },
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-ws',
      sessionId: 'sess-ws',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('# Conversation');
  });

  // ── getSessionSummary: no matching entry ─────────────────────────────────

  it('handles sessions-index with no matching sessionId', async () => {
    writeTranscript({
      groupFolder: 'team-nomatch',
      sessionId: 'sess-nomatch',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'hi' },
        }),
      ],
      sessionsIndex: {
        entries: [{ sessionId: 'other-id', summary: 'Not this one' }],
      },
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-nomatch',
      sessionId: 'sess-nomatch',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('# Conversation');
  });

  // ── findTranscriptByFileName: deep nested scan ───────────────────────────

  it('finds transcript in deeply nested project directory via scan', async () => {
    const deepDir = path.join(
      dataDir,
      'sessions',
      'team-deep',
      '.claude',
      'projects',
      'level1',
      'level2',
    );
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepDir, 'sess-deep.jsonl'),
      JSON.stringify({
        type: 'user',
        message: { content: 'Deep message' },
      }) + '\n',
    );

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-deep',
      sessionId: 'sess-deep',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('**User**: Deep message');
  });

  // ── findTranscriptPath: projects dir does not exist ──────────────────────

  it('returns null when projects directory does not exist', async () => {
    // Create sessions/group but not .claude/projects
    const sessDir = path.join(dataDir, 'sessions', 'team-noproj');
    fs.mkdirSync(sessDir, { recursive: true });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const result = archiveSessionTranscript({
      groupFolder: 'team-noproj',
      sessionId: 'missing',
    });

    expect(result).toBeNull();
  });

  // ── Error handling: catch block ──────────────────────────────────────────

  it('catches and returns null when AgentMemoryRootService.getInstance throws', async () => {
    vi.resetModules();
    vi.doMock('../core/config.js', () => ({
      DATA_DIR: dataDir,
      GROUPS_DIR: groupsDir,
      AGENT_MEMORY_ROOT: memoryRoot,
    }));
    vi.doMock('../memory/agent-memory-root.js', () => ({
      AgentMemoryRootService: {
        getInstance: () => {
          throw new Error('Service unavailable');
        },
      },
    }));

    const mod = await import('./session-transcript-archive.js');

    writeTranscript({
      groupFolder: 'team-err',
      sessionId: 'sess-err',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'hi' },
        }),
      ],
    });

    const result = mod.archiveSessionTranscript({
      groupFolder: 'team-err',
      sessionId: 'sess-err',
    });

    expect(result).toBeNull();

    vi.doUnmock('../memory/agent-memory-root.js');
  });

  it('catches and returns null when writeSessionSummary throws', async () => {
    vi.resetModules();
    vi.doMock('../core/config.js', () => ({
      DATA_DIR: dataDir,
      GROUPS_DIR: groupsDir,
      AGENT_MEMORY_ROOT: memoryRoot,
    }));
    vi.doMock('../memory/agent-memory-root.js', () => ({
      AgentMemoryRootService: {
        getInstance: () => ({
          writeSessionSummary: () => {
            throw new Error('Disk full');
          },
        }),
      },
    }));

    const mod = await import('./session-transcript-archive.js');

    writeTranscript({
      groupFolder: 'team-diskfull',
      sessionId: 'sess-diskfull',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'hi' },
        }),
      ],
    });

    const result = mod.archiveSessionTranscript({
      groupFolder: 'team-diskfull',
      sessionId: 'sess-diskfull',
    });

    expect(result).toBeNull();

    vi.doUnmock('../memory/agent-memory-root.js');
  });

  // ── sanitizeFilename edge cases ──────────────────────────────────────────

  it('sanitizes special characters and truncates to 50 chars for slug', async () => {
    writeTranscript({
      groupFolder: 'team-slug',
      sessionId: 'sess-slug',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'hi' },
        }),
      ],
      sessionsIndex: {
        entries: [
          {
            sessionId: 'sess-slug',
            summary: '  Fix Bug #42 -- Critical!!! Really Long Name That Exceeds Fifty Characters Limit  ',
          },
        ],
      },
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-slug',
      sessionId: 'sess-slug',
    });

    expect(filePath).toBeTruthy();
    // Extract slug from filename: HHMMSS-cause-SLUG.md
    const basename = path.basename(filePath!, '.md');
    const parts = basename.split('-');
    // Remove first part (HHMMSS) and second+third (new-session) to get slug
    const slug = parts.slice(3).join('-');
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  // ── Markdown structure ───────────────────────────────────────────────────

  it('produces properly structured markdown with header, date, and separator', async () => {
    writeTranscript({
      groupFolder: 'team-md',
      sessionId: 'sess-md',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'Question' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: 'Answer' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-md',
      sessionId: 'sess-md',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    // Contains YAML front matter from writeSessionSummary
    expect(md).toContain('session_id: sess-md');
    expect(md).toContain('group_folder: team-md');
    // Contains the markdown body structure
    expect(md).toContain('# Conversation');
    expect(md).toContain('---');
    expect(md).toContain('Archived:');
    expect(md).toContain('**User**: Question');
    expect(md).toContain('**Assistant**: Answer');
  });

  // ── Message ordering ────────────────────────────────────────────────────

  it('preserves message ordering in archived markdown', async () => {
    writeTranscript({
      groupFolder: 'team-order',
      sessionId: 'sess-order',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'First' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: 'Second' },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: 'Third' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-order',
      sessionId: 'sess-order',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    const firstIdx = md.indexOf('First');
    const secondIdx = md.indexOf('Second');
    const thirdIdx = md.indexOf('Third');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  // ── Entry with missing message/content fields ────────────────────────────

  it('handles entry with missing message field', async () => {
    writeTranscript({
      groupFolder: 'team-nomsg',
      sessionId: 'sess-nomsg',
      lines: [
        JSON.stringify({ type: 'user' }),
        JSON.stringify({
          type: 'user',
          message: { content: 'Valid' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-nomsg',
      sessionId: 'sess-nomsg',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md.match(/\*\*User\*\*/g)?.length).toBe(1);
    expect(md).toContain('**User**: Valid');
  });

  it('handles entry with missing content inside message', async () => {
    writeTranscript({
      groupFolder: 'team-nocontent',
      sessionId: 'sess-nocontent',
      lines: [
        JSON.stringify({ type: 'user', message: {} }),
        JSON.stringify({
          type: 'user',
          message: { content: 'Valid' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-nocontent',
      sessionId: 'sess-nocontent',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md.match(/\*\*User\*\*/g)?.length).toBe(1);
  });

  // ── Completely empty transcript file ─────────────────────────────────────

  it('handles a completely empty transcript file', async () => {
    writeTranscript({
      groupFolder: 'team-emptyfile',
      sessionId: 'sess-emptyfile',
      lines: [''],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const result = archiveSessionTranscript({
      groupFolder: 'team-emptyfile',
      sessionId: 'sess-emptyfile',
    });

    expect(result).toBeNull();
  });

  // ── Placeholder uses summary as title when transcript is empty ───────────

  it('placeholder on empty transcript uses summary as title when available', async () => {
    writeTranscript({
      groupFolder: 'team-phsum',
      sessionId: 'sess-phsum',
      lines: [
        JSON.stringify({ type: 'system', message: { content: 'init' } }),
      ],
      sessionsIndex: {
        entries: [
          { sessionId: 'sess-phsum', summary: 'My Task' },
        ],
      },
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-phsum',
      sessionId: 'sess-phsum',
      writePlaceholderOnMissing: true,
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('My Task');
    expect(md).toContain('No valid transcript content was available');
  });

  // ── sessions-index.json with entries: undefined ──────────────────────────

  it('handles sessions-index with no entries array', async () => {
    writeTranscript({
      groupFolder: 'team-noentries',
      sessionId: 'sess-noentries',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: 'hi' },
        }),
      ],
      sessionsIndex: {},
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-noentries',
      sessionId: 'sess-noentries',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).toContain('# Conversation');
  });

  // ── User content with whitespace-only trim ───────────────────────────────

  it('skips user messages with whitespace-only content after trim', async () => {
    writeTranscript({
      groupFolder: 'team-wstrim',
      sessionId: 'sess-wstrim',
      lines: [
        JSON.stringify({
          type: 'user',
          message: { content: '   \n\t  ' },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: 'Real message' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-wstrim',
      sessionId: 'sess-wstrim',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md.match(/\*\*User\*\*/g)?.length).toBe(1);
    expect(md).toContain('**User**: Real message');
  });

  // ── Assistant messages with all non-text parts ───────────────────────────

  it('skips assistant messages where all parts are non-text type', async () => {
    writeTranscript({
      groupFolder: 'team-notext',
      sessionId: 'sess-notext',
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1' },
              { type: 'image', url: 'http://img.png' },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: 'Visible' },
        }),
      ],
    });

    const { archiveSessionTranscript } = await loadArchiveModule();
    const filePath = archiveSessionTranscript({
      groupFolder: 'team-notext',
      sessionId: 'sess-notext',
    });

    expect(filePath).toBeTruthy();
    const md = fs.readFileSync(filePath!, 'utf-8');
    expect(md).not.toContain('**Assistant**');
    expect(md).toContain('**User**: Visible');
  });
});
