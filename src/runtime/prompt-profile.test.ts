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

import {
  PromptProfileService,
  getPromptProfileService,
  ensurePromptProfileBootstrapped,
} from './prompt-profile.js';

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
    expect(prompt).toContain('source: nanoclaw://personal-profile');
    expect(prompt).toContain('source: nanoclaw://global-context');
    expect(prompt).toContain('source: nanoclaw://group-context');
    expect(prompt).not.toContain(root);
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

  // --- Coverage for readPlainSection catch branch (lines 314-318) ---

  it('returns null when context file read fails with permission error', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), profileWithAllSections());

    // Create the group context file then make it unreadable
    const groupContextPath = path.join(groupsDir, 'team', 'CLAUDE.md');
    writeFile(groupContextPath, 'group context content');
    // Replace the file with a directory to force a read error
    fs.unlinkSync(groupContextPath);
    fs.mkdirSync(groupContextPath, { recursive: true });

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // Should compile without GROUP_CONTEXT since the file read failed
    expect(prompt).toContain('[[RUNTIME_RULES]]');
    expect(prompt).toContain('[[PERSONAL_PROFILE]]');
    // The read error should have been logged
    expect(loggerSpies.warn).toHaveBeenCalled();
  });

  // --- Coverage for getPromptProfileService / ensurePromptProfileBootstrapped (lines 349-355) ---

  it('getPromptProfileService returns a singleton instance', () => {
    const service = getPromptProfileService();
    expect(service).toBeInstanceOf(PromptProfileService);
    // Calling again should return the same instance
    expect(getPromptProfileService()).toBe(service);
  });

  it('ensurePromptProfileBootstrapped calls ensureSeedFiles on default instance', () => {
    // This should not throw — exercises lines 353-354
    expect(() => ensurePromptProfileBootstrapped()).not.toThrow();
  });

  // --- Coverage for readGroupContextSection with invalid group folder ---

  it('skips invalid group folder names in context section', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), profileWithAllSections());

    const service = new PromptProfileService({ configDir, groupsDir });
    // Use an invalid group folder name (e.g., with path traversal)
    const prompt = service.compileSystemPrompt({ groupFolder: '../../../etc' });

    // Should still compile without GROUP_CONTEXT
    expect(prompt).toContain('[[RUNTIME_RULES]]');
    expect(prompt).not.toContain('[[GROUP_CONTEXT]]');
    expect(loggerSpies.warn).toHaveBeenCalled();
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

  it('handles very small totalBudget by truncating sections', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), profileWithAllSections());
    writeFile(path.join(groupsDir, 'global', 'CLAUDE.md'), 'global context');
    writeFile(path.join(groupsDir, 'team', 'CLAUDE.md'), 'group context');

    // With a very small budget, only a portion of the first section fits
    const service = new PromptProfileService({
      configDir,
      groupsDir,
      totalBudget: 50,
    });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });
    expect(prompt.length).toBeLessThanOrEqual(50);
    // Should still start with the runtime rules marker
    expect(prompt).toContain('[[RUNTIME_RULES]]');
  });

  it('handles profile with ## headings that do not match any expected section', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    // Profile has headings, but none match expected sections
    writeFile(
      path.join(configDir, 'CLAUDE.md'),
      '# CLAUDE.md\n\n## Random Section\nSome text\n\n## Another Section\nMore text',
    );

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // When no expected headings match (matchedCount === 0), falls back to raw profile
    expect(prompt).toContain('Random Section');
    expect(prompt).toContain('Another Section');
    expect(loggerSpies.warn).toHaveBeenCalled();
  });

  it('handles personal profile that is only whitespace after normalization', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), '   \n\n  \r\n  ');

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // Should have runtime rules but no personal profile
    expect(prompt).toContain('[[RUNTIME_RULES]]');
    expect(prompt).not.toContain('[[PERSONAL_PROFILE]]');
  });

  it('handles personal profile read failure gracefully', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    // Create the CLAUDE.md path as a directory to cause readFileSync to throw
    const profilePath = path.join(configDir, 'CLAUDE.md');
    fs.mkdirSync(profilePath, { recursive: true });

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // Should have runtime rules but no personal profile
    expect(prompt).toContain('[[RUNTIME_RULES]]');
    expect(prompt).not.toContain('[[PERSONAL_PROFILE]]');
    expect(loggerSpies.warn).toHaveBeenCalled();
  });

  it('handles global context file that is only whitespace', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), profileWithAllSections());
    writeFile(path.join(groupsDir, 'global', 'CLAUDE.md'), '   \n  ');

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // Should not contain global context section since content is empty
    expect(prompt).not.toContain('[[GLOBAL_CONTEXT]]');
  });

  it('handles profile section with empty body using placeholder text', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    // Profile where Identity section has an empty body
    writeFile(
      path.join(configDir, 'CLAUDE.md'),
      '# CLAUDE.md\n\n## Identity\n\n## Voice\nVoice text\n\n## Operating Rules\nRules\n\n## User Preferences\nPrefs\n\n## Privacy Rules\nPrivacy\n\n## Tool Conventions\nTools',
    );

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // Empty section body should use the placeholder
    expect(prompt).toContain('_No details provided._');
  });

  it('does not seed CLAUDE.md if it already exists', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    const existingContent = '# My Custom Profile\n\n## Identity\nCustom identity';
    writeFile(path.join(configDir, 'CLAUDE.md'), existingContent);

    const service = new PromptProfileService({ configDir, groupsDir });
    service.ensureSeedFiles();

    // Should preserve existing content, not overwrite with template
    const content = fs.readFileSync(path.join(configDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe(existingContent);
  });

  it('compiles prompt with only runtime rules when no other sections exist', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    // Don't create any CLAUDE.md files
    fs.mkdirSync(configDir, { recursive: true });

    const service = new PromptProfileService({ configDir, groupsDir });
    // Delete the auto-seeded file after ensureSeedFiles runs
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // Should at minimum have runtime rules and the seeded personal profile
    expect(prompt).toContain('[[RUNTIME_RULES]]');
  });

  it('handles CRLF line endings in personal profile', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(
      path.join(configDir, 'CLAUDE.md'),
      '# CLAUDE.md\r\n\r\n## Identity\r\nIdentity text\r\n\r\n## Voice\r\nVoice text\r\n\r\n## Operating Rules\r\nRules\r\n\r\n## User Preferences\r\nPrefs\r\n\r\n## Privacy Rules\r\nPrivacy\r\n\r\n## Tool Conventions\r\nTools',
    );

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // CRLF should be normalized and sections parsed correctly
    expect(prompt).toContain('Identity text');
    expect(prompt).toContain('Voice text');
  });

  it('handles profile with no ## headings at all (plain text fallback)', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    // Profile with content but zero ## headings → parseMarkdownSections returns []
    // → renderPersonalProfileBody hits the parsed.length === 0 branch (line 128)
    writeFile(
      path.join(configDir, 'CLAUDE.md'),
      'Plain text profile with no markdown headings at all.\nJust paragraphs.',
    );

    const service = new PromptProfileService({ configDir, groupsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt).toContain('Plain text profile');
    expect(loggerSpies.warn).toHaveBeenCalled();
  });

  it('returns null when personal profile budget is zero (line 258)', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), profileWithAllSections());

    const service = new PromptProfileService({
      configDir,
      groupsDir,
      sectionBudgets: {
        PERSONAL_PROFILE: 0,
        GLOBAL_CONTEXT: 2000,
        GROUP_CONTEXT: 2000,
      },
    });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // Personal profile should be absent since budget is 0
    expect(prompt).not.toContain('[[PERSONAL_PROFILE]]');
    expect(prompt).toContain('[[RUNTIME_RULES]]');
  });

  it('returns null when context section truncates to empty (line 306)', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), profileWithAllSections());
    writeFile(path.join(groupsDir, 'global', 'CLAUDE.md'), 'global content');

    const service = new PromptProfileService({
      configDir,
      groupsDir,
      sectionBudgets: {
        PERSONAL_PROFILE: 2000,
        GLOBAL_CONTEXT: 0,
        GROUP_CONTEXT: 2000,
      },
    });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    // Global context should be absent since budget is 0
    expect(prompt).not.toContain('[[GLOBAL_CONTEXT]]');
  });

  it('breaks out of compose loop when remaining budget is too small (line 339)', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), profileWithAllSections());
    writeFile(path.join(groupsDir, 'global', 'CLAUDE.md'), 'global context');
    writeFile(path.join(groupsDir, 'team', 'CLAUDE.md'), 'group context');

    // totalBudget just large enough for runtime rules, too small for anything else
    const service = new PromptProfileService({
      configDir,
      groupsDir,
      totalBudget: 50,
    });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt.length).toBeLessThanOrEqual(50);
  });

  it('truncates total prompt exactly at totalBudget when sections exceed budget', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const groupsDir = path.join(root, 'groups');

    writeFile(path.join(configDir, 'CLAUDE.md'), profileWithAllSections());
    writeFile(path.join(groupsDir, 'global', 'CLAUDE.md'), 'g'.repeat(5000));
    writeFile(path.join(groupsDir, 'team', 'CLAUDE.md'), 't'.repeat(5000));

    // Tiny totalBudget
    const service = new PromptProfileService({
      configDir,
      groupsDir,
      totalBudget: 100,
    });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt.length).toBeLessThanOrEqual(100);
  });
});
