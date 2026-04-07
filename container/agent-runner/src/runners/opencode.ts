import * as fs from 'fs';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface RunnerOptions {
  prompt: string;
  sessionId?: string;
  containerInput: ContainerInput;
  mcpServerPath: string;
  sdkEnv: Record<string, string | undefined>;
  resumeAt?: string;
  onOutput: (output: ContainerOutput) => void;
  shouldClose: () => boolean;
  drainIpcInput: () => string[];
  log: (msg: string) => void;
}

export interface RunnerResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}

interface OcEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface OcPart {
  id: string;
  messageID: string;
  type: string;
  text?: string;
}

function readClaudeMd(containerInput: ContainerInput): string | undefined {
  const groupPath = '/workspace/group/CLAUDE.md';
  const globalPath = '/workspace/global/CLAUDE.md';
  let content = '';

  if (fs.existsSync(groupPath)) {
    content += fs.readFileSync(groupPath, 'utf-8');
  }

  if (!containerInput.isMain && fs.existsSync(globalPath)) {
    if (content) content += '\n\n---\n\n';
    content += fs.readFileSync(globalPath, 'utf-8');
  }

  return content || undefined;
}

function buildConfig(
  mcpServerPath: string,
  containerInput: ContainerInput,
): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model
    ? model.replace(new RegExp(`^${provider}/`), '')
    : undefined;
  const providerSmallModelId = smallModel
    ? smallModel.replace(new RegExp(`^${provider}/`), '')
    : undefined;

  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((id, i, a) => a.indexOf(id as string) === i);

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: { apiKey: 'placeholder', baseURL: proxyUrl },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((id) => [
                      id,
                      { id, name: id, tool_call: true },
                    ]),
                  ),
                }
              : {}),
          },
        };

  const bridgedMcps: Record<string, unknown> = {};
  const settingsPath = '/home/node/.claude/settings.json';
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      mcpServers?: Record<
        string,
        {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          type?: string;
          url?: string;
        }
      >;
    };
    for (const [name, cfg] of Object.entries(settings.mcpServers ?? {})) {
      if (cfg.command) {
        bridgedMcps[name] = {
          type: 'local',
          command: [cfg.command, ...(cfg.args ?? [])],
          ...(cfg.env ? { environment: cfg.env } : {}),
        };
      } else if (cfg.url) {
        bridgedMcps[name] = { type: 'remote', url: cfg.url };
      }
    }
  } catch {
    // settings.json absent or unreadable — proceed without extra MCPs
  }

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    mcp: {
      nanoclaw: {
        type: 'local',
        command: ['node', mcpServerPath],
        environment: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
      ...bridgedMcps,
    },
  };
}

export class OpenCodeRunner {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private server: { url: string; close(): void };
  private stream: AsyncGenerator<OcEvent>;
  private sessionId: string | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(
    client: any,
    server: { url: string; close(): void },
    stream: AsyncGenerator<OcEvent>,
  ) {
    this.client = client;
    this.server = server;
    this.stream = stream;
  }

  static async create(
    mcpServerPath: string,
    containerInput: ContainerInput,
  ): Promise<OpenCodeRunner> {
    if (!createOpencode) {
      createOpencode = await getCreateOpencode();
    }
    const config = buildConfig(mcpServerPath, containerInput);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { client, server } = await (createOpencode as any)({ config });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eventsResult = await (client as any).event.subscribe();
    return new OpenCodeRunner(client, server, eventsResult.stream);
  }

  async runQuery(opts: RunnerOptions): Promise<RunnerResult> {
    const {
      prompt,
      sessionId: inputSessionId,
      onOutput,
      shouldClose,
      log,
    } = opts;

    if (!this.sessionId) {
      if (inputSessionId) {
        this.sessionId = inputSessionId;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessResp = await (this.client as any).session.create();
        this.sessionId = sessResp.data?.id as string | undefined;
        if (!this.sessionId)
          throw new Error('OpenCode: failed to create session');
        log(`OpenCode session created: ${this.sessionId}`);
      }
    }
    const id = this.sessionId;

    // Re-read CLAUDE.md on every query (unlike Claude Code which does this
    // automatically, OpenCode needs us to inject it each time).
    const claudeMd = readClaudeMd(opts.containerInput);
    const effectivePrompt = claudeMd
      ? `<system>\n${claudeMd}\n</system>\n\n${prompt}`
      : prompt;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.client as any).session.promptAsync({
      path: { id },
      body: { parts: [{ type: 'text', text: effectivePrompt }] },
    });

    let closedDuringQuery = false;
    const partTextByMessageId = new Map<string, string>();
    const roleByMessageId = new Map<string, string>();

    const IDLE_TIMEOUT_MS = 90_000;
    let lastEventAt = Date.now();
    const timeoutCheck = setInterval(() => {
      if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
        log(
          `OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — aborting session ${id}`,
        );
        this.sessionId = undefined;
        this.server.close();
      }
    }, 5000);

    try {
      while (true) {
        const { value: ev, done } = await this.stream.next();
        if (done) break;

        if (
          !ev?.type ||
          ev.type === 'server.heartbeat' ||
          ev.type === 'server.connected'
        )
          continue;

        lastEventAt = Date.now();
        log(`[ev] ${ev.type} ${JSON.stringify(ev.properties).slice(0, 200)}`);

        if (ev.type === 'message.updated') {
          const info = ev.properties?.info as
            | { id?: string; role?: string }
            | undefined;
          if (info?.id && info?.role) {
            roleByMessageId.set(info.id, info.role);
          }
        }

        if (ev.type === 'message.part.updated') {
          const part = ev.properties?.part as OcPart | undefined;
          if (part?.type === 'text' && part.messageID && part.text) {
            partTextByMessageId.set(part.messageID, part.text);
          }
        }

        if (ev.type === 'session.idle') {
          const props = ev.properties as { sessionID?: string } | undefined;
          if (props?.sessionID === id) {
            log('OpenCode session idle');
            break;
          }
        }

        if (ev.type === 'session.error') {
          const props = ev.properties as
            | { sessionID?: string; error?: { data?: { message?: string } } }
            | undefined;
          const errMsg =
            props?.error?.data?.message ||
            JSON.stringify(props?.error) ||
            'OpenCode session error';
          log(`OpenCode error: ${errMsg}`);
          if (props?.sessionID === id) {
            this.sessionId = undefined;
          }
          onOutput({ status: 'error', result: null, error: errMsg });
          return { closedDuringQuery: false };
        }

        if (shouldClose()) {
          closedDuringQuery = true;
          break;
        }
      }
    } finally {
      clearInterval(timeoutCheck);
    }

    let resultText = '';
    for (const [msgId, role] of roleByMessageId) {
      if (role === 'assistant') {
        resultText = partTextByMessageId.get(msgId) ?? resultText;
      }
    }

    if (!closedDuringQuery) {
      onOutput({ status: 'success', result: resultText, newSessionId: id });
    }

    log(
      `OpenCode query done. result_len=${resultText.length} closedDuringQuery=${closedDuringQuery}`,
    );
    return { newSessionId: id, closedDuringQuery };
  }

  close(): void {
    this.server.close();
    // Explicitly close the SSE stream so its underlying HTTP socket is released.
    // We use manual .next() iteration (not for-await) to keep the stream alive
    // across multiple queries — so generator.return() is never called automatically.
    // Without this, the open socket keeps the Node.js event loop alive indefinitely.
    this.stream.return?.(undefined);
  }
}

// Lazy import — only loaded when AGENT_RUNNER=opencode
async function getCreateOpencode() {
  const mod = await import('@opencode-ai/sdk');
  return mod.createOpencode;
}

let createOpencode: typeof import('@opencode-ai/sdk').createOpencode;
