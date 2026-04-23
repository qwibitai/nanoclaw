import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('icloud-tools skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  describe('SKILL.md', () => {
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    it('exists', () => {
      expect(fs.existsSync(skillMdPath)).toBe(true);
    });

    it('has correct frontmatter', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('name: icloud-tools');
      expect(content).toContain('description:');
    });

    it('documents all 4 modules', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('calendar');
      expect(content).toContain('contacts');
      expect(content).toContain('mail');
      expect(content).toContain('notes');
    });

    it('documents required env vars', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('ICLOUD_EMAIL');
      expect(content).toContain('ICLOUD_APP_PASSWORD');
      expect(content).toContain('ICLOUD_SENDER_EMAIL');
      expect(content).toContain('ICLOUD_MODULES');
    });

    it('documents server path', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('/opt/icloud-tools/dist/server.js');
    });

    it('has pre-flight check for already-applied state', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('state.yaml');
      expect(content).toContain('applied_skills');
    });

    it('has apply command', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('apply-skill.ts .claude/skills/icloud-tools');
    });

    it('has validate step', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('npm test');
      expect(content).toContain('npm run build');
    });

    it('has container rebuild instruction', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('./build.sh');
    });

    it('has restart instructions for both macOS and Linux', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('launchctl');
      expect(content).toContain('systemctl');
    });

    it('has log check command', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('nanoclaw.log');
      expect(content).toContain('icloud');
    });

    it('has configuration table', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('| Variable |');
      expect(content).toContain('| `ICLOUD_EMAIL`');
      expect(content).toContain('| `ICLOUD_APP_PASSWORD`');
      expect(content).toContain('| `ICLOUD_MODULES`');
    });

    it('has troubleshooting section', () => {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      expect(content).toContain('Troubleshooting');
      expect(content).toContain('Auth failed');
      expect(content).toContain('read-only');
    });
  });

  describe('manifest.yaml', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');

    it('exists', () => {
      expect(fs.existsSync(manifestPath)).toBe(true);
    });

    it('has correct skill name, version, description', () => {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      expect(content).toContain('skill: icloud-tools');
      expect(content).toContain('version: 1.1.0');
      expect(content).toContain('description:');
    });

    it('declares all 3 env_additions', () => {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      expect(content).toContain('ICLOUD_EMAIL');
      expect(content).toContain('ICLOUD_APP_PASSWORD');
      expect(content).toContain('ICLOUD_SENDER_EMAIL');
    });

    it('has conflicts: []', () => {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      expect(content).toContain('conflicts: []');
    });

    it('has depends: []', () => {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      expect(content).toContain('depends: []');
    });

    it('has a test command with a skill-local config (no root-level config file)', () => {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      expect(content).toContain('test:');
      expect(content).toContain('icloud-tools');
      // If --config is used, it must point inside .claude/skills/ (not a root-level file)
      if (content.includes('--config')) {
        expect(content).toContain('--config .claude/skills/icloud-tools');
      }
    });

    it('lists all 9 added files', () => {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      expect(content).toContain('container/icloud-tools/package.json');
      expect(content).toContain('container/icloud-tools/tsconfig.json');
      expect(content).toContain('container/icloud-tools/src/server.ts');
      expect(content).toContain('container/icloud-tools/src/auth.ts');
      expect(content).toContain('container/icloud-tools/src/types.ts');
      expect(content).toContain('container/icloud-tools/src/modules/calendar.ts');
      expect(content).toContain('container/icloud-tools/src/modules/contacts.ts');
      expect(content).toContain('container/icloud-tools/src/modules/mail.ts');
      expect(content).toContain('container/icloud-tools/src/modules/notes.ts');
    });

    it('lists exactly 3 modified files (not ipc.ts or ipc-mcp-stdio.ts)', () => {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      expect(content).toContain('container/Dockerfile');
      expect(content).toContain('src/container-runner.ts');
      expect(content).toContain('container/agent-runner/src/index.ts');
      expect(content).not.toContain('ipc.ts');
      expect(content).not.toContain('ipc-mcp-stdio.ts');
      // Count modifies entries
      const modifiesSection = content.split('modifies:')[1]?.split('structured:')[0] || '';
      const modifyLines = modifiesSection.split('\n').filter(l => l.trim().startsWith('-'));
      expect(modifyLines).toHaveLength(3);
    });

    it('has no removes section', () => {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      expect(content).not.toContain('removes:');
    });
  });

  describe('add/ files', () => {
    const addDir = path.join(skillDir, 'add');

    it('all 9 add/ files exist', () => {
      const expectedFiles = [
        'container/icloud-tools/package.json',
        'container/icloud-tools/tsconfig.json',
        'container/icloud-tools/src/server.ts',
        'container/icloud-tools/src/auth.ts',
        'container/icloud-tools/src/types.ts',
        'container/icloud-tools/src/modules/calendar.ts',
        'container/icloud-tools/src/modules/contacts.ts',
        'container/icloud-tools/src/modules/mail.ts',
        'container/icloud-tools/src/modules/notes.ts',
      ];
      for (const file of expectedFiles) {
        expect(fs.existsSync(path.join(addDir, file)), `Missing: ${file}`).toBe(true);
      }
    });

    it('auth.ts uses tsdav and nodemailer', () => {
      const content = fs.readFileSync(path.join(addDir, 'container/icloud-tools/src/auth.ts'), 'utf-8');
      expect(content).toContain('tsdav');
      expect(content).toContain('nodemailer');
    });

    it('auth.ts contains ICLOUD_SENDER_EMAIL and exports getSmtpTransport', () => {
      const content = fs.readFileSync(path.join(addDir, 'container/icloud-tools/src/auth.ts'), 'utf-8');
      expect(content).toContain('ICLOUD_SENDER_EMAIL');
      expect(content).toContain('export function getSmtpTransport');
    });

    it('server.ts contains ICLOUD_MODULES and MODULE_LOADERS', () => {
      const content = fs.readFileSync(path.join(addDir, 'container/icloud-tools/src/server.ts'), 'utf-8');
      expect(content).toContain('ICLOUD_MODULES');
      expect(content).toContain('MODULE_LOADERS');
    });

    it('server.ts has graceful shutdown handlers', () => {
      const content = fs.readFileSync(path.join(addDir, 'container/icloud-tools/src/server.ts'), 'utf-8');
      expect(content).toContain('SIGINT');
      expect(content).toContain('SIGTERM');
    });

    it('calendar.ts uses CalDAV CRUD operations', () => {
      const content = fs.readFileSync(path.join(addDir, 'container/icloud-tools/src/modules/calendar.ts'), 'utf-8');
      expect(content).toContain('createCalendarObject');
      expect(content).toContain('updateCalendarObject');
      expect(content).toContain('deleteCalendarObject');
    });

    it('contacts.ts uses CardDAV operations', () => {
      const content = fs.readFileSync(path.join(addDir, 'container/icloud-tools/src/modules/contacts.ts'), 'utf-8');
      expect(content).toContain('createVCard');
      expect(content).toContain('updateVCard');
    });

    it('mail.ts uses IMAP client and SMTP transport', () => {
      const content = fs.readFileSync(path.join(addDir, 'container/icloud-tools/src/modules/mail.ts'), 'utf-8');
      expect(content).toContain('getImapClient');
      expect(content).toContain('getSmtpTransport');
    });

    it('mail.ts exports a send handler', () => {
      const content = fs.readFileSync(path.join(addDir, 'container/icloud-tools/src/modules/mail.ts'), 'utf-8');
      expect(content).toContain('export async function handleSend');
    });

    it('notes.ts is read-only (no write operations)', () => {
      const content = fs.readFileSync(path.join(addDir, 'container/icloud-tools/src/modules/notes.ts'), 'utf-8');
      expect(content).toContain('getImapClient');
      // Notes module must not contain write operations
      expect(content).not.toContain('append(');
      expect(content).not.toContain('messageDelete');
      expect(content).not.toContain('messageFlagsAdd');
    });
  });

  describe('modify/ files', () => {
    const modifyDir = path.join(skillDir, 'modify');

    it('all 3 modify/ files exist', () => {
      expect(fs.existsSync(path.join(modifyDir, 'container/Dockerfile'))).toBe(true);
      expect(fs.existsSync(path.join(modifyDir, 'src/container-runner.ts'))).toBe(true);
      expect(fs.existsSync(path.join(modifyDir, 'container/agent-runner/src/index.ts'))).toBe(true);
    });

    it('all 3 intent files exist and mention Invariants', () => {
      const intentFiles = [
        'container/Dockerfile.intent.md',
        'src/container-runner.ts.intent.md',
        'container/agent-runner/src/index.ts.intent.md',
      ];
      for (const file of intentFiles) {
        const filePath = path.join(modifyDir, file);
        expect(fs.existsSync(filePath), `Missing: ${file}`).toBe(true);
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content, `${file} must mention Invariants`).toContain('Invariants');
      }
    });

    it('Dockerfile contains icloud-tools build steps at /opt/icloud-tools', () => {
      const content = fs.readFileSync(path.join(modifyDir, 'container/Dockerfile'), 'utf-8');
      expect(content).toContain('icloud-tools');
      expect(content).toContain('/opt/icloud-tools');
      expect(content).toContain('npm prune');
    });

    it('Dockerfile does not contain unrelated tools', () => {
      const content = fs.readFileSync(path.join(modifyDir, 'container/Dockerfile'), 'utf-8');
      expect(content).not.toContain('vanta');
      expect(content).not.toContain('pdf-reader');
      expect(content).not.toContain('apple-reminders');
      expect(content).not.toContain('python3');
    });

    it('agent-runner index.ts allows icloud-tools MCP tools', () => {
      const content = fs.readFileSync(path.join(modifyDir, 'container/agent-runner/src/index.ts'), 'utf-8');
      expect(content).toContain("'mcp__icloud-tools__*'");
    });

    it('agent-runner index.ts protects ICLOUD_APP_PASSWORD in SECRET_ENV_VARS', () => {
      const content = fs.readFileSync(path.join(modifyDir, 'container/agent-runner/src/index.ts'), 'utf-8');
      expect(content).toContain("'ICLOUD_APP_PASSWORD'");
    });

    it('agent-runner index.ts does not contain unrelated credentials', () => {
      const content = fs.readFileSync(path.join(modifyDir, 'container/agent-runner/src/index.ts'), 'utf-8');
      expect(content).not.toContain('GOOGLE_OAUTH');
      expect(content).not.toContain('pushMultimodal');
      expect(content).not.toContain('ContentBlock');
    });

    it('container-runner.ts contains all 3 iCloud secrets in readSecrets()', () => {
      const content = fs.readFileSync(path.join(modifyDir, 'src/container-runner.ts'), 'utf-8');
      expect(content).toContain("'ICLOUD_EMAIL'");
      expect(content).toContain("'ICLOUD_APP_PASSWORD'");
      expect(content).toContain("'ICLOUD_SENDER_EMAIL'");
    });

    it('container-runner.ts does not contain unrelated secrets', () => {
      const content = fs.readFileSync(path.join(modifyDir, 'src/container-runner.ts'), 'utf-8');
      expect(content).not.toContain('GOOGLE_OAUTH');
      expect(content).not.toContain('imageAttachments');
    });
  });

  it('mail.ts uses marked for HTML rendering', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'icloud-tools', 'src', 'modules', 'mail.ts'),
      'utf-8',
    );
    expect(content).toContain("import { marked } from 'marked'");
    expect(content).toContain('renderHtml');
    expect(content).toContain('html:');
  });

  it('mail.ts marks messages as read on fetch', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'icloud-tools', 'src', 'modules', 'mail.ts'),
      'utf-8',
    );
    expect(content).toContain("messageFlagsAdd(params.id, ['\\\\Seen']");
  });

  it('mail.ts saves sent emails to Sent Messages', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'icloud-tools', 'src', 'modules', 'mail.ts'),
      'utf-8',
    );
    expect(content).toContain("'Sent Messages'");
    const matches = content.match(/Sent Messages/g);
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  it('package.json includes marked dependency', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'icloud-tools', 'package.json'),
      'utf-8',
    );
    expect(content).toContain('"marked"');
  });
});
