import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildAllowedTools,
  buildContainerSecurityRules,
  buildReadonlyOverlays,
  getDefaultPolicy,
  isSenderTrusted,
  loadSecurityPolicy,
  readKillswitch,
} from './security-policy.js';

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  const filePath = path.join(dir, 'security-policy.json');
  fs.writeFileSync(filePath, content);
  return filePath;
}

// --- loadSecurityPolicy ---

describe('loadSecurityPolicy', () => {
  it('returns defaults when file does not exist', () => {
    const policy = loadSecurityPolicy('/nonexistent/path.json');
    expect(policy.webfetch.https_only).toBe(true);
    expect(policy.bash.blocked_patterns.length).toBeGreaterThan(0);
  });

  it('returns defaults when file is empty object', () => {
    const p = tmpFile('{}');
    const policy = loadSecurityPolicy(p);
    expect(policy.bash.blocked_patterns.length).toBeGreaterThan(0);
    expect(policy.webfetch.blocked_networks.length).toBeGreaterThan(0);
  });

  it('merges user arrays with defaults (appends)', () => {
    const p = tmpFile(
      JSON.stringify({
        bash: { blocked_patterns: ['\\bcustom\\b'] },
      }),
    );
    const policy = loadSecurityPolicy(p);
    // Has both defaults and custom
    expect(policy.bash.blocked_patterns).toContain('\\bcustom\\b');
    expect(policy.bash.blocked_patterns).toContain('\\bprintenv\\b');
  });

  it('replaces owner_ids (not appends)', () => {
    const p = tmpFile(
      JSON.stringify({
        trust: { owner_ids: ['user-123'] },
      }),
    );
    const policy = loadSecurityPolicy(p);
    expect(policy.trust.owner_ids).toEqual(['user-123']);
  });

  it('throws on malformed JSON', () => {
    const p = tmpFile('not json');
    expect(() => loadSecurityPolicy(p)).toThrow('invalid JSON');
  });

  it('throws on non-object root', () => {
    const p = tmpFile('"string"');
    expect(() => loadSecurityPolicy(p)).toThrow('root must be an object');
  });

  it('throws on invalid regex in blocked_patterns', () => {
    const p = tmpFile(
      JSON.stringify({
        bash: { blocked_patterns: ['(unclosed'] },
      }),
    );
    expect(() => loadSecurityPolicy(p)).toThrow('invalid regex');
  });

  it('overrides boolean settings', () => {
    const p = tmpFile(
      JSON.stringify({
        webfetch: { https_only: false },
      }),
    );
    const policy = loadSecurityPolicy(p);
    expect(policy.webfetch.https_only).toBe(false);
  });

  it('overrides killswitch message', () => {
    const p = tmpFile(
      JSON.stringify({
        killswitch: { message: 'Custom shutdown message' },
      }),
    );
    const policy = loadSecurityPolicy(p);
    expect(policy.killswitch.message).toBe('Custom shutdown message');
  });
});

// --- getDefaultPolicy ---

describe('getDefaultPolicy', () => {
  it('bash patterns include env dump protection', () => {
    const policy = getDefaultPolicy();
    const joined = policy.bash.blocked_patterns.join(' ');
    expect(joined).toContain('printenv');
    expect(joined).toContain('environ');
    expect(joined).toContain('process\\.env');
    expect(joined).toContain('os\\.environ');
  });

  it('webfetch defaults to https_only', () => {
    expect(getDefaultPolicy().webfetch.https_only).toBe(true);
  });

  it('webfetch blocks RFC1918 and loopback', () => {
    const networks = getDefaultPolicy().webfetch.blocked_networks.join(' ');
    expect(networks).toContain('127');
    expect(networks).toContain('10');
    expect(networks).toContain('192\\.168');
    expect(networks).toContain('::1');
  });

  it('write always blocks CLAUDE.md and settings.json', () => {
    const paths = getDefaultPolicy().write.blocked_paths.join(' ');
    expect(paths).toContain('CLAUDE');
    expect(paths).toContain('settings');
  });

  it('personality and skill files require trust by default', () => {
    const paths = getDefaultPolicy().write.trust_required_paths.join(' ');
    expect(paths).toContain('skills');
    expect(paths).toContain('SOUL');
    expect(paths).toContain('TOOLS');
    expect(paths).toContain('IDENTITY');
    expect(paths).toContain('MEMORY');
  });

  it('tools.blocked is empty by default', () => {
    expect(getDefaultPolicy().tools.blocked).toEqual([]);
  });
});

// --- isSenderTrusted ---

describe('isSenderTrusted', () => {
  it('returns true for ID in owner_ids', () => {
    const policy = getDefaultPolicy();
    policy.trust.owner_ids = ['user-123', 'user-456'];
    expect(isSenderTrusted(policy, 'user-123')).toBe(true);
  });

  it('returns false for unknown ID', () => {
    const policy = getDefaultPolicy();
    policy.trust.owner_ids = ['user-123'];
    expect(isSenderTrusted(policy, 'user-999')).toBe(false);
  });

  it('returns false when owner_ids is empty', () => {
    const policy = getDefaultPolicy();
    expect(isSenderTrusted(policy, 'anyone')).toBe(false);
  });
});

// --- buildAllowedTools ---

describe('buildAllowedTools', () => {
  it('returns full tool list when nothing blocked', () => {
    const tools = buildAllowedTools(getDefaultPolicy());
    expect(tools).toContain('Bash');
    expect(tools).toContain('Task');
    expect(tools).toContain('mcp__nanoclaw__*');
  });

  it('excludes blocked tools', () => {
    const policy = getDefaultPolicy();
    policy.tools.blocked = ['Task', 'TeamCreate'];
    const tools = buildAllowedTools(policy);
    expect(tools).not.toContain('Task');
    expect(tools).not.toContain('TeamCreate');
    expect(tools).toContain('Bash');
  });
});

// --- buildContainerSecurityRules ---

describe('buildContainerSecurityRules', () => {
  it('serializes bash patterns', () => {
    const rules = buildContainerSecurityRules(getDefaultPolicy());
    expect(rules.bash.blocked.length).toBeGreaterThan(0);
    expect(rules.bash.blocked).toContain('\\bprintenv\\b');
  });

  it('serializes webfetch config', () => {
    const rules = buildContainerSecurityRules(getDefaultPolicy());
    expect(rules.webfetch.httpsOnly).toBe(true);
    expect(rules.webfetch.blockedNetworks.length).toBeGreaterThan(0);
  });

  it('serializes write paths', () => {
    const rules = buildContainerSecurityRules(getDefaultPolicy());
    expect(rules.write.blocked.length).toBeGreaterThan(0);
  });

  it('serializes tools.blockedUntrusted', () => {
    const policy = getDefaultPolicy();
    policy.tools.blocked_untrusted = ['mcp__memory__write'];
    const rules = buildContainerSecurityRules(policy);
    expect(rules.tools.blockedUntrusted).toContain('mcp__memory__write');
  });
});

// --- canUseTool behavior (via serialized rules) ---

describe('canUseTool (default rules)', () => {
  // Helper: simulate canUseTool with default policy rules
  function testCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    trusted = false,
    extraRules?: Partial<ReturnType<typeof buildContainerSecurityRules>>,
  ): { allowed: boolean } {
    const rules = {
      ...buildContainerSecurityRules(getDefaultPolicy()),
      ...extraRules,
    };

    // Bash
    if (toolName === 'Bash') {
      const cmd = String(input.command || '');
      for (const pattern of rules.bash.blocked) {
        if (new RegExp(pattern).test(cmd)) return { allowed: false };
      }
      if (rules.bash.blockedEnvVars.length > 0) {
        const envPattern = rules.bash.blockedEnvVars
          .map((v) => `\\$\\{?${v}\\}?`)
          .join('|');
        if (new RegExp(envPattern, 'i').test(cmd)) return { allowed: false };
      }
      for (const pattern of rules.bash.blockedUrls) {
        if (new RegExp(pattern, 'i').test(cmd)) return { allowed: false };
      }
    }

    // WebFetch
    if (toolName === 'WebFetch') {
      const url = String(input.url || '');
      if (rules.webfetch.httpsOnly && url && !/^https:\/\//i.test(url))
        return { allowed: false };
      for (const pattern of rules.webfetch.blockedNetworks) {
        if (new RegExp(pattern, 'i').test(url)) return { allowed: false };
      }
      for (const pattern of rules.webfetch.blockedUrls) {
        if (new RegExp(pattern, 'i').test(url)) return { allowed: false };
      }
    }

    // Write/Edit
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = String(input.file_path || input.path || '');
      for (const pattern of rules.write.blocked) {
        if (new RegExp(pattern, 'i').test(filePath)) return { allowed: false };
      }
      if (!trusted) {
        for (const pattern of rules.write.trustRequired) {
          if (new RegExp(pattern).test(filePath)) return { allowed: false };
        }
      }
    }

    // Untrusted tool check
    if (!trusted && rules.tools.blockedUntrusted.includes(toolName)) {
      return { allowed: false };
    }

    return { allowed: true };
  }

  // --- Bash ---

  it('blocks bare env', () => {
    expect(testCanUseTool('Bash', { command: 'env' }).allowed).toBe(false);
  });

  it('blocks env piped', () => {
    expect(testCanUseTool('Bash', { command: 'env | cat' }).allowed).toBe(
      false,
    );
  });

  it('blocks env in subshell', () => {
    expect(testCanUseTool('Bash', { command: 'echo $(env)' }).allowed).toBe(
      false,
    );
  });

  it('blocks env in backticks', () => {
    expect(testCanUseTool('Bash', { command: 'echo `env`' }).allowed).toBe(
      false,
    );
  });

  it('blocks env with semicolon', () => {
    expect(
      testCanUseTool('Bash', { command: 'env;cat /etc/passwd' }).allowed,
    ).toBe(false);
  });

  it('blocks printenv', () => {
    expect(testCanUseTool('Bash', { command: 'printenv' }).allowed).toBe(false);
  });

  it('blocks export -p', () => {
    expect(testCanUseTool('Bash', { command: 'export -p' }).allowed).toBe(
      false,
    );
  });

  it('blocks declare -x', () => {
    expect(testCanUseTool('Bash', { command: 'declare -x' }).allowed).toBe(
      false,
    );
  });

  it('blocks declare -p', () => {
    expect(testCanUseTool('Bash', { command: 'declare -p' }).allowed).toBe(
      false,
    );
  });

  it('blocks env -0', () => {
    expect(testCanUseTool('Bash', { command: 'env -0' }).allowed).toBe(false);
  });

  it('blocks compgen -v', () => {
    expect(testCanUseTool('Bash', { command: 'compgen -v' }).allowed).toBe(
      false,
    );
  });

  it('blocks /proc/self/environ', () => {
    expect(
      testCanUseTool('Bash', { command: 'cat /proc/self/environ' }).allowed,
    ).toBe(false);
  });

  it('blocks /proc/1/environ', () => {
    expect(
      testCanUseTool('Bash', { command: 'cat /proc/1/environ' }).allowed,
    ).toBe(false);
  });

  it('blocks /proc/42/environ', () => {
    expect(
      testCanUseTool('Bash', { command: 'strings /proc/42/environ' }).allowed,
    ).toBe(false);
  });

  it('blocks os.environ (Python)', () => {
    expect(
      testCanUseTool('Bash', {
        command: 'python3 -c "import os; print(os.environ)"',
      }).allowed,
    ).toBe(false);
  });

  it('blocks process.env (Node)', () => {
    expect(
      testCanUseTool('Bash', { command: 'node -e "console.log(process.env)"' })
        .allowed,
    ).toBe(false);
  });

  it('allows env FOO=bar cmd (legitimate use)', () => {
    expect(
      testCanUseTool('Bash', { command: 'env FOO=bar node app.js' }).allowed,
    ).toBe(true);
  });

  it('allows normal commands', () => {
    expect(testCanUseTool('Bash', { command: 'ls -la' }).allowed).toBe(true);
    expect(testCanUseTool('Bash', { command: 'git status' }).allowed).toBe(
      true,
    );
    expect(testCanUseTool('Bash', { command: 'npm install' }).allowed).toBe(
      true,
    );
  });

  it('blocks $SECRET_VAR from config', () => {
    const policy = getDefaultPolicy();
    policy.bash.blocked_env_vars = ['MY_SECRET'];
    const rules = buildContainerSecurityRules(policy);
    expect(
      testCanUseTool('Bash', { command: 'echo $MY_SECRET' }, false, rules)
        .allowed,
    ).toBe(false);
    expect(
      testCanUseTool('Bash', { command: 'echo ${MY_SECRET}' }, false, rules)
        .allowed,
    ).toBe(false);
  });

  // --- WebFetch ---

  it('blocks http:// URLs', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'http://example.com' }).allowed,
    ).toBe(false);
  });

  it('blocks localhost', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://localhost:3000' }).allowed,
    ).toBe(false);
  });

  it('blocks 127.0.0.1', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://127.0.0.1/api' }).allowed,
    ).toBe(false);
  });

  it('blocks 10.x private', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://10.0.0.1/admin' }).allowed,
    ).toBe(false);
  });

  it('blocks 192.168.x private', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://192.168.1.1/' }).allowed,
    ).toBe(false);
  });

  it('blocks [::1] IPv6 loopback', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://[::1]:8080/' }).allowed,
    ).toBe(false);
  });

  it('blocks host.docker.internal', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://host.docker.internal:3000' })
        .allowed,
    ).toBe(false);
  });

  it('blocks URL with userinfo bypass on loopback', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://x@127.0.0.1/' }).allowed,
    ).toBe(false);
  });

  it('blocks URL with userinfo bypass on localhost', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://x@localhost/' }).allowed,
    ).toBe(false);
  });

  it('blocks URL with userinfo bypass on RFC1918', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://user:pass@10.0.0.1/' })
        .allowed,
    ).toBe(false);
  });

  it('blocks IPv4-mapped IPv6 loopback', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://[::ffff:127.0.0.1]/' })
        .allowed,
    ).toBe(false);
  });

  it('blocks IPv4-mapped IPv6 private', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://[::ffff:10.0.0.1]/' }).allowed,
    ).toBe(false);
  });

  it('allows normal HTTPS URLs', () => {
    expect(
      testCanUseTool('WebFetch', { url: 'https://example.com' }).allowed,
    ).toBe(true);
    expect(
      testCanUseTool('WebFetch', { url: 'https://api.github.com/repos' })
        .allowed,
    ).toBe(true);
  });

  // --- Write/Edit ---

  it('blocks /skills/ path for untrusted', () => {
    expect(
      testCanUseTool('Write', {
        file_path: '/workspace/group/.claude/skills/evil',
      }).allowed,
    ).toBe(false);
  });

  it('allows /skills/ path for trusted', () => {
    expect(
      testCanUseTool(
        'Write',
        { file_path: '/workspace/group/.claude/skills/my-skill/SKILL.md' },
        true,
      ).allowed,
    ).toBe(true);
  });

  it('blocks CLAUDE.md', () => {
    expect(
      testCanUseTool('Write', { file_path: '/workspace/group/CLAUDE.md' })
        .allowed,
    ).toBe(false);
  });

  it('blocks settings.json', () => {
    expect(
      testCanUseTool('Edit', { file_path: '/home/node/.claude/settings.json' })
        .allowed,
    ).toBe(false);
  });

  it('blocks SOUL.md for untrusted', () => {
    expect(
      testCanUseTool('Write', { file_path: '/workspace/group/SOUL.md' })
        .allowed,
    ).toBe(false);
  });

  it('allows SOUL.md for trusted', () => {
    expect(
      testCanUseTool('Write', { file_path: '/workspace/group/SOUL.md' }, true)
        .allowed,
    ).toBe(true);
  });

  it('allows normal workspace paths', () => {
    expect(
      testCanUseTool('Write', { file_path: '/workspace/group/notes.md' })
        .allowed,
    ).toBe(true);
  });

  it('blocks trust-required paths for untrusted', () => {
    const policy = getDefaultPolicy();
    policy.write.trust_required_paths = ['/data/'];
    const rules = buildContainerSecurityRules(policy);
    expect(
      testCanUseTool(
        'Write',
        { file_path: '/workspace/group/data/file.json' },
        false,
        rules,
      ).allowed,
    ).toBe(false);
  });

  it('allows trust-required paths for trusted', () => {
    const policy = getDefaultPolicy();
    policy.write.trust_required_paths = ['/data/'];
    const rules = buildContainerSecurityRules(policy);
    expect(
      testCanUseTool(
        'Write',
        { file_path: '/workspace/group/data/file.json' },
        true,
        rules,
      ).allowed,
    ).toBe(true);
  });

  // --- Untrusted sender ---

  it('blocks untrusted tools for untrusted sender', () => {
    const policy = getDefaultPolicy();
    policy.tools.blocked_untrusted = ['mcp__memory__write'];
    const rules = buildContainerSecurityRules(policy);
    expect(testCanUseTool('mcp__memory__write', {}, false, rules).allowed).toBe(
      false,
    );
  });

  it('allows untrusted tools for trusted sender', () => {
    const policy = getDefaultPolicy();
    policy.tools.blocked_untrusted = ['mcp__memory__write'];
    const rules = buildContainerSecurityRules(policy);
    expect(testCanUseTool('mcp__memory__write', {}, true, rules).allowed).toBe(
      true,
    );
  });
});
