/**
 * Non-interactive setup driver. Chains the deterministic setup steps so a
 * scripted install can go from a fresh checkout to a running service without
 * the `/setup` skill.
 *
 * Prerequisite: `bash setup.sh` has run (Node >= 20, pnpm install, native
 * module check). This driver picks up from there.
 *
 * Config via env:
 *   NANOCLAW_DISPLAY_NAME  operator name for the CLI agent (default: $USER).
 *                          Initial value only — after a successful end-to-end
 *                          ping, the user is prompted to confirm or override
 *                          (with a probe-inferred name as the default).
 *   NANOCLAW_AGENT_NAME    agent persona name (default: display name). Same
 *                          confirm-or-override prompt fires post-ping.
 *   NANOCLAW_SKIP          comma-separated step names to skip
 *                          (environment|container|onecli|auth|
 *                           mounts|service|cli-agent|verify)
 *
 * Timezone is not configured here — it defaults to the host system's TZ.
 * Run `pnpm exec tsx setup/index.ts --step timezone -- --tz <zone>` later
 * if autodetect is wrong (e.g. headless server with TZ=UTC).
 *
 * Anthropic credential registration runs via setup/register-claude-token.sh
 * (the only step that truly requires human input — browser sign-in or a
 * pasted token/key). Channel auth and `/manage-channels` remain separate
 * because they're platform-specific and typically handled via `/add-<channel>`
 * and `/manage-channels` after this driver completes.
 */
import { spawn, spawnSync } from 'child_process';

type Fields = Record<string, string>;
type StepResult = { ok: boolean; fields: Fields; exitCode: number };

function parseStatus(stdout: string): Fields {
  const out: Fields = {};
  let inBlock = false;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('=== NANOCLAW SETUP:')) {
      inBlock = true;
      continue;
    }
    if (line.startsWith('=== END ===')) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function runStep(name: string, extra: string[] = []): Promise<StepResult> {
  return new Promise((resolve) => {
    console.log(`\n── ${name} ────────────────────────────────────`);
    const args = ['exec', 'tsx', 'setup/index.ts', '--step', name];
    if (extra.length > 0) args.push('--', ...extra);

    const child = spawn('pnpm', args, { stdio: ['inherit', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      buf += s;
      process.stdout.write(s);
    });
    child.on('close', (code) => {
      const fields = parseStatus(buf);
      resolve({
        ok: code === 0 && fields.STATUS === 'success',
        fields,
        exitCode: code ?? 1,
      });
    });
  });
}

/**
 * After installing Docker, this process's supplementary groups are still
 * frozen from login — subsequent steps that talk to /var/run/docker.sock
 * (onecli install, service start, …) fail with EACCES even though the
 * daemon is up. Detect that and re-exec the whole driver under `sg docker`
 * so the rest of the run inherits the docker group without a re-login.
 */
function maybeReexecUnderSg(): void {
  if (process.env.NANOCLAW_REEXEC_SG === '1') return; // already re-exec'd
  if (process.platform !== 'linux') return;
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (info.status === 0) return;
  const err = `${info.stderr ?? ''}\n${info.stdout ?? ''}`;
  if (!/permission denied/i.test(err)) return;
  if (spawnSync('which', ['sg'], { stdio: 'ignore' }).status !== 0) return;

  console.log(
    '\n[setup:auto] Docker socket not accessible in current group — ' +
      're-executing under `sg docker` to pick up new group membership.',
  );
  const res = spawnSync('sg', ['docker', '-c', 'pnpm run setup:auto'], {
    stdio: 'inherit',
    env: { ...process.env, NANOCLAW_REEXEC_SG: '1' },
  });
  process.exit(res.status ?? 1);
}

function anthropicSecretExists(): boolean {
  try {
    const res = spawnSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return false;
    return /anthropic/i.test(res.stdout ?? '');
  } catch {
    return false;
  }
}

function runBashScript(relPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('bash', [relPath], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Resolve the operator's display name from host signals, matching the chain
 * probe.sh uses for INFERRED_DISPLAY_NAME on the /new-setup path: git global
 * user.name → platform record (macOS `id -F`, Linux/WSL getent GECOS) →
 * $USER → "User". Empty strings and "root" are rejected at each step.
 */
function inferDisplayName(): string {
  const accept = (s: string | undefined): string | undefined => {
    const t = s?.trim();
    if (!t || t === 'root') return undefined;
    return t;
  };

  const git = spawnSync('git', ['config', '--global', 'user.name'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const gitName = accept(git.status === 0 ? git.stdout : undefined);
  if (gitName) return gitName;

  const user =
    accept(process.env.USER) ??
    accept(spawnSync('id', ['-un'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout);

  if (user) {
    if (process.platform === 'darwin') {
      const res = spawnSync('id', ['-F', user], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const name = accept(res.status === 0 ? res.stdout : undefined);
      if (name) return name;
    } else if (process.platform === 'linux') {
      // getent ships with glibc — present on WSL Ubuntu/Debian too. On a default
      // WSL user the GECOS field is empty, so this falls through to $USER.
      const res = spawnSync('getent', ['passwd', user], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (res.status === 0 && res.stdout) {
        const gecos = res.stdout.split(':')[4] ?? '';
        const name = accept(gecos.split(',')[0]);
        if (name) return name;
      }
    }
  }

  return user ?? 'User';
}

async function promptNames(inferred: string): Promise<{ displayName: string; agentName: string }> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const dAns = (await rl.question(`\nWhat should your agent call you? [${inferred}] `)).trim();
    const displayName = dAns || inferred;
    const aAns = (await rl.question(`What would you like to call your agent? [${displayName}] `)).trim();
    const agentName = aAns || displayName;
    return { displayName, agentName };
  } finally {
    rl.close();
  }
}

function runPing(): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(
      '\n── ping ────────────────────────────────────\n' +
        '[setup:auto] Sending ping — first container boot can take ~60s…',
    );
    const child = spawn('pnpm', ['run', 'chat', 'ping'], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
  });
}

function fail(msg: string, hint?: string): never {
  console.error(`\n[setup:auto] ${msg}`);
  if (hint) console.error(`            ${hint}`);
  console.error('            Logs: logs/setup.log');
  process.exit(1);
}

async function main(): Promise<void> {
  const skip = new Set(
    (process.env.NANOCLAW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!skip.has('environment')) {
    const env = await runStep('environment');
    if (!env.ok) fail('environment check failed');
  }

  if (!skip.has('container')) {
    const res = await runStep('container');
    if (!res.ok) {
      if (res.fields.ERROR === 'runtime_not_available') {
        fail(
          'Docker is not available and could not be started automatically.',
          'Install Docker Desktop or start it manually, then retry.',
        );
      }
      if (res.fields.ERROR === 'docker_group_not_active') {
        fail(
          'Docker was just installed but your shell is not yet in the `docker` group.',
          'Log out and back in (or run `newgrp docker` in a new shell), then retry `pnpm run setup:auto`.',
        );
      }
      fail(
        'container build/test failed',
        'For stale build cache: `docker builder prune -f`, then retry `pnpm run setup:auto`.',
      );
    }
    maybeReexecUnderSg();
  }

  if (!skip.has('onecli')) {
    const res = await runStep('onecli');
    if (!res.ok) {
      if (res.fields.ERROR === 'onecli_not_on_path_after_install') {
        fail(
          'OneCLI installed but not on PATH.',
          'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"`, then retry.',
        );
      }
      fail(
        `OneCLI install failed (${res.fields.ERROR ?? 'unknown'})`,
        'Check that curl + a writable ~/.local/bin are available; re-run `pnpm run setup:auto`.',
      );
    }
  }

  if (!skip.has('auth')) {
    if (anthropicSecretExists()) {
      console.log(
        '\n── auth ────────────────────────────────────\n' +
          '[setup:auto] OneCLI already has an Anthropic secret — skipping.',
      );
    } else {
      console.log('\n── auth ────────────────────────────────────');
      const code = await runBashScript('setup/register-claude-token.sh');
      if (code !== 0) {
        fail(
          'Anthropic credential registration failed or was aborted.',
          'Re-run `bash setup/register-claude-token.sh` or handle via `/setup` §4.',
        );
      }
    }
  }

  if (!skip.has('mounts')) {
    const res = await runStep('mounts', ['--empty']);
    if (!res.ok && res.fields.STATUS !== 'skipped') {
      fail('mount allowlist step failed');
    }
  }

  if (!skip.has('service')) {
    const res = await runStep('service');
    if (!res.ok) {
      fail(
        'service install failed',
        'Check logs/nanoclaw.error.log, or run `/setup` to iterate interactively.',
      );
    }
    if (res.fields.DOCKER_GROUP_STALE === 'true') {
      console.warn(
        '\n[setup:auto] Docker group stale in systemd session. Run:\n' +
          '             sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' +
          '             systemctl --user restart nanoclaw',
      );
    }
  }

  if (!skip.has('cli-agent')) {
    const displayName =
      process.env.NANOCLAW_DISPLAY_NAME?.trim() ||
      process.env.USER?.trim() ||
      'Operator';
    const agentName = process.env.NANOCLAW_AGENT_NAME?.trim();
    const args = ['--display-name', displayName];
    if (agentName) args.push('--agent-name', agentName);

    const res = await runStep('cli-agent', args);
    if (!res.ok) {
      fail(
        'CLI agent wiring failed',
        'Re-run `pnpm exec tsx scripts/init-cli-agent.ts --display-name "<your name>"` to fix.',
      );
    }
  }

  if (!skip.has('finalize') && !skip.has('cli-agent')) {
    const pingOk = await runPing();
    if (!pingOk) {
      console.warn(
        '\n[setup:auto] CLI agent did not respond to ping. The agent group is\n' +
          '             wired, but the pipeline may be stuck — check\n' +
          '             logs/nanoclaw.log. Skipping name prompts.',
      );
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      const { displayName, agentName } = await promptNames(inferDisplayName());
      const res = await runStep('rename-agent', [
        '--display-name',
        displayName,
        '--agent-name',
        agentName,
      ]);
      if (!res.ok && res.fields.STATUS !== 'skipped') {
        console.warn(
          '[setup:auto] rename-agent step failed — CLI agent keeps its current names.',
        );
      }
    }
  }

  if (!skip.has('verify')) {
    const res = await runStep('verify');
    if (!res.ok) {
      console.log('\n[setup:auto] Scripted steps done. Remaining (interactive):');
      if (res.fields.CREDENTIALS !== 'configured') {
        console.log('  • Anthropic secret not detected — re-run `bash setup/register-claude-token.sh`');
      }
      if (!res.fields.CONFIGURED_CHANNELS) {
        console.log(
          '  • Optional: add a messaging channel — `/add-discord`, `/add-slack`, `/add-telegram`, …',
        );
        console.log('    (CLI channel is already wired: `pnpm run chat hi`)');
      }
      return;
    }
  }

  console.log('\n[setup:auto] Complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
