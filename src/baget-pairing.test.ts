/**
 * Renderer + provisioner tests.
 *
 * The renderer is a pure string-substitution function; we cover its
 * sanitization rules (strip control chars, strip markdown emphasis,
 * cap at 60 chars), missing-placeholder failure mode, and the
 * extra-template-placeholder failure mode (template uses
 * `{{newvar}}` but renderer has no value).
 *
 * The provisioner additionally writes files. We point it at a tmp dir
 * via a process.cwd() override.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { provisionBagetGroup, renderBagetClaudeMd } from './baget-pairing.js';

const TEAM = {
  cos: 'Louis',
  developer: 'Valentin',
  marketing: 'Chloé',
  analyst: 'Théo',
  design: 'Nicolas',
  ops: 'Marie',
};

let tmpRoot = '';
let originalCwd = '';

beforeAll(() => {
  originalCwd = process.cwd();
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baget-pair-test-'));
  // The provisioner reads `process.cwd()/setup/baget-template/...` and
  // writes to `process.cwd()/groups/<folder>`. Symlink setup back to the
  // original dir, mkdir groups locally, then chdir.
  fs.symlinkSync(path.join(originalCwd, 'setup'), path.join(tmpRoot, 'setup'));
  fs.mkdirSync(path.join(tmpRoot, 'groups'));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('renderBagetClaudeMd', () => {
  it('substitutes placeholders end-to-end', () => {
    const out = renderBagetClaudeMd({ companyName: 'Acme', teamMembers: TEAM });
    expect(out).toContain('Acme');
    expect(out).toContain('Louis');
    expect(out).toContain('Marie'); // ops member name from TEAM fixture
    expect(out).not.toContain('{{cos_name}}');
    expect(out).not.toContain('{{company_name}}');
  });

  it('throws on missing required placeholder value (empty string)', () => {
    expect(() =>
      renderBagetClaudeMd({
        companyName: '',
        teamMembers: TEAM,
      }),
    ).toThrow(/required placeholder.*empty or missing/);
  });

  it('throws on missing required placeholder value (whitespace-only)', () => {
    expect(() =>
      renderBagetClaudeMd({
        companyName: 'Acme',
        teamMembers: { ...TEAM, cos: '   ' },
      }),
    ).toThrow(/cos_name.*empty or missing/);
  });

  it('throws when template contains an unknown placeholder', () => {
    // Write a custom template with an unknown placeholder.
    const tmpTpl = path.join(tmpRoot, 'broken-template.md');
    fs.writeFileSync(tmpTpl, '# {{company_name}} — {{newvar}}', 'utf8');
    expect(() =>
      renderBagetClaudeMd({
        companyName: 'Acme',
        teamMembers: TEAM,
        templatePath: tmpTpl,
      }),
    ).toThrow(/template uses \{\{newvar\}\}.*no value/);
  });

  it('strips control chars / markdown emphasis from team names', () => {
    const out = renderBagetClaudeMd({
      companyName: 'Acme',
      teamMembers: {
        ...TEAM,
        cos: 'L*o_u`is\nspy',
      },
    });
    expect(out).not.toContain('*o_u`');
    expect(out).not.toContain('\nspy');
    expect(out).toContain('Louis spy'); // newline → space, asterisks/underscores stripped
  });

  it('caps team-name length at 60 chars', () => {
    const long = 'L'.repeat(120);
    const out = renderBagetClaudeMd({
      companyName: 'Acme',
      teamMembers: { ...TEAM, cos: long },
    });
    // Find the cos line; it should contain at most 60 L's.
    expect(out).toContain('L'.repeat(60));
    expect(out).not.toContain('L'.repeat(61));
  });

  describe('partial team — block-level role gating', () => {
    it('renders only CoS when team is apprenti-shaped (cos only)', () => {
      const out = renderBagetClaudeMd({
        companyName: 'Acme',
        teamMembers: { cos: 'Raphaël' },
      });
      expect(out).toContain('Acme');
      expect(out).toContain('Raphaël');
      // Specialists must NOT appear in the rendered prompt — neither
      // their roster bullets, their tag-routing entries, the example
      // exchanges keyed on them, nor the voice descriptions.
      expect(out).not.toContain('Developer');
      expect(out).not.toContain('Marketing');
      expect(out).not.toContain('Analyst');
      expect(out).not.toContain('Designer');
      expect(out).not.toContain('Operations');
      expect(out).not.toContain('💻');
      expect(out).not.toContain('📢');
      expect(out).not.toContain('📊');
      expect(out).not.toContain('🎨');
      expect(out).not.toContain('⚙️');
      // No leftover marker comments either.
      expect(out).not.toMatch(/<!--\/?role:/);
      // No unsubstituted placeholders.
      expect(out).not.toContain('{{');
    });

    it('renders artisan-shaped team (cos + dev + marketing)', () => {
      const out = renderBagetClaudeMd({
        companyName: 'Acme',
        teamMembers: {
          cos: 'Raphaël',
          developer: 'Valentin',
          marketing: 'Chloé',
        },
      });
      expect(out).toContain('Raphaël');
      expect(out).toContain('Valentin');
      expect(out).toContain('Chloé');
      // Developer + marketing roster lines kept; analyst/design/ops dropped.
      expect(out).toContain('💻');
      expect(out).toContain('📢');
      expect(out).not.toContain('📊');
      expect(out).not.toContain('🎨');
      expect(out).not.toContain('⚙️');
      expect(out).not.toMatch(/<!--\/?role:/);
      expect(out).not.toContain('{{');
    });

    it('renders the full team when all six are present (intern not modeled)', () => {
      const out = renderBagetClaudeMd({ companyName: 'Acme', teamMembers: TEAM });
      // All six emojis should appear.
      for (const emoji of ['🧭', '💻', '📢', '📊', '🎨', '⚙️']) {
        expect(out).toContain(emoji);
      }
      // All six names should appear.
      for (const name of Object.values(TEAM)) {
        expect(out).toContain(name);
      }
      expect(out).not.toMatch(/<!--\/?role:/);
      expect(out).not.toContain('{{');
    });

    it('treats explicit empty-string specialist as missing (strips block)', () => {
      const out = renderBagetClaudeMd({
        companyName: 'Acme',
        teamMembers: { cos: 'Raphaël', analyst: '' },
      });
      // Empty analyst string → block stripped, no '📊' bullet, no
      // dangling `analyst:` tag-routing entry referencing the role.
      expect(out).not.toContain('📊');
      expect(out).not.toMatch(/^- `analyst:`/m);
      expect(out).not.toContain('{{');
    });

    it('treats whitespace-only specialist as missing', () => {
      const out = renderBagetClaudeMd({
        companyName: 'Acme',
        teamMembers: { cos: 'Raphaël', developer: '   ' },
      });
      expect(out).not.toContain('💻');
      expect(out).not.toContain('{{');
    });

    it('throws if the template has an orphan role marker (typo / unbalanced)', () => {
      // Simulate a template author error: open marker for `analyst`
      // with no matching close. Anything beyond the open marker would
      // be silently consumed as the block, which is exactly the
      // failure mode the orphan-marker check defends against.
      const tmpTpl = path.join(tmpRoot, 'orphan-marker-template.md');
      fs.writeFileSync(
        tmpTpl,
        '# {{company_name}}\n\n- 🧭 **{{cos_name}}** — CoS\n<!--role:analyst-->\n- 📊 **{{analyst_name}}** — Analyst\n',
        'utf8',
      );
      expect(() =>
        renderBagetClaudeMd({
          companyName: 'Acme',
          teamMembers: { cos: 'Raphaël' },
          templatePath: tmpTpl,
        }),
      ).toThrow(/orphan role marker/);
    });

    it('throws on a close-without-open marker too', () => {
      const tmpTpl = path.join(tmpRoot, 'close-only-template.md');
      fs.writeFileSync(tmpTpl, '# {{company_name}}\n\n- 🧭 **{{cos_name}}** — CoS\n<!--/role:design-->\n', 'utf8');
      expect(() =>
        renderBagetClaudeMd({
          companyName: 'Acme',
          teamMembers: { cos: 'Raphaël' },
          templatePath: tmpTpl,
        }),
      ).toThrow(/orphan role marker/);
    });
  });
});

describe('provisionBagetGroup', () => {
  it('writes CLAUDE.local.md and container.json into the right folder', () => {
    const result = provisionBagetGroup({
      userId: 'aaaaaaaa-1111-1111-1111-111111111111',
      companyId: 'bbbbbbbb-2222-2222-2222-222222222222',
      companyName: 'Acme',
      teamMembers: TEAM,
      bagetApiBaseUrl: 'https://app.baget.ai',
      channelTokenCredentialName: 'baget-channel-token-aaaaaaaa-bbbbbbbb',
    });
    expect(result.folder).toBe('baget-aaaaaaaa-bbbbbbbb');
    expect(fs.existsSync(result.claudeLocalPath)).toBe(true);

    const md = fs.readFileSync(result.claudeLocalPath, 'utf8');
    expect(md).toContain('Acme');
    expect(md).toContain('Louis');

    const cfgPath = path.join(result.groupDir, 'container.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(cfg.provider).toBe('gemini');
    expect(cfg.env.BAGET_API_BASE_URL).toBe('https://app.baget.ai');
    expect(cfg.env.BAGET_COMPANY_ID).toBe('bbbbbbbb-2222-2222-2222-222222222222');
    expect(cfg.secrets).toContain('baget-channel-token-aaaaaaaa-bbbbbbbb');
  });

  it('is idempotent on (userId, companyId) — same folder, refreshed content', () => {
    const args = {
      userId: 'aaaaaaaa-1111-1111-1111-111111111111',
      companyId: 'bbbbbbbb-2222-2222-2222-222222222222',
      companyName: 'Acme',
      teamMembers: TEAM,
      bagetApiBaseUrl: 'https://app.baget.ai',
      channelTokenCredentialName: 'baget-channel-token-aaaaaaaa-bbbbbbbb',
    };
    const first = provisionBagetGroup(args);
    const second = provisionBagetGroup({
      ...args,
      teamMembers: { ...TEAM, cos: 'NewName' },
    });
    expect(second.folder).toBe(first.folder);
    expect(second.claudeLocalPath).toBe(first.claudeLocalPath);
    const md = fs.readFileSync(second.claudeLocalPath, 'utf8');
    expect(md).toContain('NewName');
    expect(md).not.toContain('Louis');
  });
});
