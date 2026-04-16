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
  type SDKMessage,
  type Session,
} from 'open-agent-sdk/packages/core/src/index.ts';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  // NOTE: ホスト側の GroupType (src/types.ts) と同期が必要。コンテナはホストのソースを import できないため、ここで再定義している。
  // GroupType を変更した場合はこのファイルも更新すること。
  // NOTE: isMain (boolean) は意図的に削除。後方互換性は不要（個人プロジェクトのためホスト・コンテナは常にセットで更新する運用）。
  groupType?: 'override' | 'main' | 'chat' | 'thread';
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
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

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SESSION_STORAGE_DIR = '/workspace/group/.sessions';
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
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
  storage: FileStorage,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  mcpServerPath: string,
  groupType: GroupType,
  systemPrompt: string | undefined,
): Promise<Session> {
  const privileged = isPrivilegedGroup(groupType);
  const apiKey = process.env.ANTHROPIC_API_KEY || 'placeholder';
  const hooks = createHooks(containerInput.assistantName);

  if (requestedSessionId) {
    if (!isUuid(requestedSessionId)) {
      log(
        `非 UUID の sessionId (${requestedSessionId}) を受信したため、新規セッションを開始します`,
      );
    } else {
      try {
        const resumed = await resumeSession(requestedSessionId, {
          storage,
          apiKey,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          hooks,
        });
        log(`セッションを再開しました: ${resumed.id}`);
        return resumed;
      } catch (err) {
        log(
          `セッション再開に失敗したため、新規作成へフォールバックします: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const created = await createSession({
    model: DEFAULT_ANTHROPIC_MODEL,
    provider: 'anthropic',
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL,
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

  log(`新規セッションを作成しました: ${created.id}`);
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
}> {
  const groupType = resolveGroupType(containerInput.groupType);
  const privileged = isPrivilegedGroup(groupType);

  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!privileged && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  fs.mkdirSync(SESSION_STORAGE_DIR, { recursive: true });
  const storage = new FileStorage({ directory: SESSION_STORAGE_DIR });

  let session: Session | undefined;
  let latestAssistantText: string | null = null;
  let streamedMessageCount = 0;

  try {
    session = await createOrResumeSession(
      sessionId,
      storage,
      containerInput,
      sdkEnv,
      mcpServerPath,
      groupType,
      globalClaudeMd,
    );

    await session.send(prompt);

    for await (const message of session.stream()) {
      streamedMessageCount++;
      log(`[メッセージ #${streamedMessageCount}] type=${message.type}`);

      const assistantText = extractAssistantText(message);
      if (assistantText) {
        latestAssistantText = assistantText;
      }
    }

    writeOutput({
      status: 'success',
      result: latestAssistantText,
      newSessionId: session.id,
    });

    log(
      `クエリ終了。streamedMessageCount=${streamedMessageCount}, resultLength=${latestAssistantText?.length || 0}`,
    );
    return { newSessionId: session.id };
  } finally {
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

  // 認証情報はホストの認証情報プロキシによって ANTHROPIC_BASE_URL 経由で注入されます。コンテナ環境には本物のシークレットは存在しません。
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
      }

      // 実行中に _close が置かれた場合、セッション更新マーカーを出す前に終了する
      if (shouldClose()) {
        log('クローズセンチネルを受信しました。終了します');
        break;
      }

      // ホストが追跡できるようにセッション更新を出力
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

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
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
