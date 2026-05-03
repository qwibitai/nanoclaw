/**
 * baget-channel-secret — persist baget.ai's per-(user, company) bearer
 * token into the OneCLI vault.
 *
 * IMPORTANT — runtime scope:
 *   This module is DOCKER-MODE ONLY. The admin server gates the call
 *   site on `process.env.RUNTIME === 'docker'`. Single-process mode
 *   (Baget on Railway) persists the same token into local SQLite via
 *   `src/db/baget-channel-tokens.ts` and injects it directly into the
 *   spawn env — no OneCLI gateway required, no shellout to a binary
 *   that isn't installed in the Railway image.
 *
 *   We keep this helper alive specifically because the fork's deploy
 *   doc still claims docker-mode support. Any non-Baget operator
 *   running `RUNTIME=docker` (with a real OneCLI gateway provisioned)
 *   continues to get the same secret-injection behavior they had
 *   before the SQLite migration. Docker-mode containers can't read
 *   the host's SQLite file, so SQLite alone is not enough for them —
 *   the gateway proxy is the load-bearing injection layer.
 *
 * Why a CLI shell-out (not the SDK):
 *   The `@onecli-sh/sdk` v0.3.x does NOT expose secret-management
 *   methods — only `getContainerConfig` / `applyContainerConfig`,
 *   `ensureAgent`, and `configureManualApproval`. Secret CRUD is
 *   CLI-only. The auth-step setup script (`setup/auth.ts`) uses the
 *   same execFileSync pattern for `Anthropic` token creation; this
 *   module mirrors that pattern for our per-founder bearer.
 *
 * Why `--type bearer`:
 *   OneCLI's secret types steer the gateway's request-injection
 *   behavior. `bearer` is the right choice here — when the agent
 *   container fetches a host matching `host-pattern`, OneCLI's proxy
 *   substitutes `Authorization: Bearer <value>` into the outbound
 *   request. The MCP tool reads `process.env.BAGET_CHANNEL_TOKEN`
 *   directly though, so the host-pattern injection is belt-and-
 *   braces — both paths work.
 *
 * Idempotency:
 *   `onecli secrets create` on a duplicate name errors. We delete-
 *   then-create so a re-pair on the same (user, company) tuple lands
 *   the new token cleanly. The delete is best-effort — a "not found"
 *   error from OneCLI is fine because the create below will land it.
 *
 * Safety:
 *   - `tokenValue` is passed via execFileSync's array form (NOT a
 *     shell string), so shell metacharacters in the token can't
 *     execute. This is the same defense as `setup/auth.ts`.
 *   - The token NEVER appears in any log line. Errors strip stderr
 *     before logging because OneCLI sometimes echoes the failed CLI
 *     args (with --value).
 *   - This module is server-side only — never bundled to a client.
 */
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

import { log } from './log.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

/**
 * Build the env passed to `onecli` so $PATH includes ~/.local/bin
 * (where the OneCLI installer lands the binary). Mirrors the helper
 * in `setup/onecli.ts` and `setup/auth.ts`.
 */
function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

/**
 * Strip ANY occurrence of the secret value from an error string before
 * logging. OneCLI's CLI sometimes echoes the failed argv (which
 * includes `--value <token>`) into stderr; without this scrub we'd
 * leak the bearer into our log pipeline + Sentry.
 */
function scrubSecret(text: string, secret: string): string {
  if (!secret) return text;
  // Plain replace + a regex for url-encoded variants, just in case.
  let scrubbed = text.split(secret).join('<REDACTED>');
  // base64url encoding of 32 bytes is 43 chars [A-Za-z0-9_-]; if the
  // env or argv echoed a transformed shape we still don't want it
  // logged. Match-and-redact any 30+ char base64url-shaped run.
  scrubbed = scrubbed.replace(/[A-Za-z0-9_-]{30,}/g, '<REDACTED-LONG-TOKEN>');
  return scrubbed;
}

export interface PersistChannelTokenArgs {
  /** OneCLI agent name — must match the value passed to
   *  `onecli.ensureAgent({ name })` at spawn time. We use
   *  `agentGroup.name` (= `companyName`-or-fallback). */
  agentName: string;
  /** The credential name baget.ai already passed in
   *  `channelTokenCredentialName`. Format:
   *  `baget-channel-token-<userPrefix>-<companyPrefix>` (per
   *  baget.ai's `buildChannelTokenCredentialName`). */
  credentialName: string;
  /** Plaintext bearer token from baget.ai. NEVER log this. */
  tokenValue: string;
  /** Hostname OneCLI matches outgoing fetches against to inject the
   *  bearer. Derived from `bagetApiBaseUrl` (the founder's env). */
  hostPattern: string;
}

/**
 * Persist a baget.ai per-(user, company) bearer into the OneCLI vault.
 * Caller MUST verify `process.env.RUNTIME === 'docker'` before calling
 * — single-process mode uses the SQLite path in
 * `src/db/baget-channel-tokens.ts` instead and this shellout will
 * ENOENT on Railway because the binary isn't installed.
 */
export async function persistChannelTokenToOneCLI(args: PersistChannelTokenArgs): Promise<void> {
  // ── 1. Best-effort delete (idempotency: re-pair must overwrite) ──
  try {
    execFileSync('onecli', ['secrets', 'delete', '--name', args.credentialName], {
      env: childEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    log.info('Baget channel-token: deleted prior OneCLI secret for re-pair', {
      credentialName: args.credentialName,
    });
  } catch {
    // Not-found is fine — the create below lands it fresh. Don't
    // surface this to the caller; an "already missing" delete is
    // structurally indistinguishable from "wasn't there to begin
    // with" via the CLI exit code, and we don't care which it is.
  }

  // ── 2. Create the per-founder bearer secret ──
  try {
    execFileSync(
      'onecli',
      [
        'secrets',
        'create',
        '--name',
        args.credentialName,
        '--type',
        'bearer',
        '--value',
        args.tokenValue,
        '--host-pattern',
        args.hostPattern,
        '--agent',
        args.agentName,
      ],
      {
        env: childEnv(),
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    log.info('Baget channel-token: persisted via OneCLI (docker mode)', {
      credentialName: args.credentialName,
      agentName: args.agentName,
      hostPattern: args.hostPattern,
      // tokenValue intentionally omitted — never log credentials.
    });
  } catch (err) {
    const e = err as { stderr?: string | Buffer; status?: number; message?: string };
    const rawStderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? '');
    const stderr = scrubSecret(rawStderr, args.tokenValue);
    const message = scrubSecret(e.message ?? 'unknown', args.tokenValue);
    log.error('Baget channel-token: OneCLI persist failed', {
      credentialName: args.credentialName,
      agentName: args.agentName,
      exitCode: e.status ?? -1,
      stderr,
      message,
    });
    throw new Error(`onecli secrets create failed (exit ${e.status ?? -1})`);
  }
}
