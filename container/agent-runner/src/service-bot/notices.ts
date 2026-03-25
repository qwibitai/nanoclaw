// Notice Board tools — read, acknowledge, and post notices via the telemetry API.

const TELEMETRY_TIMEOUT_MS = 5000;

function getTelemetryConfig() {
  const telemetryUrl = process.env.TELEMETRY_URL;
  const token = process.env.TELEMETRY_REGISTRATION_TOKEN;

  if (!telemetryUrl || !token) {
    throw new Error(
      'Missing env vars: TELEMETRY_URL and TELEMETRY_REGISTRATION_TOKEN are required for notice tools.',
    );
  }

  return { telemetryUrl: telemetryUrl.replace(/\/$/, ''), token };
}

export interface Notice {
  id: string;
  title: string;
  body: string | null;
  author_name: string;
  audience: string[];
  priority: string;
  created_at: string;
}

/**
 * Fetch unread notices for the calling bot from the telemetry API.
 * Bot identity is resolved server-side from the bearer token.
 * Does NOT auto-mark notices as read.
 */
export async function readNotices(
  options?: { limit?: number },
): Promise<string> {
  const { telemetryUrl, token } = getTelemetryConfig();
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);

  const url = `${telemetryUrl}/api/notices?unread_by=self&audience=self&limit=${limit}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
  });

  if (!response.ok) {
    return `Error fetching notices: HTTP ${response.status} ${response.statusText}`;
  }

  const notices: Notice[] = await response.json();

  if (notices.length === 0) {
    return 'No unread notices.';
  }

  const lines = notices.map((n) => {
    const priorityTag = n.priority !== 'normal' ? ` [${n.priority}]` : '';
    const body = n.body ? `\n  ${n.body}` : '';
    return `- **${n.title}**${priorityTag} (from ${n.author_name}, ${n.created_at})\n  ID: ${n.id}${body}`;
  });

  let result = `Unread notices (${notices.length}):\n\n${lines.join('\n\n')}`;

  // If we got exactly `limit` results, hint there may be more
  if (notices.length >= limit) {
    result += `\n\n_There may be more unread notices. Increase limit to see more._`;
  }

  return result;
}

/**
 * Acknowledge (mark as read) a single notice.
 * Bot identity is derived from the bearer token server-side.
 */
export async function acknowledgeNotice(
  noticeId: string,
): Promise<string> {
  if (!noticeId || !noticeId.trim()) {
    return 'Error: notice_id is required.';
  }

  const { telemetryUrl, token } = getTelemetryConfig();

  const response = await fetch(`${telemetryUrl}/api/notices/${encodeURIComponent(noticeId)}/read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
  });

  if (!response.ok) {
    return `Error acknowledging notice: HTTP ${response.status} ${response.statusText}`;
  }

  const data = await response.json();
  return `Notice ${data.notice_id} acknowledged at ${data.read_at}.`;
}

/**
 * Post a new notice to the notice board.
 * Author identity is derived from the bearer token server-side.
 */
export async function postNotice(
  title: string,
  options?: { body?: string; audience?: string[]; priority?: string },
): Promise<string> {
  if (!title || !title.trim()) {
    return 'Error: title is required.';
  }

  const { telemetryUrl, token } = getTelemetryConfig();

  const payload: Record<string, unknown> = {
    title: title.trim(),
    audience: options?.audience ?? ['@all'],
    priority: options?.priority ?? 'normal',
  };

  if (options?.body) {
    payload.body = options.body;
  }

  const response = await fetch(`${telemetryUrl}/api/notices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    return `Error posting notice: HTTP ${response.status} ${errorText}`;
  }

  const data = await response.json();
  return `Notice created: "${data.title}" (ID: ${data.id})`;
}
