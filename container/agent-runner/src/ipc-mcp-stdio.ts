/**
 * NanoClaw 用 Stdio MCP サーバー
 * エージェントチームのサブエージェントが継承できるスタンドアロンプロセス。
 * 環境変数からコンテキストを読み取り、ホスト用の IPC ファイルを書き出します。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// 環境変数からのコンテキスト（エージェントランナーによって設定されます）
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
// NOTE: ホスト側の GroupType (src/types.ts) と同期が必要。
// コンテナはホストのソースを import できないため、ここで再定義している。
// GroupType を変更した場合はこのファイルも更新すること。
const allowedGroupTypes = new Set(['override', 'main', 'chat', 'thread']);
const rawGroupType = process.env.NANOCLAW_GROUP_TYPE;
const groupTypeCandidate = rawGroupType ?? (process.env.NANOCLAW_IS_MAIN === '1' ? 'main' : 'chat');
const groupType = allowedGroupTypes.has(groupTypeCandidate) ? groupTypeCandidate : 'chat';
const isPrivileged = groupType === 'main' || groupType === 'override';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // アトミックな書き込み: 一時ファイルを作成してからリネーム
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  '実行中に、ユーザーまたはグループに即座にメッセージを送信します。進捗状況の報告や、複数のメッセージを送信する場合に使用してください。このツールは複数回呼び出すことができます。',
  {
    text: z.string().describe('送信するメッセージ本文'),
    sender: z.string().optional().describe('あなたの役割/識別名（例: "調査員"）。設定すると、Telegram では専用のボットからのメッセージとして表示されます。'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'メッセージを送信しました。' }] };
  },
);

server.tool(
  'schedule_task',
  `定期実行または単発のタスクをスケジュールします。タスクは、すべてのツールにアクセスできるフル機能のエージェントとして実行されます。後で参照するためのタスク ID を返します。既存のタスクを修正するには、代わりに update_task を使用してください。

コンテキストモード - タスクのタイプに合わせて選択してください:
\u2022 "group": グループの会話コンテキスト内で実行され、チャット履歴にアクセスできます。進行中の議論、ユーザーの好み、最近のやり取りに関するコンテキストが必要なタスクに使用してください。
\u2022 "isolated": 会話履歴のない新しいセッションで実行されます。以前のコンテキストを必要としない独立したタスクに使用してください。isolated モードを使用する場合は、必要なすべてのコンテキストをプロンプト自体に含めてください。

どちらのモードを使用すべきか不明な場合は、ユーザーに尋ねることができます。例:
- "私たちの議論について思い出させて" \u2192 group (会話コンテキストが必要)
- "毎朝の天気をチェックして" \u2192 isolated (自己完結型のタスク)
- "私の依頼をフォローアップして" \u2192 group (何を依頼されたか知る必要がある)
- "日報を生成して" \u2192 isolated (プロンプト内の指示だけで十分)

メッセージング動作 - タスクエージェントの出力はユーザーまたはグループに送信されます。即座に配信するために send_message を使用したり、出力を <internal> タグで囲んで抑制したりすることもできます。エージェントが以下をすべきかについて、プロンプトにガイダンスを含めてください:
\u2022 常にメッセージを送信する（例：リマインダー、日次のブリーフィング）
\u2022 報告すべきことがあるときだけメッセージを送信する（例：「〜の場合に通知して」）
\u2022 決してメッセージを送信しない（バックグラウンドのメンテナンスプロセス）

スケジュール値の形式 (すべてローカルタイムゾーンです):
\u2022 cron: 標準の cron 式（例：5分おきなら "*/5 * * * *"、毎日ローカル時間の午前9時なら "0 9 * * *"）
\u2022 interval: 実行間のミリ秒数（例：5分なら "300000"、1時間なら "3600000"）
\u2022 once: "Z" サフィックスなしのローカル時間（例: "2026-02-01T15:30:00"）。UTC/Z サフィックスは使用しないでください。`,
  {
    prompt: z.string().describe('タスク実行時にエージェントがすべきこと。isolated モードの場合は、ここに必要なすべてのコンテキストを含めてください。'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=特定の時刻に定期実行、interval=指定したミリ秒ごと、once=特定の時刻に一度だけ実行'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: "300000" などのミリ秒 | once: "2026-02-01T15:30:00" などのローカルタイムスタンプ（Zサフィックス禁止！）'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=チャット履歴とメモリを使用して実行、isolated=新規セッション（プロンプトにコンテキストを含めること）'),
    target_group_jid: z.string().optional().describe('(メイングループのみ) タスクをスケジュールする対象グループの JID。デフォルトは現在のグループ。'),
  },
  async (args) => {
    // IPC 書き出し前に schedule_value を検証
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `無効な cron です: "${args.schedule_value}"。"0 9 * * *" (毎日午前9時) や "*/5 * * * *" (5分おき) のような形式を使用してください。` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `無効なインターバルです: "${args.schedule_value}"。正のミリ秒を指定してください（例: 5分なら "300000"）。` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `タイムスタンプはタイムゾーンサフィックスなしのローカル時間である必要があります。"${args.schedule_value}" が指定されました。"2026-02-01T15:30:00" のような形式を使用してください。` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `無効なタイムスタンプです: "${args.schedule_value}"。"2026-02-01T15:30:00" のようなローカル時間の形式を使用してください。` }],
          isError: true,
        };
      }
    }

    // メイン以外のグループは自分自身に対してのみスケジュール可能
    const targetJid = isPrivileged && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `タスク ${taskId} をスケジュールしました: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  'スケジュールされているすべてのタスクを一覧表示します。メイングループからはすべてのタスクが表示されます。他のグループからは、そのグループ自身のタスクのみが表示されます。',
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'スケジュールされたタスクは見つかりませんでした。' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isPrivileged
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'スケジュールされたタスクは見つかりませんでした。' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `スケジュールされたタスク:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `タスクの読み込みエラー: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'スケジュールされたタスクを一時停止します。再開されるまで実行されません。',
  { task_id: z.string().describe('一時停止するタスクの ID') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isPrivileged,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `タスク ${args.task_id} の一時停止をリクエストしました。` }] };
  },
);

server.tool(
  'resume_task',
  '一時停止中のタスクを再開します。',
  { task_id: z.string().describe('再開するタスクの ID') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isPrivileged,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `タスク ${args.task_id} の再開をリクエストしました。` }] };
  },
);

server.tool(
  'cancel_task',
  'スケジュールされたタスクをキャンセルして削除します。',
  { task_id: z.string().describe('削除するタスクの ID') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isPrivileged,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `タスク ${args.task_id} のキャンセルをリクエストしました。` }] };
  },
);

server.tool(
  'update_task',
  '既存のスケジュールタスクを更新します。指定されたフィールドのみが変更され、省略されたフィールドはそのまま保持されます。',
  {
    task_id: z.string().describe('更新するタスクの ID'),
    prompt: z.string().optional().describe('タスクの新しいプロンプト'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('新しいスケジュールタイプ'),
    schedule_value: z.string().optional().describe('新しいスケジュール値（形式については schedule_task を参照）'),
  },
  async (args) => {
    // スケジュール値が提供されている場合は検証
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `無効な cron です: "${args.schedule_value}"。` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `無効なインターバルです: "${args.schedule_value}"。` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isPrivileged: String(isPrivileged),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `タスク ${args.task_id} の更新をリクエストしました。` }] };
  },
);

server.tool(
  'register_group',
  `新しいチャット/グループを登録して、エージェントがそこでメッセージに応答できるようにします。メイングループのみが実行可能です。

グループの JID を見つけるには available_groups.json を使用してください。フォルダ名はチャネルプレフィックス付きの "{channel}_{group-name}" 形式にする必要があります（例: "whatsapp_family-chat", "telegram_dev-team", "discord_general"）。グループ名の部分にはハイフン付きの小文字を使用してください。`,
  {
    jid: z.string().describe('チャットの JID（例: "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456"）'),
    name: z.string().describe('グループの表示名'),
    folder: z.string().describe('チャネルプレフィックス付きのフォルダ名（例: "whatsapp_family-chat", "telegram_dev-team"）'),
    trigger: z.string().describe('トリガーワード（例: "@Andy"）'),
  },
  async (args) => {
    if (!isPrivileged) {
      return {
        content: [{ type: 'text' as const, text: '新しいグループの登録はメイングループのみが可能です。' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `グループ "${args.name}" を登録しました。即座にメッセージの受信が開始されます。` }],
    };
  },
);

// stdio トランスポートを開始
const transport = new StdioServerTransport();
await server.connect(transport);
