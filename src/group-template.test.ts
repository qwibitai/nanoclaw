import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  parseGitHubJid,
  parseLinearJid,
  writeGroupTemplate,
} from './group-folder.js';

describe('parseGitHubJid', () => {
  it('parses a PR/issue JID', () => {
    expect(parseGitHubJid('gh:cmraible/seb#42')).toEqual({
      repo: 'cmraible/seb',
      number: 42,
    });
  });

  it('parses a repo-level JID', () => {
    expect(parseGitHubJid('gh:cmraible/seb')).toEqual({
      repo: 'cmraible/seb',
      number: undefined,
    });
  });

  it('returns null for non-GitHub JIDs', () => {
    expect(parseGitHubJid('tg:-1001234')).toBeNull();
    expect(parseGitHubJid('120363@g.us')).toBeNull();
  });
});

describe('parseLinearJid', () => {
  it('parses a Linear issue JID', () => {
    expect(parseLinearJid('linear:ENG-123')).toEqual({
      identifier: 'ENG-123',
    });
  });

  it('returns null for non-Linear JIDs', () => {
    expect(parseLinearJid('gh:cmraible/seb#42')).toBeNull();
    expect(parseLinearJid('tg:-1001234')).toBeNull();
  });
});

describe('writeGroupTemplate', () => {
  const testFolder = 'github_test-repo-99';
  const groupDir = path.join(GROUPS_DIR, testFolder);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');

  beforeEach(() => {
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('writes a PR CLAUDE.md for a GitHub PR group', () => {
    writeGroupTemplate(testFolder, 'gh:test/repo#99', {
      type: 'pull_request',
      title: 'Add feature X',
    });
    expect(fs.existsSync(claudeMdPath)).toBe(true);
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('GitHub PR Context');
    expect(content).toContain('test/repo');
    expect(content).toContain('#99');
    expect(content).toContain('Add feature X');
    expect(content).toContain('gh pr view 99 --repo test/repo');
  });

  it('writes an issue CLAUDE.md for a GitHub issue group', () => {
    writeGroupTemplate(testFolder, 'gh:test/repo#99', {
      type: 'issue',
      title: 'Bug report',
    });
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('GitHub Issue Context');
    expect(content).toContain('Bug report');
    expect(content).toContain('gh issue view 99 --repo test/repo');
  });

  it('writes a repo CLAUDE.md for a repo-level group', () => {
    const repoFolder = 'github_test-repo';
    const repoDir = path.join(GROUPS_DIR, repoFolder);
    fs.mkdirSync(path.join(repoDir, 'logs'), { recursive: true });
    try {
      writeGroupTemplate(repoFolder, 'gh:test/repo', { type: 'repo' });
      const content = fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('GitHub Repository Context');
      expect(content).toContain('test/repo');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('defaults to pull_request type when JID has a number and no type metadata', () => {
    writeGroupTemplate(testFolder, 'gh:test/repo#99');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('GitHub PR Context');
  });

  it('does not overwrite an existing CLAUDE.md', () => {
    fs.writeFileSync(claudeMdPath, 'custom instructions');
    writeGroupTemplate(testFolder, 'gh:test/repo#99', {
      type: 'pull_request',
    });
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe('custom instructions');
  });

  it('does nothing when no JID is provided', () => {
    writeGroupTemplate(testFolder);
    expect(fs.existsSync(claudeMdPath)).toBe(false);
  });

  it('does nothing for non-GitHub JIDs', () => {
    writeGroupTemplate(testFolder, 'tg:-1001234');
    expect(fs.existsSync(claudeMdPath)).toBe(false);
  });

  it('writes a Linear issue CLAUDE.md', () => {
    const linearFolder = 'linear_eng-50';
    const linearDir = path.join(GROUPS_DIR, linearFolder);
    fs.mkdirSync(path.join(linearDir, 'logs'), { recursive: true });
    try {
      writeGroupTemplate(linearFolder, 'linear:ENG-50', {
        type: 'issue',
        title: 'Fix login bug',
        status: 'In Progress',
        priority: '2',
        team: 'ENG',
        assignee: 'Seb',
        url: 'https://linear.app/test/issue/ENG-50',
        description: 'The login page crashes when...',
      });
      const content = fs.readFileSync(
        path.join(linearDir, 'CLAUDE.md'),
        'utf-8',
      );
      expect(content).toContain('Linear Issue: ENG-50');
      expect(content).toContain('Fix login bug');
      expect(content).toContain('In Progress');
      expect(content).toContain('High');
      expect(content).toContain('ENG');
      expect(content).toContain('Seb');
      expect(content).toContain('The login page crashes when...');
      expect(content).toContain('mcp__linear__');
    } finally {
      fs.rmSync(linearDir, { recursive: true, force: true });
    }
  });

  it('does nothing for non-matching folder patterns', () => {
    const nonGhFolder = 'telegram_dev-team';
    const nonGhDir = path.join(GROUPS_DIR, nonGhFolder);
    fs.mkdirSync(path.join(nonGhDir, 'logs'), { recursive: true });
    try {
      writeGroupTemplate(nonGhFolder, 'tg:-1001234');
      expect(fs.existsSync(path.join(nonGhDir, 'CLAUDE.md'))).toBe(false);
    } finally {
      fs.rmSync(nonGhDir, { recursive: true, force: true });
    }
  });
});
