/**
 * Signal-cli JSON-RPC client
 * Communicates with signal-cli REST API container over HTTP
 */
export interface SignalWsEvent {
  event?: string;
  data?: string;
  id?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('Signal base URL is required');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  return `http://${trimmed}`.replace(/\/+$/, '');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Mention in a message */
export interface SignalMention {
  start: number;
  length: number;
  author: string;
}

/** Link preview for rich URLs */
export interface SignalLinkPreview {
  url: string;
  title?: string;
  description?: string;
  base64_thumbnail?: string;
}

/** Options for sending a message */
export interface SignalSendOpts {
  baseUrl: string;
  account: string;
  recipients?: string[];
  groupId?: string;
  message: string;
  textMode?: 'normal' | 'styled';
  attachments?: string[];
  quoteTimestamp?: number;
  quoteAuthor?: string;
  quoteMessage?: string;
  mentions?: SignalMention[];
  editTimestamp?: number;
  linkPreview?: SignalLinkPreview;
  viewOnce?: boolean;
  timeoutMs?: number;
}

/**
 * Send a message using the REST v2 API with styled text support.
 * Styling: *italic*, **bold**, ~strikethrough~, `monospace`, ||spoiler||
 */
export async function signalSendV2(opts: SignalSendOpts): Promise<{ timestamp?: number }> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body: Record<string, unknown> = {
    number: opts.account,
    message: opts.message,
    text_mode: opts.textMode || 'styled',
  };

  if (opts.groupId) {
    body.recipients = [opts.groupId];
  } else if (opts.recipients) {
    body.recipients = opts.recipients;
  }

  if (opts.attachments && opts.attachments.length > 0) {
    body.base64_attachments = opts.attachments;
  }

  if (opts.quoteTimestamp) {
    body.quote_timestamp = opts.quoteTimestamp;
    if (opts.quoteAuthor) body.quote_author = opts.quoteAuthor;
    if (opts.quoteMessage) body.quote_message = opts.quoteMessage;
  }

  if (opts.mentions && opts.mentions.length > 0) {
    body.mentions = opts.mentions;
  }

  if (opts.editTimestamp) {
    body.edit_timestamp = opts.editTimestamp;
  }

  if (opts.linkPreview) {
    body.link_preview = opts.linkPreview;
  }

  if (opts.viewOnce) {
    body.view_once = true;
  }

  const res = await fetchWithTimeout(
    `${baseUrl}/v2/send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal v2 send failed (${res.status}): ${text}`);
  }

  const result = await res.json() as { timestamp?: string };
  return { timestamp: result.timestamp ? Number(result.timestamp) : undefined };
}

/**
 * React to a message with an emoji.
 */
export async function signalReact(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  targetAuthor: string;
  targetTimestamp: number;
  reaction: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    target_author: opts.targetAuthor,
    timestamp: opts.targetTimestamp,
    reaction: opts.reaction,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/reactions/${encodeURIComponent(opts.account)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal react failed (${res.status}): ${text}`);
  }
}

/**
 * Remove a reaction from a message.
 */
export async function signalRemoveReaction(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  targetAuthor: string;
  targetTimestamp: number;
  reaction: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    target_author: opts.targetAuthor,
    timestamp: opts.targetTimestamp,
    reaction: opts.reaction,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/reactions/${encodeURIComponent(opts.account)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal remove reaction failed (${res.status}): ${text}`);
  }
}

/**
 * Delete a message for everyone (remote delete).
 */
export async function signalDeleteMessage(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  timestamp: number;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    timestamp: opts.timestamp,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/remote-delete/${encodeURIComponent(opts.account)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal delete message failed (${res.status}): ${text}`);
  }
}

/**
 * Send a read receipt for a message.
 */
export async function signalSendReceipt(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  timestamp: number;
  receiptType?: 'read' | 'viewed';
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    timestamp: opts.timestamp,
    receipt_type: opts.receiptType || 'read',
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/receipts/${encodeURIComponent(opts.account)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal send receipt failed (${res.status}): ${text}`);
  }
}

/** Group information */
export interface SignalGroup {
  id: string;
  internalId: string;
  name: string;
  description?: string;
  isMember: boolean;
  isBlocked: boolean;
  members: string[];
  admins: string[];
}

/**
 * List all groups the account is a member of.
 */
export async function signalListGroups(opts: {
  baseUrl: string;
  account: string;
  timeoutMs?: number;
}): Promise<SignalGroup[]> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}`,
    { method: 'GET' },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal list groups failed (${res.status}): ${text}`);
  }

  const groups = await res.json() as Array<{
    id?: string;
    internal_id?: string;
    name?: string;
    description?: string;
    blocked?: boolean;
    members?: string[];
    admins?: string[];
  }>;

  return groups.map((g) => ({
    id: g.id || g.internal_id || '',
    internalId: g.internal_id || '',
    name: g.name || '',
    description: g.description,
    isMember: true,
    isBlocked: g.blocked ?? false,
    members: g.members || [],
    admins: g.admins || [],
  }));
}

/**
 * Get detailed information about a specific group.
 */
export async function signalGetGroupInfo(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  timeoutMs?: number;
}): Promise<SignalGroup> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}`,
    { method: 'GET' },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal get group info failed (${res.status}): ${text}`);
  }

  const g = await res.json() as {
    id?: string;
    internal_id?: string;
    name?: string;
    description?: string;
    blocked?: boolean;
    members?: string[];
    admins?: string[];
  };

  return {
    id: g.id || g.internal_id || '',
    internalId: g.internal_id || '',
    name: g.name || '',
    description: g.description,
    isMember: true,
    isBlocked: g.blocked ?? false,
    members: g.members || [],
    admins: g.admins || [],
  };
}

/**
 * Create a poll in a group or DM.
 */
export async function signalCreatePoll(
  opts: {
    baseUrl: string;
    account: string;
    recipient: string;
    question: string;
    answers: string[];
    allowMultipleSelections?: boolean;
    timeoutMs?: number;
  },
): Promise<{ pollTimestamp?: string }> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    question: opts.question,
    answers: opts.answers,
    allow_multiple_selections: opts.allowMultipleSelections ?? true,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/polls/${encodeURIComponent(opts.account)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal create poll failed (${res.status}): ${text}`);
  }

  const result = await res.json() as { timestamp?: string };
  return { pollTimestamp: result.timestamp };
}

/**
 * Close an existing poll.
 */
export async function signalClosePoll(
  opts: {
    baseUrl: string;
    account: string;
    recipient: string;
    pollTimestamp: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    poll_timestamp: opts.pollTimestamp,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/polls/${encodeURIComponent(opts.account)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal close poll failed (${res.status}): ${text}`);
  }
}

export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const res = await fetchWithTimeout(
      `${normalized}/v1/health`,
      { method: 'GET' },
      timeoutMs,
    );
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Stream events from signal-cli via WebSocket.
 * Used with bbernhard/signal-cli-rest-api in json-rpc mode.
 * Calls onEvent for each received message.
 */
export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalWsEvent) => void;
}): Promise<void> {
  const { default: WebSocket } = await import('ws');
  const baseUrl = normalizeBaseUrl(params.baseUrl);

  // Convert http:// to ws:// for WebSocket connection
  const wsUrl = baseUrl.replace(/^http/, 'ws');
  const account = params.account ? encodeURIComponent(params.account) : '';
  const url = `${wsUrl}/v1/receive/${account}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const cleanup = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    if (params.abortSignal) {
      params.abortSignal.addEventListener('abort', cleanup);
    }

    ws.on('open', () => {
      // Connection established, messages will arrive via 'message' event
    });

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        params.onEvent({
          event: 'receive',
          data: JSON.stringify(message),
        });
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('error', (err: Error) => {
      cleanup();
      reject(new Error(`Signal WebSocket error: ${err.message}`));
    });

    ws.on('close', () => {
      if (params.abortSignal) {
        params.abortSignal.removeEventListener('abort', cleanup);
      }
      resolve();
    });
  });
}

/**
 * Download an attachment by ID. Returns the raw file content as a Buffer.
 */
export async function signalDownloadAttachment(
  baseUrl: string,
  attachmentId: string,
  timeoutMs = 30_000,
): Promise<Buffer> {
  const normalized = normalizeBaseUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${normalized}/v1/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'GET' },
    timeoutMs,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal download attachment failed (${res.status}): ${text}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/** Contact information from signal-cli */
export interface SignalContact {
  number: string;
  name?: string;
  profileName?: string;
}

/**
 * List all known contacts for the account.
 */
export async function signalGetContacts(opts: {
  baseUrl: string;
  account: string;
  timeoutMs?: number;
}): Promise<SignalContact[]> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/contacts/${encodeURIComponent(opts.account)}`,
    { method: 'GET' },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal get contacts failed (${res.status}): ${text}`);
  }

  const contacts = await res.json() as Array<{
    number?: string;
    name?: string;
    profile_name?: string;
  }>;

  return contacts.map((c) => ({
    number: c.number || '',
    name: c.name,
    profileName: c.profile_name,
  }));
}

// -- Enhanced features (Full features mode) --

/**
 * Set typing indicator on/off via REST API.
 */
export async function signalSetTyping(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  isTyping: boolean;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = { recipient: opts.recipient };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/typing-indicator/${encodeURIComponent(opts.account)}`,
    {
      method: opts.isTyping ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal typing indicator failed (${res.status}): ${text}`);
  }
}

/**
 * Vote on an existing poll.
 */
export async function signalVotePoll(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  pollTimestamp: string;
  pollAuthor: string;
  selectedAnswers: number[];
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    poll_timestamp: opts.pollTimestamp,
    poll_author: opts.pollAuthor,
    selected_answers: opts.selectedAnswers,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/polls/${encodeURIComponent(opts.account)}/vote`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal vote poll failed (${res.status}): ${text}`);
  }
}

/** Sticker pack info */
export interface SignalStickerPack {
  packId: string;
  url?: string;
  installed?: boolean;
  title?: string;
  author?: string;
}

/**
 * List installed sticker packs.
 */
export async function signalListStickerPacks(opts: {
  baseUrl: string;
  account: string;
  timeoutMs?: number;
}): Promise<SignalStickerPack[]> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/sticker-packs/${encodeURIComponent(opts.account)}`,
    { method: 'GET' },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal list sticker packs failed (${res.status}): ${text}`);
  }

  const packs = await res.json() as Array<{
    pack_id?: string;
    url?: string;
    installed?: boolean;
    title?: string;
    author?: string;
  }>;

  return packs.map((p) => ({
    packId: p.pack_id || '',
    url: p.url,
    installed: p.installed,
    title: p.title,
    author: p.author,
  }));
}

/**
 * Send a sticker.
 */
export async function signalSendSticker(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  packId: string;
  stickerId: number;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipients: [opts.recipient],
    sticker: `${opts.packId}:${opts.stickerId}`,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v2/send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: opts.account, ...body }),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal send sticker failed (${res.status}): ${text}`);
  }
}

/**
 * Create a new Signal group.
 */
export async function signalCreateGroup(opts: {
  baseUrl: string;
  account: string;
  name: string;
  members: string[];
  description?: string;
  timeoutMs?: number;
}): Promise<{ groupId: string }> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body: Record<string, unknown> = {
    name: opts.name,
    members: opts.members,
  };
  if (opts.description) body.description = opts.description;

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal create group failed (${res.status}): ${text}`);
  }

  const result = await res.json() as { id?: string };
  return { groupId: result.id || '' };
}

/**
 * Update a Signal group's name, description, or avatar.
 */
export async function signalUpdateGroup(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  name?: string;
  description?: string;
  avatarBase64?: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body: Record<string, unknown> = {};
  if (opts.name) body.name = opts.name;
  if (opts.description) body.description = opts.description;
  if (opts.avatarBase64) body.base64_avatar = opts.avatarBase64;

  if (Object.keys(body).length === 0) return;

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal update group failed (${res.status}): ${text}`);
  }
}

/**
 * Add members to a Signal group.
 */
export async function signalAddGroupMembers(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  members: string[];
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = { members: opts.members };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}/members`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal add group members failed (${res.status}): ${text}`);
  }
}

/**
 * Remove members from a Signal group.
 */
export async function signalRemoveGroupMembers(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  members: string[];
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = { members: opts.members };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}/members`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal remove group members failed (${res.status}): ${text}`);
  }
}

/**
 * Leave a Signal group.
 */
export async function signalQuitGroup(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}/quit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal quit group failed (${res.status}): ${text}`);
  }
}

/**
 * Update the bot's Signal profile (name, about text, avatar).
 */
export async function signalUpdateProfile(opts: {
  baseUrl: string;
  account: string;
  name?: string;
  about?: string;
  avatarBase64?: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body: Record<string, unknown> = {};

  if (opts.name) body.name = opts.name;
  if (opts.about) body.about = opts.about;
  if (opts.avatarBase64) body.base64_avatar = opts.avatarBase64;

  if (Object.keys(body).length === 0) {
    return;
  }

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/profiles/${encodeURIComponent(opts.account)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal update profile failed (${res.status}): ${text}`);
  }
}
