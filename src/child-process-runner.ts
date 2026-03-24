import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface SpawnOptions {
  sessionKey: string;
  model: string;
  systemPrompt: string;
  onOutput?: (data: string) => void;
  onError?: (data: string) => void;
  onExit?: (code: number | null) => void;
}

export interface AgentSession {
  sessionKey: string;
  pid: number;
  process: ChildProcess;
  startedAt: Date;
}

export class ChildProcessRunner extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private maxConcurrent: number;

  constructor(config: { maxConcurrent: number }) {
    super();
    this.maxConcurrent = config.maxConcurrent;
  }

  async spawn(opts: SpawnOptions): Promise<AgentSession> {
    if (this.sessions.size >= this.maxConcurrent) {
      throw new Error(
        `Max concurrent agents reached (${this.maxConcurrent})`,
      );
    }
    if (this.sessions.has(opts.sessionKey)) {
      throw new Error(`Session ${opts.sessionKey} already exists`);
    }

    const args = [
      '--model',
      opts.model,
      '--output-format',
      'stream-json',
      ...(opts.systemPrompt
        ? ['--system-prompt', opts.systemPrompt]
        : []),
    ];

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }, // Inherits ANTHROPIC_BASE_URL (Bifrost sidecar)
    });

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
      opts.onError?.(data.toString());
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
