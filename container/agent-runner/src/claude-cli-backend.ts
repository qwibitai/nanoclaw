/**
 * Claude CLI backend — spawns `claude --print` for each invocation.
 * Parses stream-json output for session IDs, result text, and usage data.
 */

import { spawn } from 'child_process';
import type { RunnerBackend, RunOptions, RunResult } from './runner-backend.js';

function log(message: string): void {
  console.error(`[claude-cli] ${message}`);
}

/**
 * Parse stream-json lines from Claude CLI stdout.
 * Each line is a JSON object with a `type` field.
 * We extract: session_id from system/init, result text, and usage.
 */
interface StreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  modelUsage?: Record<string, { contextWindow?: number }>;
}

export class ClaudeCliBackend implements RunnerBackend {
  readonly supportsResume = true;
  private cliBin: string;

  constructor(cliBin?: string) {
    this.cliBin = cliBin || process.env.AGENT_CLI_BIN || 'claude';
  }

  async invoke(prompt: string, options: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(prompt, options);
    log(`Spawning: ${this.cliBin} ${args.join(' ').slice(0, 300)}...`);

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(this.cliBin, args, {
        cwd: options.cwd,
        env: this.buildEnv(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        // Forward stderr for visibility
        process.stderr.write(chunk);
      });

      // Write prompt to stdin then close it
      child.stdin.write(prompt);
      child.stdin.end();

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn ${this.cliBin}: ${err.message}`));
      });

      child.on('close', (code) => {
        const exitCode = code ?? 1;
        const result = this.parseStreamOutput(stdout, exitCode);
        log(`CLI exited ${exitCode}, sessionId=${result.newSessionId || 'none'}, output=${result.output?.length || 0} chars`);
        resolve(result);
      });
    });
  }

  private buildArgs(prompt: string, options: RunOptions): string[] {
    const args: string[] = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--permission-mode', 'bypassPermissions',
      '--setting-sources', 'project,user',
    ];

    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    }

    if (options.mcpConfigPath) {
      args.push('--mcp-config', options.mcpConfigPath);
      args.push('--strict-mcp-config');
    }

    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }

    if (options.additionalDirs) {
      for (const dir of options.additionalDirs) {
        args.push('--add-dir', dir);
      }
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    // Prompt is passed via stdin, not as positional arg (avoids shell escaping issues)
    return args;
  }

  private buildEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  private parseStreamOutput(stdout: string, exitCode: number): RunResult {
    let newSessionId: string | undefined;
    let resultText: string | null = null;
    let usage: { inputTokens: number; contextWindow: number } | undefined;

    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;

      let msg: StreamMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      // Extract session ID from system/init message
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        newSessionId = msg.session_id;
      }

      // Extract result text
      if (msg.type === 'result' && msg.result !== undefined) {
        resultText = msg.result;

        // Extract usage from result message
        if (msg.usage) {
          const inputTokens = (msg.usage.input_tokens || 0)
            + (msg.usage.cache_creation_input_tokens || 0)
            + (msg.usage.cache_read_input_tokens || 0);

          let contextWindow = 0;
          if (msg.modelUsage) {
            for (const model of Object.values(msg.modelUsage)) {
              if (model.contextWindow && model.contextWindow > 0) {
                contextWindow = model.contextWindow;
                break;
              }
            }
          }

          if (contextWindow > 0) {
            usage = { inputTokens, contextWindow };
          }
        }
      }
    }

    return {
      output: resultText,
      newSessionId,
      exitCode,
      usage,
    };
  }
}
