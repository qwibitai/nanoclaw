/**
 * Notice Board client — read, acknowledge, and post notices via the telemetry API.
 * Ported from X's implementation for Relay's inter-bot communication.
 */

import { getTelemetryConfig } from './telemetry-config.js';

const TIMEOUT_MS = 5000;

export interface Notice {
  id: string;
  title: string;
  body: string | null;
  author_name: string;
  audience: string[];
  priority: string;
  created_at: string;
}

export async function readNotices(options?: { limit?: number }): Promise<string> {
  const { telemetryUrl, token } = getTelemetryConfig();
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);

  const url = `${telemetryUrl}/api/notices?unread_by=self&audience=self&limit=${limit}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
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

  if (notices.length >= limit) {
    result += `\n\n_There may be more unread notices. Increase limit to see more._`;
  }

  return result;
}

export async function acknowledgeNotice(noticeId: string): Promise<string> {
  if (!noticeId?.trim()) {
    return 'Error: notice_id is required.';
  }

  const { telemetryUrl, token } = getTelemetryConfig();

  const response = await fetch(
    `${telemetryUrl}/api/notices/${encodeURIComponent(noticeId)}/read`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    return `Error acknowledging notice: HTTP ${response.status} ${response.statusText}`;
  }

  const data = await response.json();
  return `Notice ${data.notice_id} acknowledged at ${data.read_at}.`;
}

export async function postNotice(
  title: string,
  options?: { body?: string; audience?: string[]; priority?: string },
): Promise<string> {
  if (!title?.trim()) {
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    return `Error posting notice: HTTP ${response.status} ${errorText}`;
  }

  const data = await response.json();
  return `Notice created: "${data.title}" (ID: ${data.id})`;
}
