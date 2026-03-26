import { AGENCY_HQ_URL } from './config.js';

// --- Types ---

export interface AgencyHqTask {
  id: string;
  title: string;
  description: string;
  acceptance_criteria?: string;
  repository?: string;
  sprint_id?: string;
  assigned_to?: string;
  scheduled_dispatch_at?: string;
  /** ISO-8601 timestamp: task will not be dispatched before this time (set after 3 failures). */
  dispatch_blocked_until?: string;
  status: string;
  dispatch_attempts?: number;
  dispatched_at?: string;
  updated_at?: string;
}

export interface AgencyHqSprint {
  id: string;
  goal?: string;
}

// --- API Client ---

export async function agencyFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${AGENCY_HQ_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

export const PROMPT_REGISTRY_URL = 'https://prompt-api.jeffreykeyser.net';

export async function fetchPersona(catalogKey: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${PROMPT_REGISTRY_URL}/api/v1/prompts/${encodeURIComponent(catalogKey)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { value?: string } };
    return json.data?.value ?? null;
  } catch {
    return null;
  }
}
