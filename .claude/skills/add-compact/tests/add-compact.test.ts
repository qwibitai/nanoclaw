import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('add-compact skill package', () => {
  describe('manifest', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    });

    it('has a valid manifest.yaml', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'manifest.yaml'))).toBe(true);
      expect(content).toContain('skill: add-compact');
      expect(content).toContain('version: 1.0.0');
    });

    it('has no npm dependencies', () => {
      expect(content).toContain('npm_dependencies: {}');
    });

    it('has no env_additions', () => {
      expect(content).toContain('env_additions: []');
    });

    it('lists all add files', () => {
      expect(content).toContain('src/session-commands.ts');
      expect(content).toContain('src/session-commands.test.ts');
    });

    it('lists all modify files', () => {
      expect(content).toContain('src/index.ts');
      expect(content).toContain('container/agent-runner/src/index.ts');
    });

    it('has no dependencies', () => {
      expect(content).toContain('depends: []');
    });
  });

  describe('add/ files', () => {
    it('includes src/session-commands.ts with required exports', () => {
      const filePath = path.join(SKILL_DIR, 'add', 'src', 'session-commands.ts');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function extractSessionCommand');
      expect(content).toContain('export function isSessionCommandAllowed');
      expect(content).toContain("'/compact'");
    });

    it('includes src/session-commands.test.ts with test cases', () => {
      const filePath = path.join(SKILL_DIR, 'add', 'src', 'session-commands.test.ts');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('extractSessionCommand');
      expect(content).toContain('isSessionCommandAllowed');
      expect(content).toContain('detects bare /compact');
      expect(content).toContain('denies untrusted sender');
    });
  });

  describe('modify/ files exist', () => {
    const modifyFiles = [
      'src/index.ts',
      'container/agent-runner/src/index.ts',
    ];

    for (const file of modifyFiles) {
      it(`includes modify/${file}`, () => {
        const filePath = path.join(SKILL_DIR, 'modify', file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  describe('intent files exist', () => {
    const intentFiles = [
      'src/index.ts.intent.md',
      'container/agent-runner/src/index.ts.intent.md',
    ];

    for (const file of intentFiles) {
      it(`includes modify/${file}`, () => {
        const filePath = path.join(SKILL_DIR, 'modify', file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  describe('modify/src/index.ts', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'src', 'index.ts'),
        'utf-8',
      );
    });

    it('imports session command helpers', () => {
      expect(content).toContain("import { extractSessionCommand, isSessionCommandAllowed } from './session-commands.js'");
    });

    it('uses const for missedMessages', () => {
      expect(content).toMatch(/const missedMessages = getMessagesSince/);
    });

    it('has session command interception in processGroupMessages', () => {
      expect(content).toContain('Session command interception (before trigger check)');
      expect(content).toContain('extractSessionCommand(m.content, TRIGGER_PATTERN)');
      expect(content).toContain('isSessionCommandAllowed(isMainGroup');
    });

    it('has authorized path with pre-compact and /compact', () => {
      expect(content).toContain('preCompactMsgs');
      expect(content).toContain('hadPreError');
      expect(content).toContain('preOutputSent');
      expect(content).toContain('hadCmdError');
    });

    it('has denied path with cursor advance and return', () => {
      expect(content).toContain('Session commands require admin access');
      // Denied path advances cursor to /compact timestamp and returns
      expect(content).toContain('silently consume the /compact by advancing the cursor past it');
    });

    it('has session command interception in startMessageLoop', () => {
      expect(content).toContain('Session command interception (message loop)');
      expect(content).toContain('queue.enqueueMessageCheck(chatJid)');
    });

    it('respects sender allowlist in deny path', () => {
      expect(content).toContain('isTriggerAllowed(chatJid, sessionCmdMsg.sender, loadSenderAllowlist())');
    });

    it('preserves core index.ts structure', () => {
      expect(content).toContain('processGroupMessages');
      expect(content).toContain('startMessageLoop');
      expect(content).toContain('async function main()');
      expect(content).toContain('recoverPendingMessages');
      expect(content).toContain('ensureContainerSystemRunning');
    });
  });

  describe('modify/container/agent-runner/src/index.ts', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'container', 'agent-runner', 'src', 'index.ts'),
        'utf-8',
      );
    });

    it('defines KNOWN_SESSION_COMMANDS whitelist', () => {
      expect(content).toContain("KNOWN_SESSION_COMMANDS");
      expect(content).toContain("'/compact'");
    });

    it('uses query() with string prompt for slash commands', () => {
      expect(content).toContain('prompt: trimmedPrompt');
      expect(content).toContain('allowedTools: []');
    });

    it('observes compact_boundary system event', () => {
      expect(content).toContain('compactBoundarySeen');
      expect(content).toContain("'compact_boundary'");
      expect(content).toContain('Compact boundary observed');
    });

    it('handles error subtypes', () => {
      expect(content).toContain("resultSubtype?.startsWith('error')");
    });

    it('registers PreCompact hook for slash commands', () => {
      expect(content).toContain('createPreCompactHook(containerInput.assistantName)');
    });

    it('preserves core agent-runner structure', () => {
      expect(content).toContain('async function runQuery');
      expect(content).toContain('class MessageStream');
      expect(content).toContain('function writeOutput');
      expect(content).toContain('function createPreCompactHook');
      expect(content).toContain('function createSanitizeBashHook');
      expect(content).toContain('async function main');
    });
  });
});
