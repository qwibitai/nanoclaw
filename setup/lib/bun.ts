import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const FALLBACK_BUN_VERSION = '1.3.12';

const BUN_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function readPinnedBunVersion(projectRoot = process.cwd()): string {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.bun-version'), 'utf-8');
    const version = normalizeBunVersion(raw);
    if (version) return version;
  } catch {
    // Fresh checkouts before the version file existed fall back to the image pin.
  }
  return FALLBACK_BUN_VERSION;
}

export function bunInstallDir(): string {
  return process.env.BUN_INSTALL || path.join(os.homedir(), '.bun');
}

export function localBunBin(): string {
  return path.join(bunInstallDir(), 'bin', 'bun');
}

export function ensureBunPathInProcessEnv(): void {
  const binDir = path.join(bunInstallDir(), 'bin');
  const current = process.env.PATH ?? '';
  const segments = current.split(path.delimiter).filter(Boolean);
  if (segments.includes(binDir)) return;
  process.env.PATH = current ? `${binDir}${path.delimiter}${current}` : binDir;
}

export function ensureShellBunPathConfigured(): { file: string; changed: boolean } | null {
  const file = shellConfigPath();
  if (!file) return null;

  const block = [
    '',
    '# NanoClaw Bun runtime',
    'export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"',
    'case ":$PATH:" in',
    '  *":$BUN_INSTALL/bin:"*) ;;',
    '  *) export PATH="$BUN_INSTALL/bin:$PATH" ;;',
    'esac',
    '',
  ].join('\n');

  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (/(^|[/:])\.bun\/bin|\$BUN_INSTALL\/bin|\$\{BUN_INSTALL\}\/bin/.test(existing)) {
      return { file, changed: false };
    }

    fs.appendFileSync(file, block);
    return { file, changed: true };
  } catch {
    return null;
  }
}

export function resolveBunCommand(): string | null {
  if (runBunVersion('bun')) return 'bun';

  const localBun = localBunBin();
  if (fs.existsSync(localBun) && runBunVersion(localBun)) return localBun;
  return null;
}

export function getBunVersion(command: string): string | null {
  return runBunVersion(command);
}

export function installBunVersion(version: string): number {
  const normalized = normalizeBunVersion(version);
  if (!normalized) return 2;

  const tag = `bun-v${normalized}`;
  const installCmd = `curl -fsSL https://bun.sh/install | bash -s ${shellQuote(tag)}`;
  const res = spawnSync('bash', ['-lc', installCmd], {
    env: { ...process.env, BUN_INSTALL: bunInstallDir() },
    stdio: 'inherit',
  });
  return res.status ?? 1;
}

function normalizeBunVersion(raw: string): string | null {
  const value = raw.trim().replace(/^bun-v/, '');
  return BUN_VERSION_RE.test(value) ? value : null;
}

function runBunVersion(command: string): string | null {
  const res = spawnSync(command, ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

function shellConfigPath(): string | null {
  const home = os.homedir();
  const shell = path.basename(process.env.SHELL ?? '');
  if (shell === 'zsh') return path.join(home, '.zshrc');
  if (shell === 'bash') {
    return process.platform === 'darwin' ? path.join(home, '.bash_profile') : path.join(home, '.bashrc');
  }
  return path.join(home, '.profile');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
