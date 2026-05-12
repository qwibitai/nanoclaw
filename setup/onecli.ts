/**
 * Step: onecli — Install + configure the OneCLI gateway and CLI.
 *
 * Two modes:
 *   (default) run the OneCLI installer, configure api-host, write .env.
 *   --reuse   skip the installer; reuse the onecli instance already running
 *             on the host. Required for users who have other apps bound to
 *             an existing gateway, since re-running the installer rebinds
 *             the listener and breaks those consumers.
 *
 * Emits ONECLI_URL and polls /health so downstream steps (auth, service)
 * get a ready gateway.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

// Path where the upstream OneCLI installer writes the generated compose file.
// Both the installer and `docker compose` commands operate on this path.
const ONECLI_COMPOSE_PATH = path.join(os.homedir(), '.onecli', 'docker-compose.yml');

// Marker comment we write into the compose file so re-running setup detects
// our prior rewrite and no-ops instead of re-patching (or worse, double-patching).
// References the upstream issue so anyone reading the file can find context.
const NANOCLAW_HARDEN_MARKER = '# nanoclaw: admin+postgres pinned to loopback (onecli/onecli#268)';

function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function onecliVersion(): string | null {
  try {
    return execFileSync('onecli', ['version'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Ask the installed onecli CLI for its configured api-host. Returns null if
 * onecli isn't on PATH, errors, or has no api-host configured.
 *
 * Tolerates both JSON output (onecli 1.3+) and older raw-text output.
 */
export function getOnecliApiHost(): string | null {
  try {
    const out = execFileSync('onecli', ['config', 'get', 'api-host'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    try {
      const parsed = JSON.parse(out) as { data?: unknown; value?: unknown };
      const val = parsed.data ?? parsed.value;
      if (typeof val === 'string' && val.trim()) return val.trim();
    } catch {
      // not JSON — fall through to URL extraction
    }
    return extractUrlFromOutput(out);
  } catch {
    return null;
  }
}

function extractUrlFromOutput(output: string): string | null {
  const match = output.match(/https?:\/\/[\w.\-]+(?::\d+)?/);
  return match ? match[0] : null;
}

function ensureShellProfilePath(): void {
  const home = os.homedir();
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  for (const profile of [path.join(home, '.bashrc'), path.join(home, '.zshrc')]) {
    try {
      const content = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : '';
      if (!content.includes('.local/bin')) {
        fs.appendFileSync(profile, `\n${line}\n`);
        log.info('Added ~/.local/bin to PATH in shell profile', { profile });
      }
    } catch (err) {
      log.warn('Could not update shell profile', { profile, err });
    }
  }
}

function writeEnvVar(name: string, value: string): void {
  const envFile = path.join(process.cwd(), '.env');
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  const re = new RegExp(`^${name}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${name}=${value}`);
  } else {
    content = content.trimEnd() + (content ? '\n' : '') + `${name}=${value}\n`;
  }
  fs.writeFileSync(envFile, content);
}

function writeEnvOnecliUrl(url: string): void {
  writeEnvVar('ONECLI_URL', url);
}

// Last-known-good CLI release. Used only if BOTH the upstream installer
// and the redirect-based version probe fail. Bump deliberately when a
// new CLI release ships.
const ONECLI_CLI_FALLBACK_VERSION = '1.3.0';
const ONECLI_CLI_REPO = 'onecli/onecli-cli';

function installOnecliCliOnly(): { stdout: string; ok: boolean } {
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  if (upstream.ok) return { stdout: upstream.stdout, ok: true };
  const fallback = installOnecliCliDirect();
  return { stdout: upstream.stdout + (upstream.stderr ?? '') + '\n' + fallback.stdout, ok: fallback.ok };
}

// Remove containers in the "onecli" compose project whose service name isn't
// in the v2 set. Pre-v2 OneCLI used service "app" (container onecli-app-1);
// v2 uses "onecli". Compose flags the old container as an orphan but won't
// stop it without --remove-orphans, leaving port 10254 bound and crashing
// the new bring-up. Filed upstream; this is the downstream workaround.
function removeLegacyOnecliContainers(): string {
  const out: string[] = [];
  let list = '';
  try {
    list = execSync(
      `docker ps -a --filter "label=com.docker.compose.project=onecli" --format '{{.Names}}|{{.Label "com.docker.compose.service"}}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
  if (!list) return '';
  const v2Services = new Set(['onecli', 'postgres']);
  for (const line of list.split('\n')) {
    const [name, service] = line.split('|');
    if (!name || !service || v2Services.has(service)) continue;
    out.push(`Removing legacy OneCLI container: ${name} (service=${service})`);
    try {
      execSync(`docker rm -f ${JSON.stringify(name)}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out.push(`  rm failed (continuing): ${(err as Error).message}`);
    }
  }
  return out.join('\n');
}

/**
 * Rewrite the OneCLI-generated docker-compose so the admin API (:10254) and
 * Postgres (:5432) bind to 127.0.0.1, while the proxy gateway (:10255) keeps
 * whatever the installer chose. On bare-metal Linux the installer auto-picks
 * the docker0 bridge IP, which makes the admin API and Postgres reachable
 * from every container on the host's default bridge — see onecli/onecli#268.
 *
 * The rewrite is a targeted regex on lines we recognize, with a marker comment
 * for idempotency. If the upstream compose shape changes in a way we don't
 * recognize, we warn and no-op rather than corrupt the file.
 *
 * `composePath` is an optional override for tests; production code uses the
 * module-level ONECLI_COMPOSE_PATH constant.
 */
export function hardenOneCliBinds(
  composePath: string = ONECLI_COMPOSE_PATH,
): { changed: boolean; reason?: string } {
  if (!fs.existsSync(composePath)) {
    log.warn('OneCLI compose file not found — skipping bind hardening', { composePath });
    return { changed: false, reason: 'compose_missing' };
  }

  const original = fs.readFileSync(composePath, 'utf-8');
  if (original.includes(NANOCLAW_HARDEN_MARKER)) {
    return { changed: false, reason: 'already_patched' };
  }

  // Match the three port lines we expect from upstream's compose. The bind
  // host is captured in group 1 so we can decide what to swap. We only rewrite
  // admin (:10254) and postgres (:5432); the gateway (:10255) is left alone
  // because the bridge IP is the *correct* bind there.
  const adminRe = /^(\s*-\s*)"\$\{ONECLI_BIND_HOST:-127\.0\.0\.1\}:\$\{ONECLI_APP_PORT:-10254\}:10254"\s*$/m;
  const pgRe = /^(\s*-\s*)"\$\{ONECLI_BIND_HOST:-127\.0\.0\.1\}:\$\{POSTGRES_PORT:-5432\}:5432"\s*$/m;

  if (!adminRe.test(original) || !pgRe.test(original)) {
    log.warn('OneCLI compose layout not recognized — leaving file untouched', { composePath });
    return { changed: false, reason: 'layout_unrecognized' };
  }

  let patched = original.replace(
    adminRe,
    `$1"127.0.0.1:\${ONECLI_APP_PORT:-10254}:10254"`,
  );
  patched = patched.replace(
    pgRe,
    `$1"127.0.0.1:\${POSTGRES_PORT:-5432}:5432"`,
  );

  // Prepend the marker so a re-run is a no-op. Keep it as the very first line
  // so `head -1` / quick visual inspection finds it.
  patched = `${NANOCLAW_HARDEN_MARKER}\n${patched}`;

  fs.writeFileSync(composePath, patched);
  log.info('Pinned OneCLI admin API and Postgres to 127.0.0.1', { composePath });
  return { changed: true };
}

/**
 * After rewriting the compose file, ask docker to reconcile the running
 * containers with the new port mappings. `up -d` is the right verb here:
 * it stops and recreates only the services whose effective config changed,
 * and leaves the rest alone. We don't fail the install if this errors —
 * the rewrite already landed and a `docker compose up -d` on next boot will
 * pick it up.
 */
function applyHardenedCompose(composePath: string = ONECLI_COMPOSE_PATH): void {
  try {
    execSync(`docker compose -f ${JSON.stringify(composePath)} up -d`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    log.warn('docker compose up -d after bind hardening failed (will apply on next boot)', { err });
  }
}

/**
 * --reuse mode helper: detect whether an existing OneCLI install has the
 * admin port bound to anything other than loopback, so we can warn without
 * rewriting someone else's file. We check the compose marker first (our own
 * patch), then the installer's .env for ONECLI_BIND_HOST. Returns the unsafe
 * bind value if detected, otherwise null.
 */
function detectUnsafeOneCliBinds(composePath: string = ONECLI_COMPOSE_PATH): string | null {
  if (!fs.existsSync(composePath)) return null;
  const composeContent = fs.readFileSync(composePath, 'utf-8');
  if (composeContent.includes(NANOCLAW_HARDEN_MARKER)) return null;

  const envPath = path.join(path.dirname(composePath), '.env');
  if (!fs.existsSync(envPath)) return null;
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const m = envContent.match(/^\s*ONECLI_BIND_HOST\s*=\s*(.+?)\s*$/m);
  if (!m) return null;
  const bind = m[1].replace(/^["']|["']$/g, '');
  if (!bind || bind === '127.0.0.1' || bind === 'localhost') return null;
  return bind;
}

function installOnecli(): { stdout: string; ok: boolean } {
  let stdout = '';

  const cleanup = removeLegacyOnecliContainers();
  if (cleanup) stdout += cleanup + '\n';

  // Gateway install (docker-compose based, no rate-limit concerns).
  const gw = runInstall('curl -fsSL onecli.sh/install | sh');
  stdout += gw.stdout;
  if (!gw.ok) {
    log.error('OneCLI gateway install failed', { stderr: gw.stderr });
    return { stdout: stdout + (gw.stderr ?? ''), ok: false };
  }

  // CLI install. The upstream script calls the GitHub releases API
  // (api.github.com) to resolve the latest tag — which 403s anonymous
  // callers after 60 requests/hour per IP. Try upstream first; on failure
  // resolve the version ourselves (via HTTP redirect, which isn't
  // API-throttled) and download the release archive directly.
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  stdout += upstream.stdout;
  if (upstream.ok) return { stdout, ok: true };

  log.warn('Upstream CLI installer failed — falling back to direct download', {
    stderr: upstream.stderr,
  });
  stdout += (upstream.stderr ?? '') + '\n';

  const fallback = installOnecliCliDirect();
  stdout += fallback.stdout;
  if (!fallback.ok) {
    log.error('OneCLI CLI install failed (both upstream and direct fallback)');
    return { stdout, ok: false };
  }
  return { stdout, ok: true };
}

function runInstall(cmd: string): { stdout: string; stderr?: string; ok: boolean } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr, ok: false };
  }
}

/**
 * Reinstate the OneCLI CLI install without hitting GitHub's rate-limited
 * releases API. Resolves the version via the HTTP redirect from
 * /releases/latest → /releases/tag/vX.Y.Z, then downloads the archive
 * directly. Falls back to ONECLI_CLI_FALLBACK_VERSION if the redirect
 * probe also fails.
 */
function installOnecliCliDirect(): { stdout: string; ok: boolean } {
  const lines: string[] = [];
  const append = (s: string): void => {
    lines.push(s);
  };

  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  if (!osName) {
    append(`Unsupported platform: ${process.platform}`);
    return { stdout: lines.join('\n'), ok: false };
  }
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!arch) {
    append(`Unsupported arch: ${process.arch}`);
    return { stdout: lines.join('\n'), ok: false };
  }

  let version: string | null = null;
  try {
    const redirect = execSync(
      `curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/${ONECLI_CLI_REPO}/releases/latest`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const m = redirect.match(/\/tag\/v?([^/]+)$/);
    if (m) version = m[1];
  } catch {
    // redirect probe failed — we'll pin the fallback
  }
  if (!version) {
    version = ONECLI_CLI_FALLBACK_VERSION;
    append(`Version probe failed; installing pinned fallback ${version}.`);
  } else {
    append(`Resolved onecli CLI ${version} via release redirect.`);
  }

  const archive = `onecli_${version}_${osName}_${arch}.tar.gz`;
  const url = `https://github.com/${ONECLI_CLI_REPO}/releases/download/v${version}/${archive}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-'));
  const archivePath = path.join(tmpDir, archive);

  try {
    append(`Downloading ${url}`);
    execSync(`curl -fsSL -o ${JSON.stringify(archivePath)} ${JSON.stringify(url)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execSync(`tar -xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(tmpDir)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let installDir = '/usr/local/bin';
    try {
      fs.accessSync(installDir, fs.constants.W_OK);
    } catch {
      installDir = LOCAL_BIN;
      fs.mkdirSync(installDir, { recursive: true });
    }
    const binSrc = path.join(tmpDir, 'onecli');
    const binDest = path.join(installDir, 'onecli');
    fs.copyFileSync(binSrc, binDest);
    fs.chmodSync(binDest, 0o755);
    append(`onecli ${version} installed to ${binDest}.`);
    return { stdout: lines.join('\n'), ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    append(`Direct install failed: ${e.stderr ?? e.message ?? String(err)}`);
    return { stdout: lines.join('\n'), ok: false };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  // `/api/health` matches the path probe.sh uses — keep them aligned.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function run(args: string[]): Promise<void> {
  const reuse = args.includes('--reuse');
  const remoteUrlIdx = args.indexOf('--remote-url');
  const remoteUrl = remoteUrlIdx !== -1 ? args[remoteUrlIdx + 1] : null;
  ensureShellProfilePath();

  if (remoteUrl) {
    // Remote-mode: install only the CLI, point it at the remote gateway, and
    // record the URL in .env. No local gateway is started.
    log.info('Installing OneCLI CLI for remote gateway', { remoteUrl });
    const res = installOnecliCliOnly();
    if (!res.ok || !onecliVersion()) {
      emitStatus('ONECLI', {
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'cli_install_failed',
        HINT: 'CLI binary install failed. Make sure curl is installed and ~/.local/bin is writable.',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    try {
      execFileSync('onecli', ['config', 'set', 'api-host', remoteUrl], {
        stdio: 'ignore',
        env: childEnv(),
      });
    } catch (err) {
      log.warn('onecli config set api-host failed', { err });
    }
    writeEnvOnecliUrl(remoteUrl);
    log.info('Wrote ONECLI_URL to .env', { url: remoteUrl });
    const remoteToken = process.env.NANOCLAW_ONECLI_API_TOKEN?.trim();
    if (remoteToken) {
      // Two auth surfaces: `onecli auth login` persists the key for CLI
      // calls during setup itself (e.g. detecting an existing Anthropic
      // secret via `onecli secrets list`), and ONECLI_API_KEY in .env is
      // read by the runtime SDK at request time. Both are needed.
      try {
        execFileSync('onecli', ['auth', 'login', '--api-key', remoteToken], {
          stdio: 'ignore',
          env: childEnv(),
        });
      } catch (err) {
        log.warn('onecli auth login failed', { err });
      }
      writeEnvVar('ONECLI_API_KEY', remoteToken);
      log.info('Wrote ONECLI_API_KEY to .env');
    }
    const healthy = await pollHealth(remoteUrl, 5000);
    emitStatus('ONECLI', {
      INSTALLED: true,
      REMOTE: true,
      ONECLI_URL: remoteUrl,
      HEALTHY: healthy,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  if (reuse) {
    // Reuse-mode: don't touch the running gateway at all. Just verify it
    // exists, read its api-host, write ONECLI_URL to .env, and move on.
    const version = onecliVersion();
    if (!version) {
      emitStatus('ONECLI', {
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'onecli_not_found_for_reuse',
        HINT: 'onecli not on PATH. Re-run setup and choose "install fresh".',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    const url = getOnecliApiHost();
    if (!url) {
      emitStatus('ONECLI', {
        INSTALLED: true,
        STATUS: 'failed',
        ERROR: 'onecli_api_host_not_configured',
        HINT: 'Existing onecli has no api-host set. Run `onecli config set api-host <url>` or re-run setup with install-fresh.',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    writeEnvOnecliUrl(url);
    log.info('Reusing existing OneCLI', { url });
    const unsafeBind = detectUnsafeOneCliBinds();
    if (unsafeBind) {
      log.warn(
        'Existing OneCLI binds admin API and Postgres on a non-loopback address. ' +
          'Containers on that network can reach the admin API and Postgres directly. ' +
          'See onecli/onecli#268. To remediate: stop the gateway, re-run setup without --reuse, ' +
          'or manually pin :10254 and :5432 to 127.0.0.1 in ~/.onecli/docker-compose.yml.',
        { bind: unsafeBind },
      );
    }
    const healthy = await pollHealth(url, 5000);
    emitStatus('ONECLI', {
      INSTALLED: true,
      REUSED: true,
      ONECLI_URL: url,
      HEALTHY: healthy,
      ...(unsafeBind ? { UNSAFE_BIND: unsafeBind, HARDEN_NOTE: 'admin_api_and_postgres_exposed_on_bridge' } : {}),
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  log.info('Installing OneCLI gateway and CLI');
  const res = installOnecli();
  if (!res.ok) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'install_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
  if (!onecliVersion()) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'onecli_not_on_path_after_install',
      HINT: 'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"` and retry.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Pin admin API (:10254) and Postgres (:5432) to 127.0.0.1 before we hand
  // back to the rest of setup. The upstream installer picks the docker0
  // bridge IP as ONECLI_BIND_HOST on bare-metal Linux, which makes both
  // services reachable from any container on the host's default bridge.
  // See onecli/onecli#268.
  const harden = hardenOneCliBinds();
  if (harden.changed) applyHardenedCompose();

  const url = extractUrlFromOutput(res.stdout);
  if (!url) {
    emitStatus('ONECLI', {
      INSTALLED: true,
      STATUS: 'failed',
      ERROR: 'could_not_resolve_api_host',
      HINT: 'Inspect logs/setup.log for the install output.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  try {
    execFileSync('onecli', ['config', 'set', 'api-host', url], {
      stdio: 'ignore',
      env: childEnv(),
    });
  } catch (err) {
    log.warn('onecli config set api-host failed', { err });
  }

  writeEnvOnecliUrl(url);
  log.info('Wrote ONECLI_URL to .env', { url });

  const healthy = await pollHealth(url, 15000);

  emitStatus('ONECLI', {
    INSTALLED: true,
    ONECLI_URL: url,
    HEALTHY: healthy,
    HARDENED: harden.changed,
    HARDEN_NOTE: harden.changed
      ? 'admin_api_and_postgres_pinned_to_loopback'
      : harden.reason ?? 'no_change',
    // Install succeeded regardless — a failed health poll often just means
    // the endpoint is auth-gated or the gateway hasn't finished warming up.
    // The next step (auth) will surface a genuinely broken gateway via
    // `onecli secrets list`, so don't trigger rescue attempts from here.
    STATUS: 'success',
    ...(healthy
      ? {}
      : {
          HEALTH_HINT:
            'Health poll returned non-ok within 15s — likely auth-gated. Proceed to the auth step; it will surface a real outage.',
        }),
    LOG: 'logs/setup.log',
  });
}
