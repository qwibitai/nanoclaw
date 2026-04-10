import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../core/logger.js', () => ({
  logger: {
    info: loggerSpies.info,
    warn: loggerSpies.warn,
  },
}));

import { PromptProfileService } from './prompt-profile.js';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-prompt-profile-'));
}

function profileWithAllSections(extra = ''): string {
  return `# CLAUDE.md\n\n## Identity\nIdentity text\n\n## Voice\nVoice text\n\n## Operating Rules\nOperating rules text\n\n## User Preferences\nUser preferences text\n\n## Privacy Rules\nPrivacy rules text\n\n## Tool Conventions\nTool conventions text\n${extra}`;
}

describe('PromptProfileService', () => {
  const roots: string[] = [];

  afterEach(() => {
    loggerSpies.warn.mockReset();
    loggerSpies.info.mockReset();
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('seeds only CLAUDE.md and preserves existing config files', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'sender-allowlist.json'), '{"ok":true}');

    const service = new PromptProfileService({ configDir, groupsDir });
    service.ensureSeedFiles();

    expect(fs.existsSync(path.join(configDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'SOUL.md'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'TOOLS.md'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'USER.md'))).toBe(false);
    expect(
      fs.readFileSync(path.join(configDir, 'sender-allowlist.json'), 'utf-8'),
    ).toBe('{"ok":true}');
  });

  it('compiles deterministic order: runtime rules, personal profile, global and group context', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), profileWithAllSections());
    writeFile(path.join(groupsDir, 'global', 'CLAUDE.md'), 'global context');
    writeFile(path.join(groupsDir, 'team', 'CLAUDE.md'), 'group context');

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt.indexOf('[[RUNTIME_RULES]]')).toBeLessThan(
      prompt.indexOf('[[PERSONAL_PROFILE]]'),
    );
    expect(prompt.indexOf('[[PERSONAL_PROFILE]]')).toBeLessThan(
      prompt.indexOf('[[GLOBAL_CONTEXT]]'),
    );
    expect(prompt.indexOf('[[GLOBAL_CONTEXT]]')).toBeLessThan(
      prompt.indexOf('[[GROUP_CONTEXT]]'),
    );
    expect(prompt).toContain('## Identity');
    expect(prompt).toContain('## Tool Conventions');
  });

  it('uses only expected CLAUDE sections and ignores extra persona files', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(
      path.join(configDir, 'CLAUDE.md'),
      profileWithAllSections('\n\n## Extra\nshould not be included\n'),
    );
    writeFile(path.join(configDir, 'SOUL.md'), 'soul must never be injected');
    writeFile(path.join(configDir, 'TOOLS.md'), 'tools must never be injected');
    writeFile(path.join(configDir, 'USER.md'), 'user must never be injected');

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt).toContain('Identity text');
    expect(prompt).not.toContain('soul must never be injected');
    expect(prompt).not.toContain('tools must never be injected');
    expect(prompt).not.toContain('user must never be injected');
    expect(prompt).not.toContain('should not be included');
  });

  it('keeps nested headings inside the expected parent section body', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(
      path.join(configDir, 'CLAUDE.md'),
      profileWithAllSections(
        '\n## Operating Rules\nTop rules\n### Edge Cases\nNested rule details\n',
      ),
    );

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt).toContain('Top rules');
    expect(prompt).toContain('### Edge Cases');
    expect(prompt).toContain('Nested rule details');
  });

  it('logs missing section diagnostics and never injects [MISSING] markers', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(
      path.join(configDir, 'CLAUDE.md'),
      '# CLAUDE.md\n\n## Identity\nOnly one section present',
    );

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(loggerSpies.warn).toHaveBeenCalled();
    expect(prompt).not.toContain('[MISSING]');
  });

  it('enforces hard budget caps for personal profile and total static prompt', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    const hugeText = 'x'.repeat(2000);
    writeFile(
      path.join(configDir, 'CLAUDE.md'),
      `# CLAUDE.md\n\n## Identity\n${hugeText}\n\n## Voice\n${hugeText}\n\n## Operating Rules\n${hugeText}\n\n## User Preferences\n${hugeText}\n\n## Privacy Rules\n${hugeText}\n\n## Tool Conventions\n${hugeText}`,
    );
    writeFile(path.join(groupsDir, 'global', 'CLAUDE.md'), 'g'.repeat(4000));
    writeFile(path.join(groupsDir, 'team', 'CLAUDE.md'), 't'.repeat(4000));

    const service = new PromptProfileService({
      configDir,
      groupsDir,
      sectionBudgets: {
        PERSONAL_PROFILE: 600,
        GLOBAL_CONTEXT: 200,
        GROUP_CONTEXT: 200,
      },
      totalBudget: 1000,
    });

    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt.length).toBeLessThanOrEqual(1000);
    expect(prompt).toContain('[[PERSONAL_PROFILE]]');
  });
});
