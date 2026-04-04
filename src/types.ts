export interface AdditionalMount {
  hostPath: string; // ホスト上の絶対パス（ホームディレクトリの ~ をサポート）
  containerPath?: string; // オプション — デフォルトは hostPath のベース名。/workspace/extra/{value} にマウントされる
  readonly?: boolean; // デフォルト: 安全のため true
}

/**
 * マウント許可リスト - 追加マウントのセキュリティ設定
 * このファイルは ~/.config/nanoclaw/mount-allowlist.json に保存されるべきであり、
 * エージェントによる改ざんを防ぐため、いかなるコンテナにもマウントされない。
 */
export interface MountAllowlist {
  // コンテナにマウント可能なディレクトリ
  allowedRoots: AllowedRoot[];
  // 決してマウントしてはならないパスのグロブパターン（例: ".ssh", ".gnupg"）
  blockedPatterns: string[];
  // true の場合、メイン以外のグループは設定に関わらず読み取り専用でのみマウント可能
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // 絶対パスまたはホームディレクトリを表す ~（例: "~/projects", "/var/repos"）
  path: string;
  // このルート配下で読み書き可能なマウントを許可するかどうか
  allowReadWrite: boolean;
  // ドキュメント用のオプションの説明
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // デフォルト: 300000 (5分)
}

// --- Discord 拡張型（VRC-AI-Bot 由来） ---

/** メッセージの送信場所の種別 */
export type PlaceType =
  | 'guild_text'
  | 'guild_announcement'
  | 'chat_channel'
  | 'admin_control_channel'
  | 'public_thread'
  | 'private_thread'
  | 'forum_post_thread';

/** ユーザーの権限ロール */
export type ActorRole = 'owner' | 'admin' | 'user';

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // デフォルト: グループの場合は true、個人チャットの場合は false
  isMain?: boolean; // メインコントロールグループの場合は true（トリガー不要、特権あり）
  channel_mode?: 'chat' | 'url_watch' | 'admin_control';
  chat_behavior?: 'ambient_room_chat' | 'directed_help_chat';
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

/**
 * チャンネルコールバック専用のメッセージ型。
 * NewMessage を拡張し、永続化されない Discord 固有のメタデータを付与する。
 * storeMessage には渡さず、onMessage コールバック内でのみ参照すること。
 */
export interface InboundMessage extends NewMessage {
  place_type?: PlaceType;
  actor_role?: ActorRole;
  is_thread?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- チャネルの抽象化 ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // オプション: 入力中インジケーター。サポートするチャネルで実装される。
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // オプション: プラットフォームからグループ/チャット名を同期する。
  syncGroups?(force: boolean): Promise<void>;
}

// チャネルが受信メッセージを配信するために使用するコールバック型。
// InboundMessage は NewMessage のスーパーセットなので、既存ハンドラはそのまま使用できる。
export type OnInboundMessage = (chatJid: string, message: InboundMessage) => void;

// チャットのメタデータ検出用コールバック。
// name はオプション — 名前をインラインで配信するチャネル（Telegram）はここに渡す。
// 名前を個別に同期するチャネル（syncGroups経由）は省略する。
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
