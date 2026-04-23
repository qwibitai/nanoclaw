/**
 * NanoClaw エージェントランナー
 * コンテナ内で実行され、標準入力から設定を受け取り、結果を標準出力に出力します。
 *
 * 入力プロトコル:
 *   標準入力: ContainerInput JSON 全体（EOF まで読み込み）
 *   IPC:     追撃メッセージ。/workspace/ipc/input/ に JSON ファイルとして書き込まれる。
 *            ファイル形式: {type:"message", text:"..."}.json — ポーリングして消費される。
 *            センチネル: /workspace/ipc/input/_close — セッション終了の合図。
 *
 * 標準出力プロトコル:
 *   各結果は OUTPUT_START_MARKER / OUTPUT_END_MARKER のペアでラップされる。
 *   ループ終了後の最終マーカーが完了の合図。
 */

import fs from 'fs';
import path from 'path';
import {
  createSession,
  FileStorage,
  resumeSession,
  type HookCallback,
  type HooksConfig,
  type PreCompactHookInput,
  type CodexOAuthOptions,
  type SDKMessage,
  type Session,
} from 'open-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  sessionProviderName?: string;
  groupFolder: string;
  chatJid: string;
  // NOTE: ホスト側の GroupType (src/types.ts) と同期が必要。コンテナはホストのソースを import できないため、ここで再定義している。
  // GroupType を変更した場合はこのファイルも更新すること。
  // NOTE: isMain (boolean) は意図的に削除。後方互換性は不要（個人プロジェクトのためホスト・コンテナは常にセットで更新する運用）。
  groupType?: 'override' | 'main' | 'chat' | 'thread';
  isScheduledTask?: boolean;
  assistantName?: string;
  selectedProvider?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  providerName?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

type GroupType = NonNullable<ContainerInput['groupType']>;
type SessionProvider = 'anthropic' | 'openai' | 'google' | 'codex';

interface CodexOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

interface SessionProviderConfig {
  name: string;
  provider: SessionProvider;
  model: string;
  apiKey?: string;
  baseURL?: string;
  codexOAuth?: CodexOAuthOptions;
}

interface ResolvedSessionProviders {
  providers: Record<string, SessionProviderConfig>;
  defaultProvider: string;
  fallbackProviders: string[];
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SESSION_STORAGE_DIR = '/workspace/group/.sessions';
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MODEL_BY_PROVIDER = {
  anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
  openai: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  google: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  codex: process.env.CODEX_MODEL || 'gpt-5.4',
} as const;
const ALLOWED_GROUP_TYPES = new Set<GroupType>([
  'override',
  'main',
  'chat',
  'thread',
]);
const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Skill',
  'TaskList',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'BashOutput',
  'KillBash',
  'mcp_nanoclaw_send_message',
  'mcp_nanoclaw_schedule_task',
  'mcp_nanoclaw_list_tasks',
  'mcp_nanoclaw_pause_task',
  'mcp_nanoclaw_resume_task',
  'mcp_nanoclaw_cancel_task',
  'mcp_nanoclaw_update_task',
  'mcp_nanoclaw_register_group',
];

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function resolveGroupType(rawGroupType: ContainerInput['groupType']): GroupType {
  if (rawGroupType && ALLOWED_GROUP_TYPES.has(rawGroupType)) {
    return rawGroupType;
  }
  return 'chat';
}

function isPrivilegedGroup(groupType: GroupType): boolean {
  return groupType === 'main' || groupType === 'override';
}

function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function toSdkEnv(env: Record<string, string | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      normalized[key] = value;
    }
  }
  return normalized;
}

function decodeJwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const exp = payload.exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCodexCliCredentials(
  value: Record<string, unknown>,
): CodexOAuthCredentials | undefined {
  const tokens = value.tokens;
  if (!tokens || typeof tokens !== 'object') {
    return undefined;
  }
  const t = tokens as Record<string, unknown>;
  const access = t.access_token;
  const refresh = t.refresh_token;
  if (typeof access !== 'string' || typeof refresh !== 'string') {
    return undefined;
  }
  const expires = decodeJwtExpiry(access);
  if (typeof expires !== 'number') {
    return undefined;
  }
  return {
    access,
    refresh,
    expires,
    ...(typeof t.account_id === 'string' ? { accountId: t.account_id } : {}),
  };
}

function normalizeCodexOAuthCredentials(
  value: unknown,
): CodexOAuthCredentials | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const direct = value as Record<string, unknown>;

  // Codex CLI format: { tokens: { access_token, refresh_token, account_id } }
  const cliFormat = normalizeCodexCliCredentials(direct);
  if (cliFormat) {
    return cliFormat;
  }

  // Direct format: { access, refresh, expires }
  if (
    typeof direct.access === 'string' &&
    typeof direct.refresh === 'string' &&
    typeof direct.expires === 'number'
  ) {
    return {
      access: direct.access,
      refresh: direct.refresh,
      expires: direct.expires,
      ...(typeof direct.accountId === 'string'
        ? { accountId: direct.accountId }
        : {}),
    };
  }

  // Provider map format: { "openai-codex": { access, refresh, expires } }
  const mapped = direct['openai-codex'];
  if (!mapped || typeof mapped !== 'object') {
    return undefined;
  }

  const nested = mapped as Record<string, unknown>;
  if (
    typeof nested.access === 'string' &&
    typeof nested.refresh === 'string' &&
    typeof nested.expires === 'number'
  ) {
    return {
      access: nested.access,
      refresh: nested.refresh,
      expires: nested.expires,
      ...(typeof nested.accountId === 'string'
        ? { accountId: nested.accountId }
        : {}),
    };
  }

  return undefined;
}

function parseCodexOAuthJson(oauthJson: string): CodexOAuthOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(oauthJson);
  } catch (err) {
    throw new Error(
      `OAS_CODEX_OAUTH_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const credentials = normalizeCodexOAuthCredentials(parsed);
  if (!credentials) {
    throw new Error(
      'OAS_CODEX_OAUTH_JSON must be an OAuth credentials object or a map containing "openai-codex".',
    );
  }

  return { credentials: credentials as CodexOAuthOptions['credentials'] };
}

function resolveLegacySessionProviderConfig(
  env: NodeJS.ProcessEnv,
): ResolvedSessionProviders {
  if (env.ANTHROPIC_API_KEY) {
    return {
      providers: {
        default: {
          name: 'default',
          provider: 'anthropic',
          model: DEFAULT_MODEL_BY_PROVIDER.anthropic,
          apiKey: env.ANTHROPIC_API_KEY,
          baseURL: env.ANTHROPIC_BASE_URL,
        },
      },
      defaultProvider: 'default',
      fallbackProviders: [],
    };
  }

  if (env.OPENAI_API_KEY) {
    return {
      providers: {
        default: {
          name: 'default',
          provider: 'openai',
          model: DEFAULT_MODEL_BY_PROVIDER.openai,
          apiKey: env.OPENAI_API_KEY,
          baseURL: env.OPENAI_BASE_URL,
        },
      },
      defaultProvider: 'default',
      fallbackProviders: [],
    };
  }

  if (env.GEMINI_API_KEY) {
    return {
      providers: {
        default: {
          name: 'default',
          provider: 'google',
          model: DEFAULT_MODEL_BY_PROVIDER.google,
          apiKey: env.GEMINI_API_KEY,
        },
      },
      defaultProvider: 'default',
      fallbackProviders: [],
    };
  }

  if (env.OAS_CODEX_OAUTH_JSON) {
    return {
      providers: {
        default: {
          name: 'default',
          provider: 'codex',
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          codexOAuth: parseCodexOAuthJson(env.OAS_CODEX_OAUTH_JSON),
        },
      },
      defaultProvider: 'default',
      fallbackProviders: [],
    };
  }

  throw new Error(
    'No provider credentials found. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OAS_CODEX_OAUTH_JSON.',
  );
}

function resolveSessionProviders(env: NodeJS.ProcessEnv): ResolvedSessionProviders {
  const raw = env.NANOCLAW_PROVIDER_CONFIG_JSON;
  if (!raw) {
    return resolveLegacySessionProviderConfig(env);
  }

  const parsed = JSON.parse(raw) as {
    providers?: Record<
      string,
      {
        provider: SessionProvider;
        model: string;
        apiKey?: string;
        baseURL?: string;
        codexOAuthJson?: string;
      }
    >;
    defaultProvider?: string;
    fallbackProviders?: string[];
  };

  if (!parsed.providers || typeof parsed.providers !== 'object') {
    throw new Error('NANOCLAW_PROVIDER_CONFIG_JSON requires a providers object.');
  }

  const providers: Record<string, SessionProviderConfig> = {};
  for (const [name, config] of Object.entries(parsed.providers)) {
    providers[name] = {
      name,
      provider: config.provider,
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.codexOAuthJson
        ? { codexOAuth: parseCodexOAuthJson(config.codexOAuthJson) }
        : {}),
    };
  }

  const defaultProvider = parsed.defaultProvider;
  if (!defaultProvider || !providers[defaultProvider]) {
    throw new Error(
      'NANOCLAW_PROVIDER_CONFIG_JSON defaultProvider is missing or unknown.',
    );
  }

  const fallbackProviders = (parsed.fallbackProviders || []).filter((name) => {
    return name !== defaultProvider && !!providers[name];
  });

  return {
    providers,
    defaultProvider,
    fallbackProviders,
  };
}

function extractAssistantText(message: SDKMessage): string | null {
  if (message.type !== 'assistant') {
    return null;
  }

  const text = message.message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return text || null;
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`セッションインデックスが見つかりません: ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `セッションインデックスの読み込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * コンパクション（要約）の前に、全履歴を conversations/ にアーカイブします。
 * NOTE: open-agent-sdk 側では PreCompact の自動発火が未実装のため、現時点ではプレースホルダーです。
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('アーカイブするための履歴が見つかりません');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('アーカイブするメッセージがありません');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`会話を ${filePath} にアーカイブしました`);
    } catch (err) {
      log(
        `履歴のアーカイブに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function createHooks(assistantName?: string): HooksConfig {
  return {
    PreCompact: [
      {
        hooks: [createPreCompactHook(assistantName)],
      },
    ],
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // ignore malformed line
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * _close センチネルを確認します。
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* 無視 */
    }
    return true;
  }
  return false;
}

/**
 * 保留中のすべての IPC 入力メッセージを吸い出します。
 * 見つかったメッセージの配列、または空の配列を返します。
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `入力ファイル ${file} の処理に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* 無視 */
        }
      }
    }
    return messages;
  } catch (err) {
    log(
      `IPC 吸い出しエラー: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * 新しい IPC メッセージまたは _close センチネルを待ちます。
 * メッセージを単一の文字列として返します。_close の場合は null を返します。
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

async function createOrResumeSession(
  requestedSessionId: string | undefined,
  requestedSessionProviderName: string | undefined,
  providerConfig: SessionProviderConfig,
  storage: FileStorage,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  mcpServerPath: string,
  groupType: GroupType,
  systemPrompt: string | undefined,
): Promise<Session> {
  const privileged = isPrivilegedGroup(groupType);
  const hooks = createHooks(containerInput.assistantName);

  if (requestedSessionId && requestedSessionProviderName === providerConfig.name) {
    if (!isUuid(requestedSessionId)) {
      log(
        `非 UUID の sessionId (${requestedSessionId}) を受信しました。セッション復帰を試みます。`,
      );
    }
    try {
      const resumeOptions = {
        storage,
        ...(providerConfig.apiKey ? { apiKey: providerConfig.apiKey } : {}),
        ...(providerConfig.codexOAuth
          ? { codexOAuth: providerConfig.codexOAuth }
          : {}),
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        hooks,
      };
      const resumed = await resumeSession(requestedSessionId, {
        ...resumeOptions,
      });
      log(
        `セッションを再開しました: ${resumed.id} (provider: ${providerConfig.name})`,
      );
      return resumed;
    } catch (err) {
      log(
        `セッション再開に失敗したため、新規作成へフォールバックします: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const created = await createSession({
    model: providerConfig.model,
    provider: providerConfig.provider,
    ...(providerConfig.apiKey ? { apiKey: providerConfig.apiKey } : {}),
    ...(providerConfig.baseURL ? { baseURL: providerConfig.baseURL } : {}),
    ...(providerConfig.codexOAuth
      ? { codexOAuth: providerConfig.codexOAuth }
      : {}),
    storage,
    cwd: '/workspace/group',
    env: toSdkEnv(sdkEnv),
    maxTurns: 50,
    allowedTools: ALLOWED_TOOLS,
    systemPrompt,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    mcpServers: {
      nanoclaw: {
        type: 'stdio',
        command: 'bun',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: privileged ? '1' : '0',
          NANOCLAW_GROUP_TYPE: groupType,
        },
      },
    },
    hooks,
  });

  log(
    `新規セッションを作成しました: ${created.id} (provider: ${providerConfig.name})`,
  );
  return created;
}

/**
 * 単一のクエリを実行し、結果を writeOutput 経由で出力します。
 * open-agent-sdk の Session API (create/resume + send/stream) を使用します。
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
): Promise<{
  newSessionId?: string;
  providerName?: string;
  shouldExit: boolean;
}> {
  const groupType = resolveGroupType(containerInput.groupType);
  const privileged = isPrivilegedGroup(groupType);
  const resolvedProviders = resolveSessionProviders(process.env);

  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!privileged && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  fs.mkdirSync(SESSION_STORAGE_DIR, { recursive: true });
  const storage = new FileStorage({ directory: SESSION_STORAGE_DIR });

  const preferredProvider =
    containerInput.selectedProvider &&
    resolvedProviders.providers[containerInput.selectedProvider]
      ? containerInput.selectedProvider
      : resolvedProviders.defaultProvider;
  const providerAttemptOrder = [
    preferredProvider,
    ...[resolvedProviders.defaultProvider, ...resolvedProviders.fallbackProviders]
      .filter((name) => name !== preferredProvider)
      .filter((name, index, values) => values.indexOf(name) === index),
  ];

  let resumeSessionId = sessionId;
  let resumeProviderName = containerInput.sessionProviderName;
  let lastError: Error | undefined;

  for (let attemptIndex = 0; attemptIndex < providerAttemptOrder.length; attemptIndex += 1) {
    const providerName = providerAttemptOrder[attemptIndex]!;
    const providerConfig = resolvedProviders.providers[providerName];
    let session: Session | undefined;
    let latestAssistantText: string | null = null;
    let streamedMessageCount = 0;
    let shouldExit = false;
    let ipcPollingActive = false;
    let ipcPollTimer: NodeJS.Timeout | undefined;
    let followupSendChain = Promise.resolve();

    try {
      session = await createOrResumeSession(
        resumeSessionId,
        resumeProviderName,
        providerConfig,
        storage,
        containerInput,
        sdkEnv,
        mcpServerPath,
        groupType,
        globalClaudeMd,
      );

      const stopIpcPolling = () => {
        ipcPollingActive = false;
        if (ipcPollTimer) {
          clearTimeout(ipcPollTimer);
          ipcPollTimer = undefined;
        }
      };

      const requestExit = (reason: string) => {
        if (shouldExit) return;
        shouldExit = true;
        log(reason);
        stopIpcPolling();
        void session
          ?.close()
          .catch((err) =>
            log(
              `プリエンプション時のセッションクローズに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      };

      const enqueueIpcFollowups = () => {
        const pending = drainIpcInput();
        if (pending.length === 0) return;

        const messages = [...pending];
        followupSendChain = followupSendChain
          .then(async () => {
            for (const text of messages) {
              if (shouldExit) return;
              log(
                `実行中セッションに IPC フォローアップを反映します (${text.length} 文字)`,
              );
              await session!.send(text);
            }
          })
          .catch((err) => {
            if (shouldExit) return;
            log(
              `実行中 IPC フォローアップ反映に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      };

      const pollIpcDuringStream = () => {
        if (!ipcPollingActive || shouldExit) return;
        if (shouldClose()) {
          requestExit('_close センチネルを検知したため、実行中クエリを終了します');
          return;
        }

        enqueueIpcFollowups();
        ipcPollTimer = setTimeout(pollIpcDuringStream, IPC_POLL_MS);
      };

      if (shouldClose()) {
        requestExit(
          '_close センチネルを検知したため、クエリ開始前に出力を抑止して終了します',
        );
        return {
          newSessionId: session.id,
          providerName,
          shouldExit,
        };
      }

      await session.send(prompt);

      ipcPollingActive = true;
      ipcPollTimer = setTimeout(pollIpcDuringStream, IPC_POLL_MS);
      enqueueIpcFollowups();

      try {
        for await (const message of session.stream()) {
          if (shouldExit) break;

          streamedMessageCount++;
          log(
            `[provider=${providerName}] [メッセージ #${streamedMessageCount}] type=${message.type}`,
          );

          const assistantText = extractAssistantText(message);
          if (assistantText) {
            latestAssistantText = assistantText;
          }

          if (shouldClose()) {
            requestExit(
              '_close センチネルを検知したため、ストリーミング出力を停止します',
            );
            break;
          }

          enqueueIpcFollowups();
        }
      } catch (err) {
        if (!shouldExit) {
          throw err;
        }
        log(
          `プリエンプションによりストリームを終了しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      stopIpcPolling();
      await followupSendChain;

      if (!shouldExit && shouldClose()) {
        requestExit('_close センチネルを検知したため、クエリ結果出力を抑止します');
      }

      if (shouldExit) {
        log(
          `クエリをプリエンプション終了しました。provider=${providerName}, streamedMessageCount=${streamedMessageCount}`,
        );
        return {
          newSessionId: session.id,
          providerName,
          shouldExit,
        };
      }

      writeOutput({
        status: 'success',
        result: latestAssistantText,
        newSessionId: session.id,
        providerName,
      });

      log(
        `クエリ終了。provider=${providerName}, streamedMessageCount=${streamedMessageCount}, resultLength=${latestAssistantText?.length || 0}`,
      );
      return {
        newSessionId: session.id,
        providerName,
        shouldExit: false,
      };
    } catch (err) {
      const attemptError =
        err instanceof Error ? err : new Error(String(err));
      lastError = attemptError;
      const canFallback =
        streamedMessageCount === 0 &&
        attemptIndex < providerAttemptOrder.length - 1 &&
        !shouldExit;
      if (canFallback) {
        log(
          `provider ${providerName} failed before first stream chunk; falling back: ${attemptError.message}`,
        );
        resumeSessionId = undefined;
        resumeProviderName = undefined;
        continue;
      }
      throw attemptError;
    } finally {
      ipcPollingActive = false;
      if (ipcPollTimer) {
        clearTimeout(ipcPollTimer);
        ipcPollTimer = undefined;
      }
      await followupSendChain;
      if (session) {
        try {
          await session.close();
        } catch (err) {
          log(
            `セッションクローズに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  throw lastError ?? new Error('No provider attempts succeeded.');
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* 存在しない可能性あり */
    }
    log(`グループ用の入力を受信しました: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `入力のパースに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // 認証情報はホスト側で注入される。
  // Anthropic/OpenAI は BASE_URL + placeholder を使ってプロキシ経由、
  // Gemini/Codex の直接注入は ALLOW_DIRECT_SECRET_INJECTION=true の明示オプトイン時のみ許可される。
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.ts');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // 以前のコンテナ実行から残っている古い _close センチネルをクリーンアップ
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* 無視 */
  }

  // 初期プロンプトを構築（保留中の IPC メッセージも吸い出す）
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[定期実行タスク - 以下のメッセージは自動的に送信されたものであり、ユーザーやグループから直接送信されたものではありません。]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(
      `${pending.length} 件の保留中 IPC メッセージを初期プロンプトに統合します`,
    );
    prompt += '\n' + pending.join('\n');
  }

  // クエリループ: クエリ実行 → IPC メッセージ待機 → 新しいクエリ実行 → 繰り返し
  try {
    while (true) {
      log(`クエリを開始します (セッション: ${sessionId || '新規'})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
        if (queryResult.providerName) {
          containerInput.sessionProviderName = queryResult.providerName;
        }
      }

      // runQuery 内で _close を検知した場合は、追加 OUTPUT を出さずに終了する。
      if (queryResult.shouldExit) {
        log('runQuery から終了シグナルを受信しました。出力を抑止して終了します');
        break;
      }

      // 実行中に _close が置かれた場合、セッション更新マーカーを出す前に終了する
      if (shouldClose()) {
        log('クローズセンチネルを受信しました。終了します');
        break;
      }

      // ホストが追跡できるようにセッション更新を出力
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        providerName: containerInput.sessionProviderName,
      });

      log('クエリが終了しました。次の IPC メッセージを待機中...');

      // 次のメッセージまたは _close センチネルを待機
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('クローズセンチネルを受信しました。終了します');
        break;
      }

      log(
        `新しいメッセージを受信しました (${nextMessage.length} 文字)。新しいクエリを開始します`,
      );
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`エージェントエラー: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      providerName: containerInput.sessionProviderName,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
