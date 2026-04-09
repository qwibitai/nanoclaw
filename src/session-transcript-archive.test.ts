import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempRoot = '';
let dataDir = '';
let groupsDir = '';

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
  vi.doMock('./config.js', () => ({
    DATA_DIR: dataDir,
    GROUPS_DIR: groupsDir,
  }));
  return import('./session-transcript-archive.js');
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-archive-'));
  dataDir = path.join(tempRoot, 'data');
  groupsDir = path.join(tempRoot, 'groups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./config.js');
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('archiveSessionTranscript', () => {
  it('archives a valid transcript into groups/<folder>/conversations', async () => {
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
    expect(filePath).toContain(path.join('groups', 'team1', 'conversations'));
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
      /^\d{4}-\d{2}-\d{2}-weekly-status-review\.md$/,
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
      /^\d{4}-\d{2}-\d{2}-conversation-\d{8}-\d{6}\.md$/,
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
    const conversationsDir = path.join(groupsDir, 'team4', 'conversations');
    expect(fs.existsSync(conversationsDir)).toBe(false);
  });
});
