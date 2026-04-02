/**
 * NanoClaw health check — verifies each startup step independently.
 * Run: npx tsx scripts/health-check.ts
 * Exit 0 = all healthy, Exit 1 = something failed.
 *
 * Note: Uses execSync with hardcoded commands (no user input) — safe from injection.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHECKS: Array<{ name: string; fn: () => string }> = [];
const results: Array<{ name: string; status: 'ok' | 'fail'; detail: string; ms: number }> = [];

function check(name: string, fn: () => string) {
  CHECKS.push({ name, fn });
}

// --- Checks ---

check('TypeScript build', () => {
  execSync('npm run build', { stdio: 'pipe', timeout: 30000 });
  return 'compiled without errors';
});

check('Tests pass', () => {
  const out = execSync('npx vitest run', { encoding: 'utf-8', timeout: 60000 });
  const match = out.match(/(\d+) passed/);
  return match ? `${match[1]} tests passed` : 'tests passed';
});

check('Container runtime', () => {
  execSync('container system status', { stdio: 'pipe', timeout: 5000 });
  return 'running';
});

check('Container image exists', () => {
  const out = execSync('container image ls --format json', {
    encoding: 'utf-8',
    timeout: 10000,
  });
  const images = JSON.parse(out || '[]');
  const found = images.some((img: any) => {
    const ref = img.reference || '';
    const annName = img.descriptor?.annotations?.['com.apple.containerization.image.name'] || '';
    return ref.includes('nanoclaw-agent') || annName.includes('nanoclaw-agent');
  });
  if (!found) throw new Error('nanoclaw-agent image not found');
  return 'nanoclaw-agent:latest';
});

check('Container runs', () => {
  const out = execSync(
    'echo \'{}\'| container run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK"',
    { encoding: 'utf-8', timeout: 30000 },
  );
  if (!out.trim().includes('OK')) throw new Error('container did not respond');
  return 'container executed successfully';
});

check('Credential proxy port free', () => {
  try {
    execSync('lsof -i :3001', { stdio: 'pipe', timeout: 3000 });
    throw new Error('port 3001 already in use');
  } catch (err: any) {
    if (err.message?.includes('already in use')) throw err;
    return 'port 3001 available';
  }
});

check('.env exists', () => {
  if (!fs.existsSync('.env')) throw new Error('.env missing');
  const env = fs.readFileSync('.env', 'utf-8');
  const keys = ['CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'VERCEL_TOKEN', 'TZ'];
  const found = keys.filter((k) => env.includes(k));
  const missing = keys.filter((k) => !env.includes(k));
  if (missing.length > 0) return `found: ${found.join(', ')} | missing: ${missing.join(', ')}`;
  return `all keys present (${found.length})`;
});

check('data/env/env synced', () => {
  if (!fs.existsSync('data/env/env')) throw new Error('data/env/env missing');
  const src = fs.readFileSync('.env', 'utf-8').trim();
  const dst = fs.readFileSync('data/env/env', 'utf-8').trim();
  if (src !== dst) throw new Error('data/env/env out of sync — run: cp .env data/env/env');
  return 'in sync';
});

check('WhatsApp auth', () => {
  if (!fs.existsSync('store/auth/creds.json')) throw new Error('store/auth/creds.json missing');
  return 'credentials present';
});

check('Telegram token', () => {
  const env = fs.readFileSync('.env', 'utf-8');
  if (!env.includes('TELEGRAM_BOT_TOKEN=')) throw new Error('TELEGRAM_BOT_TOKEN missing from .env');
  return 'token present';
});

check('Registered groups', () => {
  const out = execSync(
    'sqlite3 store/messages.db "SELECT COUNT(*) FROM registered_groups"',
    { encoding: 'utf-8', timeout: 5000 },
  );
  const count = parseInt(out.trim(), 10);
  if (count === 0) throw new Error('no groups registered');
  return `${count} group(s)`;
});

check('Channel registration intact', () => {
  const channels = ['whatsapp', 'telegram'];
  const missing: string[] = [];
  for (const ch of channels) {
    const file = `dist/channels/${ch}.js`;
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf-8');
    if (!content.includes('registerChannel')) {
      missing.push(ch);
    }
  }
  if (missing.length > 0) throw new Error(`registerChannel missing in: ${missing.join(', ')}`);
  return 'all channels register correctly';
});

check('Launchd plist', () => {
  const plist = path.join(
    process.env.HOME || '',
    'Library/LaunchAgents/com.nanoclaw.plist',
  );
  if (!fs.existsSync(plist)) throw new Error('plist missing');
  const content = fs.readFileSync(plist, 'utf-8');
  if (!content.includes('/opt/homebrew/bin')) {
    throw new Error('plist PATH missing /opt/homebrew/bin');
  }
  return 'plist OK with correct PATH';
});

check('CLAUDE.md personality', () => {
  const global = fs.readFileSync('groups/global/CLAUDE.md', 'utf-8');
  if (!global.includes('Göran P')) throw new Error('assistant name missing');
  if (!global.includes('Personlighet')) throw new Error('personality section missing');
  if (!global.includes('Kvalitetskontroll')) throw new Error('quality control section missing');
  if (!global.includes('ALDRIG pusha direkt till')) throw new Error('branch protection rule missing');
  return 'personality + quality rules + branch protection';
});

// --- Run ---

console.log('\n  NanoClaw Health Check\n  ' + '═'.repeat(40) + '\n');

let failed = 0;
for (const { name, fn } of CHECKS) {
  const start = Date.now();
  try {
    const detail = fn();
    const ms = Date.now() - start;
    results.push({ name, status: 'ok', detail, ms });
    console.log(`  ✓ ${name} (${ms}ms)`);
    console.log(`    ${detail}`);
  } catch (err: any) {
    const ms = Date.now() - start;
    const msg = err.message || String(err);
    results.push({ name, status: 'fail', detail: msg, ms });
    console.log(`  ✗ ${name} (${ms}ms)`);
    console.log(`    ${msg}`);
    failed++;
  }
}

console.log('\n  ' + '─'.repeat(40));
console.log(
  `  ${results.length - failed}/${results.length} passed` +
    (failed > 0 ? ` — ${failed} failed` : ' — all healthy') +
    '\n',
);

process.exit(failed > 0 ? 1 : 0);
