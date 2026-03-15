/**
 * granola-fetcher.ts
 *
 * Fetches recent Granola meeting notes and transcripts, writes structured JSON.
 *
 * Auth: reads WorkOS credentials from the Granola desktop app's local storage
 *   ~/Library/Application Support/Granola/supabase.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { DATA_DIR } from './shared/config.js';
import { writeJsonAtomic, mergeDailyArchive } from './shared/writer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRANOLA_DIR = path.join(DATA_DIR, 'granola');
const LATEST_PATH = path.join(GRANOLA_DIR, 'latest.json');
const TRANSCRIPTS_DIR = path.join(GRANOLA_DIR, 'transcripts');
const DAYS_DIR = path.join(GRANOLA_DIR, 'days');

const SUPABASE_JSON_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Granola',
  'supabase.json',
);

const API_BASE = 'https://api.granola.ai';
const WORKOS_AUTH_URL = 'https://api.workos.com/user_management/authenticate';

const MAX_DOCUMENTS = 20;
const TRANSCRIPT_LOOKBACK_MS = 48 * 60 * 60 * 1_000;
const TRANSCRIPT_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkOSTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  obtained_at: number;
  id_token?: string;
  token_type?: string;
  session_id?: string;
  sign_in_method?: string;
}

interface MeetingSummary {
  id: string;
  title: string;
  created_at: string;
  url: string;
  transcript_summary: string;
  has_full_transcript: boolean;
}

interface TranscriptEntry {
  source?: string;
  speaker?: string;
  text?: string;
  content?: string;
  start_timestamp?: string;
  end_timestamp?: string;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  process.stderr.write('[granola-fetcher] ' + args.join(' ') + '\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function readTokens(): WorkOSTokens {
  if (!fs.existsSync(SUPABASE_JSON_PATH)) {
    process.stderr.write(
      '[granola-fetcher] ERROR: Granola credentials not found.\n' +
        `  Expected file: ${SUPABASE_JSON_PATH}\n` +
        '  Please install the Granola desktop app and sign in.\n',
    );
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(SUPABASE_JSON_PATH, 'utf-8'));
  const tokens: WorkOSTokens = JSON.parse(data.workos_tokens);

  if (!tokens.access_token || !tokens.refresh_token) {
    process.stderr.write(
      '[granola-fetcher] ERROR: Missing access_token or refresh_token.\n' +
        '  Please sign out and back in to the Granola app.\n',
    );
    process.exit(1);
  }

  return tokens;
}

function saveTokens(tokens: WorkOSTokens): void {
  const data = JSON.parse(fs.readFileSync(SUPABASE_JSON_PATH, 'utf-8'));
  data.workos_tokens = JSON.stringify(tokens);
  const tmp = SUPABASE_JSON_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, SUPABASE_JSON_PATH);
  log('Tokens updated.');
}

function isTokenExpired(tokens: WorkOSTokens): boolean {
  // obtained_at is in milliseconds
  const expiresAtMs = tokens.obtained_at + (tokens.expires_in * 1_000);
  return Date.now() > expiresAtMs;
}

function extractClientId(accessToken: string): string {
  const parts = accessToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  // issuer format: https://auth.granola.ai/user_management/<client_id>
  const iss = payload.iss as string;
  return iss.split('/').pop()!;
}

async function refreshTokens(tokens: WorkOSTokens): Promise<WorkOSTokens> {
  const clientId = extractClientId(tokens.access_token);

  const resp = await fetch(WORKOS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token refresh failed (HTTP ${resp.status}): ${body}`);
  }

  const result = await resp.json() as Record<string, unknown>;
  if (!result.access_token) {
    throw new Error(`Token refresh returned no access_token: ${JSON.stringify(result)}`);
  }

  const updated: WorkOSTokens = {
    ...tokens,
    access_token: result.access_token as string,
    refresh_token: result.refresh_token as string,
    expires_in: (result.expires_in as number) ?? 3600,
    obtained_at: Date.now(),
  };

  saveTokens(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiPost(
  accessToken: string,
  workspaceId: string,
  apiPath: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(`${API_BASE}${apiPath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Origin': 'https://notes.granola.ai',
      'x-client-version': '0.0.0.web',
      'x-granola-workspace-id': workspaceId,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${apiPath} failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }

  return resp.json();
}

async function getWorkspaceId(accessToken: string): Promise<string> {
  const resp = await apiPost(accessToken, '', '/v1/get-workspaces', {});
  const workspaces = (resp as Record<string, unknown>).workspaces as Array<Record<string, unknown>>;
  if (!workspaces?.length) throw new Error('No workspaces found');
  const ws = workspaces[0].workspace as Record<string, string>;
  return ws.workspace_id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('Starting…');

  // --- Auth ---
  let tokens = readTokens();
  if (isTokenExpired(tokens)) {
    log('Access token expired, refreshing…');
    tokens = await refreshTokens(tokens);
    log('Token refreshed.');
  } else {
    log('Access token is valid.');
  }

  const workspaceId = await getWorkspaceId(tokens.access_token);
  log(`Workspace: ${workspaceId}`);

  const post = (apiPath: string, body: Record<string, unknown>) =>
    apiPost(tokens.access_token, workspaceId, apiPath, body);

  // --- Fetch recent documents ---
  log(`Fetching up to ${MAX_DOCUMENTS} recent documents…`);
  const docsResp = await post('/v2/get-documents', {
    limit: MAX_DOCUMENTS,
    offset: 0,
    include_last_viewed_panel: false,
  }) as Record<string, unknown>;

  const rawDocs = (docsResp.docs ?? docsResp.documents ?? docsResp) as Array<Record<string, unknown>>;
  if (!Array.isArray(rawDocs)) {
    log(`Unexpected response shape: ${JSON.stringify(docsResp).slice(0, 200)}`);
    process.exit(1);
  }
  log(`Got ${rawDocs.length} document(s).`);

  const now = Date.now();
  const meetings: MeetingSummary[] = [];

  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  for (let i = 0; i < rawDocs.length; i++) {
    const doc = rawDocs[i];
    const id = doc.id as string;
    const title = (doc.title ?? 'Untitled') as string;
    const createdAt = (doc.created_at ?? '') as string;
    const url = `https://notes.granola.ai/d/${id}`;

    const age = now - new Date(createdAt).getTime();
    const withinLookback = age < TRANSCRIPT_LOOKBACK_MS;

    let transcriptText = '';
    let hasTranscript = false;

    if (withinLookback) {
      log(`  [${i + 1}/${rawDocs.length}] "${title}" — fetching transcript`);
      if (i > 0) await sleep(TRANSCRIPT_DELAY_MS);

      try {
        const tResp = await post('/v1/get-document-transcript', { document_id: id });
        const entries = (Array.isArray(tResp) ? tResp : (tResp as Record<string, unknown>).transcript ?? (tResp as Record<string, unknown>).entries ?? []) as TranscriptEntry[];

        if (Array.isArray(entries) && entries.length > 0) {
          transcriptText = entries.map((e) => {
            const source = e.source ?? e.speaker ?? 'Unknown';
            const text = e.text ?? e.content ?? '';
            const ts = e.start_timestamp ? ` [${e.start_timestamp}]` : '';
            return `**${source}**${ts}: ${text}`;
          }).join('\n');
          hasTranscript = true;
          log(`    Got transcript (${entries.length} entries, ${transcriptText.length} chars)`);

          // Write individual transcript file
          writeJsonAtomic(path.join(TRANSCRIPTS_DIR, `${id}.json`), {
            id,
            title,
            created_at: createdAt,
            url,
            transcript: transcriptText,
          });
        } else {
          log(`    No transcript entries for "${title}"`);
        }
      } catch (err) {
        log(`    Transcript fetch failed: ${(err as Error).message}`);
      }
    } else {
      log(`  [${i + 1}/${rawDocs.length}] "${title}" — skipping transcript (>48h)`);
    }

    meetings.push({
      id,
      title,
      created_at: createdAt,
      url,
      transcript_summary: transcriptText.slice(0, 500),
      has_full_transcript: hasTranscript,
    });
  }

  // --- Write latest.json ---
  writeJsonAtomic(LATEST_PATH, {
    fetched_at: new Date().toISOString(),
    meetings,
  });
  log(`Wrote ${meetings.length} meeting(s) to ${LATEST_PATH}`);

  // --- Daily archives ---
  mergeDailyArchive(
    DAYS_DIR,
    meetings,
    (m) => new Date(m.created_at),
    (m) => m.id,
  );
  log(`Updated daily archives in ${DAYS_DIR}`);

  log('Done.');
}

main().catch((err) => {
  process.stderr.write(
    '[granola-fetcher] FATAL: ' +
      (err instanceof Error ? err.stack : String(err)) +
      '\n',
  );
  process.exit(1);
});
