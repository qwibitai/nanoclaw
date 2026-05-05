#!/usr/bin/env node
// Smoke test for loadProviderEnvDefaults() + mergeProviderConfig().
// Writes a temp .env, imports the compiled module, asserts behaviour.
// Run: node scripts/smoke-env-provider.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const REAL_ENV = path.join(ROOT, '.env');
const BACKUP = path.join(os.tmpdir(), `talon-smoke-env-${process.pid}.bak`);

// Preserve real .env if present
const hadRealEnv = fs.existsSync(REAL_ENV);
if (hadRealEnv) fs.copyFileSync(REAL_ENV, BACKUP);

let pass = 0, fail = 0;

async function run(name, envContent, assertFn) {
  fs.writeFileSync(REAL_ENV, envContent);
  // bust ESM cache so loadProviderEnvDefaults re-reads .env
  const mod = await import(`../dist/env.js?cb=${Date.now()}`);
  try {
    assertFn(mod);
    console.log(`PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`  ${err.message}`);
    fail++;
  }
}

function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n  expected: ${JSON.stringify(b)}\n  got:      ${JSON.stringify(a)}`);
  }
}

try {
  await run('empty .env → no provider', '', ({ loadProviderEnvDefaults }) => {
    eq(loadProviderEnvDefaults(), {}, 'expected empty config');
  });

  await run('TALON_PROVIDER=anthropic → provider only', 'TALON_PROVIDER=anthropic\n', ({ loadProviderEnvDefaults }) => {
    eq(loadProviderEnvDefaults(), { provider: 'anthropic' }, 'expected anthropic provider');
  });

  await run(
    'TALON_PROVIDER=ollama with all fields',
    'TALON_PROVIDER=ollama\nTALON_OLLAMA_BASE_URL=https://x.runpod.net\nTALON_OLLAMA_MODEL=llama3.2:latest\nTALON_OLLAMA_API_KEY=sk-test\n',
    ({ loadProviderEnvDefaults }) => {
      eq(
        loadProviderEnvDefaults(),
        {
          provider: 'ollama',
          ollama: { baseUrl: 'https://x.runpod.net', model: 'llama3.2:latest', apiKey: 'sk-test' },
        },
        'expected full ollama config',
      );
    },
  );

  await run(
    'TALON_PROVIDER=ollama missing url+model → falls back, no provider set',
    'TALON_PROVIDER=ollama\n',
    ({ loadProviderEnvDefaults }) => {
      eq(loadProviderEnvDefaults(), {}, 'expected empty (warn + fallback)');
    },
  );

  await run(
    'TALON_BLOCKED_HOSTS comma-list parsed',
    'TALON_BLOCKED_HOSTS=api.openai.com, generativelanguage.googleapis.com ,  bad.example\n',
    ({ loadProviderEnvDefaults }) => {
      eq(
        loadProviderEnvDefaults(),
        { blockedHosts: ['api.openai.com', 'generativelanguage.googleapis.com', 'bad.example'] },
        'expected trimmed comma-split list',
      );
    },
  );

  await run('mergeProviderConfig: group wins on provider', '', ({ mergeProviderConfig }) => {
    const merged = mergeProviderConfig(
      { provider: 'ollama', ollama: { baseUrl: 'http://default', model: 'm1' } },
      { provider: 'anthropic' },
    );
    eq(merged.provider, 'anthropic', 'expected group provider to win');
  });

  await run('mergeProviderConfig: blockedHosts unioned', '', ({ mergeProviderConfig }) => {
    const merged = mergeProviderConfig(
      { blockedHosts: ['api.openai.com'] },
      { blockedHosts: ['evil.com'] },
    );
    eq(
      [...merged.blockedHosts].sort(),
      ['api.openai.com', 'evil.com'].sort(),
      'expected union',
    );
  });

  await run('mergeProviderConfig: env shallow-merged, group wins per key', '', ({ mergeProviderConfig }) => {
    const merged = mergeProviderConfig(
      { env: { FOO: 'env-val', BAR: 'keep' } },
      { env: { FOO: 'group-val' } },
    );
    eq(merged.env, { FOO: 'group-val', BAR: 'keep' }, 'expected key-level override');
  });
} finally {
  // Restore .env
  if (hadRealEnv) fs.copyFileSync(BACKUP, REAL_ENV);
  else fs.rmSync(REAL_ENV, { force: true });
  fs.rmSync(BACKUP, { force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
