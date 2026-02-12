export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
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

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Whether to prefix outbound messages with the assistant name.
  // Telegram bots already display their name, so they return false.
  // WhatsApp returns true. Default true if not implemented.
  prefixAssistantName?: boolean;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// --- Complaint domain types ---

export type UserRole = 'user' | 'karyakarta' | 'admin' | 'superadmin';

export type ComplaintStatus =
  | 'registered'
  | 'pending_validation'
  | 'validated'
  | 'rejected'
  | 'escalated_timeout'
  | 'acknowledged'
  | 'in_progress'
  | 'action_taken'
  | 'resolved'
  | 'on_hold'
  | 'escalated';

/** Canonical list of all valid complaint statuses, derived from ComplaintStatus. */
export const VALID_COMPLAINT_STATUSES: ComplaintStatus[] = [
  'registered',
  'pending_validation',
  'validated',
  'rejected',
  'escalated_timeout',
  'acknowledged',
  'in_progress',
  'action_taken',
  'resolved',
  'on_hold',
  'escalated',
];

export type ComplaintPriority = 'low' | 'normal' | 'high' | 'urgent';

export type RejectionReason =
  | 'duplicate'
  | 'fraud'
  | 'not_genuine'
  | 'out_of_area'
  | 'insufficient_info'
  | 'other';

export interface Complaint {
  id: string;
  phone: string;
  category: string | null;
  subcategory: string | null;
  description: string;
  location: string | null;
  language: string;
  status: ComplaintStatus;
  status_reason: string | null;
  priority: ComplaintPriority;
  source: 'text' | 'voice';
  voice_message_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  days_open: number;
  area_id: string | null;
}

export interface ComplaintUpdate {
  id: number;
  complaint_id: string;
  old_status: string | null;
  new_status: string | null;
  note: string | null;
  updated_by: string;
  created_at: string;
}

export interface User {
  phone: string;
  name: string | null;
  language: string;
  role: UserRole;
  first_seen: string;
  last_seen: string;
  total_complaints: number;
  is_blocked: number;
  blocked_until: string | null;
}

export interface Area {
  id: string;
  name: string;
  name_mr: string | null;
  name_hi: string | null;
  type: 'village' | 'town' | 'ward' | 'custom';
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface Karyakarta {
  phone: string;
  is_active: number;
  onboarded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface KaryakartaArea {
  karyakarta_phone: string;
  area_id: string;
  assigned_at: string;
  assigned_by: string | null;
}

export interface ComplaintValidation {
  id: number;
  complaint_id: string;
  validated_by: string | null;
  action: 'approved' | 'rejected' | 'escalated_timeout' | 'admin_override';
  reason_code: RejectionReason | null;
  comment: string | null;
  ai_suggested_reason: string | null;
  created_at: string;
}

export interface Conversation {
  id: number;
  phone: string;
  role: 'user' | 'assistant';
  content: string;
  complaint_id: string | null;
  created_at: string;
}

export interface Category {
  name: string;
  display_name_en: string | null;
  display_name_mr: string | null;
  display_name_hi: string | null;
  complaint_count: number;
  first_seen: string;
  is_active: number;
}

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
) => void;
