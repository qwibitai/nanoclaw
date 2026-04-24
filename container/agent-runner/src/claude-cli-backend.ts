/**
 * Claude CLI backend — spawns `claude --print` for each invocation.
 * Parses stream-json output for session IDs, result text, and usage data.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { RunnerBackend, RunOptions, RunResult } from './runner-backend.js';

function log(message: string): void {
  console.error(`[claude-cli] ${message}`);
}

/**
 * Parse stream-json lines from Claude CLI stdout.
 * Each line is a JSON object with a `type` field.
 * We extract: session_id from system/init, result text, usage, and tool events.
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
  // Tool call fields
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

export class ClaudeCliBackend implements RunnerBackend {
  readonly supportsResume = true;
  private cliBin: string;
  private groupFolder: string = '';

  constructor(cliBin?: string) {
    this.cliBin = cliBin || process.env.AGENT_CLI_BIN || 'claude';
  }

  async invoke(prompt: string, options: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(prompt, options);
    log(`Spawning: ${this.cliBin} ${args.join(' ').slice(0, 300)}...`);

    // Extract group folder from env for tool event logging
    this.groupFolder = options.env.NANOCLAW_GROUP_FOLDER as string || '';

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
    const toolUseMap = new Map<string, { name: string; input: unknown }>();

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

      // Track tool_use invocations
      if (msg.type === 'tool_use' && msg.id && msg.name) {
        toolUseMap.set(msg.id, { name: msg.name, input: msg.input });
      }

      // Log tool_result events (matches tool_use by tool_use_id)
      if (msg.type === 'tool_result' && msg.tool_use_id && newSessionId) {
        const toolUse = toolUseMap.get(msg.tool_use_id);
        if (toolUse) {
          this.writeToolEvent(
            newSessionId,
            toolUse.name,
            msg.tool_use_id,
            toolUse.input,
            msg.content,
          );
          toolUseMap.delete(msg.tool_use_id);
        }
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

  /**
   * Write a tool call event to the IPC tool-events directory.
   * The host IPC watcher will pick it up and insert into the database.
   */
  private writeToolEvent(
    sessionId: string,
    toolName: string,
    toolUseId: string,
    toolInput: unknown,
    toolResponse: string | Array<{ type: string; text?: string }> | undefined,
  ): void {
    if (!this.groupFolder) return;

    // NANOCLAW_IPC_INPUT_DIR points to /data/ipc/{groupFolder}/input
    // We need to go up one level and then into tool-events
    const ipcInputDir = process.env.NANOCLAW_IPC_INPUT_DIR;
    if (!ipcInputDir) return;

    const ipcToolEventsDir = path.join(path.dirname(ipcInputDir), 'tool-events');

    try {
      fs.mkdirSync(ipcToolEventsDir, { recursive: true });

      let responseText = '';
      if (typeof toolResponse === 'string') {
        responseText = toolResponse;
      } else if (Array.isArray(toolResponse)) {
        responseText = toolResponse.map((c) => c.text || '').join('\n');
      }

      const event = {
        session_id: sessionId,
        hook_event: 'PostToolUse',
        tool_name: toolName,
        tool_use_id: toolUseId,
        tool_input: JSON.stringify(toolInput ?? {}),
        tool_response: responseText.slice(0, 2000),
      };

      const filename = `tool-${Date.now()}-${toolUseId.slice(0, 8)}.json`;
      const filepath = path.join(ipcToolEventsDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(event));

      log(`Tool event logged: ${toolName} (${toolUseId.slice(0, 8)})`);
    } catch (err) {
      log(`Failed to write tool event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
