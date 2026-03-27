/**
 * Fire-and-forget: logs rate limit events to the booking API for operator review.
 * Never throws — failure to log must not affect the message loop.
 */

import { logger } from './logger.js';

const API_URL = process.env.BOOKING_API_HOST_URL ?? 'http://localhost:4002';
const API_KEY = process.env.BOOKING_API_KEY ?? '';

async function resolveTenantId(
  groupFolder: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${API_URL}/admin/tenants/by-folder/${encodeURIComponent(groupFolder)}`,
      {
        headers: { 'x-api-key': API_KEY },
        signal: AbortSignal.timeout(3000),
      },
    );

    if (!res.ok) return undefined;

    const data = (await res.json()) as { id?: string };
    return data.id;
  } catch (err) {
    logger.warn(
      { err, groupFolder },
      'Failed to resolve tenant for rate limit event',
    );
    return undefined;
  }
}

export function logRateLimitEvent(data: {
  phone: string;
  groupFolder: string;
  msgCount: number;
  tenantId?: string;
}): void {
  void (async () => {
    const tenantId = data.tenantId ?? (await resolveTenantId(data.groupFolder));

    await fetch(`${API_URL}/admin/rate-limit-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ ...data, tenantId }),
    });
  })().catch((err) => {
    logger.warn({ err, phone: data.phone }, 'Failed to log rate limit event');
  });
}
