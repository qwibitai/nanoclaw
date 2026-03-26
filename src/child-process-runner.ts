import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync, existsSync } from 'fs';
import type {
  AgentRunner,
  SpawnOptions as ISpawnOptions,
  AgentSession as IAgentSession,
} from './management/agent-runner.js';

export interface SpawnOptions extends ISpawnOptions {
  cwd?: string;
  onOutput?: (data: string) => void;
  onError?: (data: string) => void;
  onExit?: (code: number | null) => void;
}

export interface AgentSession extends IAgentSession {
  pid: number;
  process: ChildProcess;
}

/**
 * Load key=value pairs from a .env file and return as a Record.
 * Skips blank lines and comments (#). Strips optional quotes from values.
 */
function loadDotEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes (single or double)
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  } catch {
    // If the file can't be read, return empty — don't crash the spawn
  }
  return env;
}

const DOTENV_PATH = '/home/node/.nanoclaw/.env';

export class ChildProcessRunner extends EventEmitter implements AgentRunner {
  private sessions = new Map<string, AgentSession>();
  private maxConcurrent: number;

  constructor(config: { maxConcurrent: number }) {
    super();
    this.maxConcurrent = config.maxConcurrent;
  }

  async spawn(opts: SpawnOptions): Promise<AgentSession> {
    if (this.sessions.size >= this.maxConcurrent) {
      throw new Error(`Max concurrent agents reached (${this.maxConcurrent})`);
    }
    if (this.sessions.has(opts.sessionKey)) {
      throw new Error(`Session ${opts.sessionKey} already exists`);
    }

    const args = [
      '-p', // Print/pipe mode — required for non-interactive use
      '--verbose', // Required: stream-json needs --verbose in print mode
      '--model',
      opts.model,
      '--output-format',
      'stream-json',
      '--include-partial-messages', // Emit stream_event with text_delta for real-time streaming
      '--dangerously-skip-permissions', // Required — no TTY to accept permissions
      ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
      ...(opts.systemPrompt ? ['--system-prompt', opts.systemPrompt] : []),
      ...(opts.initialPrompt ? [opts.initialPrompt] : []), // Positional arg: the user message
    ];

    // Merge process.env with .env file written by ApplyConfig (contains
    // ANTHROPIC_API_KEY for dev or ANTHROPIC_BASE_URL for Bifrost/prod).
    // .env values take precedence so the config bridge can override defaults.
    const dotEnv = loadDotEnv(DOTENV_PATH);
    const childEnv = { ...process.env, ...dotEnv };

    // Pre-flight: Claude CLI requires credentials to authenticate. Without
    // them it exits with "Not logged in · Please run /login". Fail fast with
    // a clear message instead.
    //
    // Supported credential env vars (checked in priority order by the CLI):
    //   ANTHROPIC_AUTH_TOKEN       — bearer token (rarely used directly)
    //   CLAUDE_CODE_OAUTH_TOKEN    — setup-token / subscription OAuth token
    //   ANTHROPIC_API_KEY          — standard API key (sk-ant-api03-*)
    //   ANTHROPIC_BASE_URL         — proxy (e.g. Bifrost sidecar)
    const hasCredentials =
      childEnv.ANTHROPIC_API_KEY ||
      childEnv.ANTHROPIC_BASE_URL ||
      childEnv.CLAUDE_CODE_OAUTH_TOKEN ||
      childEnv.ANTHROPIC_AUTH_TOKEN;

    if (!hasCredentials) {
      throw new Error(
        'No Anthropic credentials configured. Call ApplyConfig with your ' +
          'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN before sending messages.',
      );
    }

    // If a setup-token (sk-ant-oat*) was placed in ANTHROPIC_API_KEY by
    // mistake, move it to CLAUDE_CODE_OAUTH_TOKEN where the CLI expects it.
    if (
      childEnv.ANTHROPIC_API_KEY &&
      childEnv.ANTHROPIC_API_KEY.startsWith('sk-ant-oat') &&
      !childEnv.CLAUDE_CODE_OAUTH_TOKEN
    ) {
      childEnv.CLAUDE_CODE_OAUTH_TOKEN = childEnv.ANTHROPIC_API_KEY;
      delete childEnv.ANTHROPIC_API_KEY;
    }

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    // When initialPrompt is set, the message is passed as a positional arg
    // and stdin isn't needed. Close it to prevent the "no stdin data" warning.
    // When no initialPrompt, keep stdin open for sendMessage() (multi-turn).
    if (opts.initialPrompt) {
      proc.stdin?.end();
    }

    const session: AgentSession = {
      sessionKey: opts.sessionKey,
      pid: proc.pid!,
      process: proc,
      startedAt: new Date(),
    };

    proc.stdout?.on('data', (data: Buffer) => {
      const str = data.toString();
      opts.onOutput?.(str);
      this.emit('output', opts.sessionKey, str);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const str = data.toString();
      opts.onError?.(str);
      this.emit('stderr', opts.sessionKey, str);
    });

    proc.on('exit', (code) => {
      this.sessions.delete(opts.sessionKey);
      opts.onExit?.(code);
      this.emit('exit', opts.sessionKey, code);
    });

    this.sessions.set(opts.sessionKey, session);
    return session;
  }

  async sendMessage(sessionKey: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) throw new Error(`Session ${sessionKey} not found`);
    session.process.stdin?.write(message + '\n');
  }

  async kill(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.process.kill('SIGTERM');
    this.sessions.delete(sessionKey);
  }

  async killAll(): Promise<void> {
    for (const [key] of this.sessions) {
      await this.kill(key);
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  getSession(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey);
  }
}
