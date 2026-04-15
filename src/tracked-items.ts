import { getDb } from './db.js';

export type ItemState =
  | 'detected'
  | 'pushed'
  | 'pending'
  | 'queued'
  | 'digested'
  | 'held'
  | 'resolved'
  | 'stale';

export type ItemClassification = 'push' | 'digest' | 'resolved';

export type ResolutionMethod =
  | 'auto:gmail_reply'
  | 'auto:archived'
  | 'auto:label_changed'
  | 'auto:rsvp'
  | 'auto:discord_resolved'
  | 'manual:button'
  | 'manual:reply'
  | 'delegated'
  | 'stale';

export interface ClassificationReason {
  superpilot?: string;
  trust?: string;
  learning?: string;
  calendar?: string;
  quietHours?: string;
  final: ItemClassification;
}

export interface TrackedItem {
  id: string;
  source: string;
  source_id: string;
  group_name: string;
  state: ItemState;
  classification: ItemClassification | null;
  superpilot_label: string | null;
  trust_tier: string | null;
  title: string;
  summary: string | null;
  thread_id: string | null;
  detected_at: number;
  pushed_at: number | null;
  resolved_at: number | null;
  resolution_method: ResolutionMethod | null;
  digest_count: number;
  telegram_message_id: number | null;
  classification_reason: ClassificationReason | null;
  metadata: Record<string, unknown> | null;
}

export interface Thread {
  id: string;
  group_name: string;
  title: string;
  source_hint: string | null;
  created_at: number;
  resolved_at: number | null;
  item_count: number;
  state: 'active' | 'resolved' | 'stale';
}

export interface DigestState {
  group_name: string;
  last_digest_at: number | null;
  last_dashboard_at: number | null;
  queued_count: number;
  last_user_interaction: number | null;
}

const VALID_TRANSITIONS: Record<ItemState, ItemState[]> = {
  detected: ['pushed', 'queued', 'resolved'],
  pushed: ['pending'],
  pending: ['resolved', 'held', 'stale'],
  queued: ['digested', 'resolved'],
  digested: ['resolved', 'stale'],
  held: ['pending', 'queued', 'resolved'],
  resolved: [],
  stale: [],
};

export function validateTransition(from: ItemState, to: ItemState): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}

// ---------------------------------------------------------------------------
// TrackedItem CRUD
// ---------------------------------------------------------------------------

export function insertTrackedItem(item: TrackedItem): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO tracked_items (
      id, source, source_id, group_name, state, classification,
      superpilot_label, trust_tier, title, summary, thread_id,
      detected_at, pushed_at, resolved_at, resolution_method,
      digest_count, telegram_message_id, classification_reason, metadata
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )`,
  ).run(
    item.id,
    item.source,
    item.source_id,
    item.group_name,
    item.state,
    item.classification ?? null,
    item.superpilot_label ?? null,
    item.trust_tier ?? null,
    item.title,
    item.summary ?? null,
    item.thread_id ?? null,
    item.detected_at,
    item.pushed_at ?? null,
    item.resolved_at ?? null,
    item.resolution_method ?? null,
    item.digest_count,
    item.telegram_message_id ?? null,
    item.classification_reason != null
      ? JSON.stringify(item.classification_reason)
      : null,
    item.metadata != null ? JSON.stringify(item.metadata) : null,
  );
}

export function transitionItemState(
  id: string,
  from: ItemState,
  to: ItemState,
  updates?: Partial<
    Pick<
      TrackedItem,
      | 'pushed_at'
      | 'resolved_at'
      | 'resolution_method'
      | 'telegram_message_id'
      | 'classification'
      | 'classification_reason'
      | 'metadata'
    >
  >,
): void {
  validateTransition(from, to);

  const db = getDb();

  // Build dynamic SET clause for optional updates
  const setClauses: string[] = ['state = ?'];
  const values: unknown[] = [to];

  if (updates) {
    if ('pushed_at' in updates) {
      setClauses.push('pushed_at = ?');
      values.push(updates.pushed_at ?? null);
    }
    if ('resolved_at' in updates) {
      setClauses.push('resolved_at = ?');
      values.push(updates.resolved_at ?? null);
    }
    if ('resolution_method' in updates) {
      setClauses.push('resolution_method = ?');
      values.push(updates.resolution_method ?? null);
    }
    if ('telegram_message_id' in updates) {
      setClauses.push('telegram_message_id = ?');
      values.push(updates.telegram_message_id ?? null);
    }
    if ('classification' in updates) {
      setClauses.push('classification = ?');
      values.push(updates.classification ?? null);
    }
    if ('classification_reason' in updates) {
      setClauses.push('classification_reason = ?');
      values.push(
        updates.classification_reason != null
          ? JSON.stringify(updates.classification_reason)
          : null,
      );
    }
    if ('metadata' in updates) {
      setClauses.push('metadata = ?');
      values.push(
        updates.metadata != null ? JSON.stringify(updates.metadata) : null,
      );
    }
  }

  values.push(id, from);

  const result = db
    .prepare(
      `UPDATE tracked_items SET ${setClauses.join(', ')} WHERE id = ? AND state = ?`,
    )
    .run(...values);

  if (result.changes === 0) {
    throw new Error(
      `State transition failed: item ${id} not found in state '${from}'`,
    );
  }
}

export function deserializeItem(row: Record<string, unknown>): TrackedItem {
  return {
    ...(row as unknown as TrackedItem),
    classification_reason:
      typeof row['classification_reason'] === 'string' &&
      row['classification_reason']
        ? (JSON.parse(
            row['classification_reason'] as string,
          ) as ClassificationReason)
        : null,
    metadata:
      typeof row['metadata'] === 'string' && row['metadata']
        ? (JSON.parse(row['metadata'] as string) as Record<string, unknown>)
        : null,
  };
}

export function getTrackedItemsByState(
  groupName: string,
  states: ItemState[],
): TrackedItem[] {
  if (states.length === 0) return [];
  const db = getDb();
  const placeholders = states.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM tracked_items WHERE group_name = ? AND state IN (${placeholders}) ORDER BY detected_at ASC`,
    )
    .all(groupName, ...states) as Record<string, unknown>[];
  return rows.map(deserializeItem);
}

export function getTrackedItemBySourceId(
  source: string,
  sourceId: string,
): TrackedItem | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM tracked_items WHERE source = ? AND source_id = ? LIMIT 1`,
    )
    .get(source, sourceId) as Record<string, unknown> | undefined;
  return row ? deserializeItem(row) : null;
}

export function incrementDigestCount(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE tracked_items SET digest_count = digest_count + 1 WHERE id IN (${placeholders})`,
  ).run(...ids);
}

// ---------------------------------------------------------------------------
// Thread CRUD
// ---------------------------------------------------------------------------

export function upsertThread(thread: Thread): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO threads (id, group_name, title, source_hint, created_at, resolved_at, item_count, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       source_hint = excluded.source_hint,
       resolved_at = excluded.resolved_at,
       item_count = excluded.item_count,
       state = excluded.state`,
  ).run(
    thread.id,
    thread.group_name,
    thread.title,
    thread.source_hint ?? null,
    thread.created_at,
    thread.resolved_at ?? null,
    thread.item_count,
    thread.state,
  );
}

export function getActiveThreads(groupName: string): Thread[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM threads WHERE group_name = ? AND state = 'active' ORDER BY created_at ASC`,
    )
    .all(groupName) as Thread[];
}

// ---------------------------------------------------------------------------
// DigestState CRUD
// ---------------------------------------------------------------------------

export function getDigestState(groupName: string): DigestState {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM digest_state WHERE group_name = ? LIMIT 1`)
    .get(groupName) as DigestState | undefined;
  if (!row) {
    return {
      group_name: groupName,
      last_digest_at: null,
      last_dashboard_at: null,
      queued_count: 0,
      last_user_interaction: null,
    };
  }
  return row;
}

export function updateDigestState(
  groupName: string,
  updates: Partial<Omit<DigestState, 'group_name'>>,
): void {
  const db = getDb();

  const setClauses: string[] = [];
  const values: unknown[] = [];

  if ('last_digest_at' in updates) {
    setClauses.push('last_digest_at = COALESCE(?, last_digest_at)');
    values.push(updates.last_digest_at ?? null);
  }
  if ('last_dashboard_at' in updates) {
    setClauses.push('last_dashboard_at = COALESCE(?, last_dashboard_at)');
    values.push(updates.last_dashboard_at ?? null);
  }
  if ('queued_count' in updates) {
    setClauses.push('queued_count = ?');
    values.push(updates.queued_count ?? 0);
  }
  if ('last_user_interaction' in updates) {
    setClauses.push(
      'last_user_interaction = COALESCE(?, last_user_interaction)',
    );
    values.push(updates.last_user_interaction ?? null);
  }

  if (setClauses.length === 0) return;

  db.prepare(
    `INSERT INTO digest_state (group_name, last_digest_at, last_dashboard_at, queued_count, last_user_interaction)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_name) DO UPDATE SET ${setClauses.join(', ')}`,
  ).run(
    groupName,
    updates.last_digest_at ?? null,
    updates.last_dashboard_at ?? null,
    updates.queued_count ?? 0,
    updates.last_user_interaction ?? null,
    ...values,
  );
}

// ---------------------------------------------------------------------------
// Resolution detection
// ---------------------------------------------------------------------------

export interface ResolutionSignal {
  source: string;
  userReplied?: boolean;
  inInbox?: boolean;
  rsvpChanged?: boolean;
  threadResolved?: boolean;
  labelChanged?: boolean;
}

export interface ResolutionResult {
  resolved: boolean;
  method?: ResolutionMethod;
  confidence?: 'high' | 'medium' | 'low';
}

export function detectResolution(signal: ResolutionSignal): ResolutionResult {
  if (signal.source === 'gmail') {
    if (signal.userReplied) {
      return { resolved: true, method: 'auto:gmail_reply', confidence: 'high' };
    }
    if (signal.inInbox === false) {
      return { resolved: true, method: 'auto:archived', confidence: 'high' };
    }
    if (signal.labelChanged) {
      return {
        resolved: true,
        method: 'auto:label_changed',
        confidence: 'high',
      };
    }
  }

  if (signal.source === 'calendar' && signal.rsvpChanged) {
    return { resolved: true, method: 'auto:rsvp', confidence: 'high' };
  }

  if (signal.source === 'discord' && signal.threadResolved) {
    return {
      resolved: true,
      method: 'auto:discord_resolved',
      confidence: 'medium',
    };
  }

  return { resolved: false };
}

// ---------------------------------------------------------------------------
// Callback query handling
// ---------------------------------------------------------------------------

export type CallbackAction = 'approve' | 'dismiss' | 'snooze' | 'handle';

export function parseCallbackData(
  data: string,
): { action: CallbackAction; itemId: string } | null {
  const match = data.match(/^(approve|dismiss|snooze|handle):(.+)$/);
  if (!match) return null;
  return { action: match[1] as CallbackAction, itemId: match[2] };
}

export function resolveItemByCallback(
  itemId: string,
  action: CallbackAction,
): void {
  const item = getTrackedItemById(itemId);
  if (!item) return;

  const now = Date.now();
  if (action === 'approve' || action === 'dismiss') {
    if (
      item.state === 'pending' ||
      item.state === 'pushed' ||
      item.state === 'held'
    ) {
      const fromState = item.state;
      transitionItemState(itemId, fromState, 'resolved', {
        resolved_at: now,
        resolution_method: 'manual:button',
      });
    }
  }
}

export function getTrackedItemById(itemId: string): TrackedItem | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM tracked_items WHERE id = ?')
    .get(itemId) as Record<string, unknown> | undefined;
  return row ? deserializeItem(row) : null;
}

export function getItemsByThreadId(threadId: string): TrackedItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM tracked_items WHERE thread_id = ? ORDER BY detected_at ASC',
    )
    .all(threadId) as Record<string, unknown>[];
  return rows.map(deserializeItem);
}

export function mergeThreads(
  sourceThreadId: string,
  targetThreadId: string,
): void {
  const db = getDb();
  db.prepare(
    'UPDATE tracked_items SET thread_id = ? WHERE thread_id = ?',
  ).run(targetThreadId, sourceThreadId);
}
