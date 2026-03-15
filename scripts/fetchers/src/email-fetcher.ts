/**
 * email-fetcher.ts
 *
 * Fetches recent Gmail inbox messages and writes them to data/email/latest.json.
 *
 * Usage:
 *   node dist/email-fetcher.js
 *   node dist/email-fetcher.js --auth-code <CODE>   # first-time OAuth flow
 */

import path from 'path';
import { google } from 'googleapis';
import { DATA_DIR } from './shared/config.js';
import { readState, writeState } from './shared/state.js';
import { writeJsonAtomic, mergeDailyArchive } from './shared/writer.js';
import { getGoogleAuth } from './shared/google-auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailState {
  last_fetched_at?: string;
}

interface Email {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  is_unread: boolean;
  has_attachments: boolean;
  labels: string[];
}

interface EmailOutput {
  fetched_at: string;
  emails: Email[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const EMAIL_DIR = path.join(DATA_DIR, 'email');
const STATE_PATH = path.join(EMAIL_DIR, 'state.json');
const OUTPUT_PATH = path.join(EMAIL_DIR, 'latest.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a single Gmail message with exponential backoff on 429 errors.
 */
async function fetchMessageWithBackoff(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
  maxRetries = 5,
): Promise<Email> {
  let delay = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const msg = res.data;
      const headers = msg.payload?.headers ?? [];

      const getHeader = (name: string): string => {
        const h = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
        return h?.value ?? '';
      };

      const rawDate = getHeader('Date');
      let dateIso: string;
      try {
        dateIso = new Date(rawDate).toISOString();
      } catch {
        dateIso = rawDate;
      }

      const labelIds: string[] = msg.labelIds ?? [];
      const isUnread = labelIds.includes('UNREAD');
      const hasAttachments =
        labelIds.includes('HAS_ATTACHMENT') ||
        (msg.payload?.parts ?? []).some((p) => p.filename && p.filename.length > 0);

      return {
        id: msg.id ?? messageId,
        from: getHeader('From'),
        subject: getHeader('Subject'),
        snippet: msg.snippet ?? '',
        date: dateIso,
        is_unread: isUnread,
        has_attachments: hasAttachments,
        labels: labelIds,
      };
    } catch (err: unknown) {
      const status = (err as { code?: number; status?: number })?.code
        ?? (err as { code?: number; status?: number })?.status;

      if (status === 429 && attempt < maxRetries) {
        process.stderr.write(
          `[email-fetcher] 429 rate-limit on message ${messageId}, ` +
            `retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})\n`,
        );
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
        continue;
      }

      throw err;
    }
  }

  // Should never reach here
  throw new Error(`Failed to fetch message ${messageId} after ${maxRetries} retries`);
}

/**
 * Process an array of message IDs in batches of `batchSize` concurrent requests.
 */
async function fetchMessagesInBatches(
  gmail: ReturnType<typeof google.gmail>,
  messageIds: string[],
  batchSize = 10,
): Promise<Email[]> {
  const results: Email[] = [];

  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    process.stderr.write(
      `[email-fetcher] Fetching messages ${i + 1}–${Math.min(i + batchSize, messageIds.length)} ` +
        `of ${messageIds.length}\n`,
    );

    const settled = await Promise.allSettled(
      batch.map((id) => fetchMessageWithBackoff(gmail, id)),
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        process.stderr.write(
          `[email-fetcher] Failed to fetch a message: ${String(result.reason)}\n`,
        );
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stderr.write('[email-fetcher] Starting\n');

  // 1. Authenticate
  const oauth2Client = await getGoogleAuth();
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // 2. Read state
  const state = readState<EmailState>(STATE_PATH);
  process.stderr.write(
    `[email-fetcher] Last fetched at: ${state.last_fetched_at ?? '(never)'}\n`,
  );

  // 3. List messages — broad inbox search, no category filter
  process.stderr.write('[email-fetcher] Listing inbox messages (newer_than:1d)\n');
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:inbox newer_than:1d',
    maxResults: 100,
  });

  const messageList = listRes.data.messages ?? [];
  process.stderr.write(`[email-fetcher] Found ${messageList.length} message(s)\n`);

  // 4. Fetch each message (max 10 concurrent, with backoff on 429)
  const messageIds = messageList.map((m) => m.id!).filter(Boolean);
  const emails = await fetchMessagesInBatches(gmail, messageIds, 10);

  // 5. Sort by date descending (newest first)
  emails.sort((a, b) => {
    const aTime = new Date(a.date).getTime();
    const bTime = new Date(b.date).getTime();
    return bTime - aTime;
  });

  // 6. Write output
  const fetchedAt = new Date().toISOString();
  const output: EmailOutput = {
    fetched_at: fetchedAt,
    emails,
  };

  writeJsonAtomic(OUTPUT_PATH, output);
  process.stderr.write(`[email-fetcher] Wrote ${emails.length} email(s) to ${OUTPUT_PATH}\n`);

  // --- Write daily archives (rolling 7 days) ---
  const daysDir = path.join(EMAIL_DIR, 'days');
  mergeDailyArchive(
    daysDir,
    emails,
    (email) => new Date(email.date),
    (email) => email.id,
  );
  process.stderr.write(`[email-fetcher] Updated daily archives in ${daysDir}\n`);

  // 7. Update state
  writeState(STATE_PATH, { ...state, last_fetched_at: fetchedAt });
  process.stderr.write('[email-fetcher] State updated\n');

  process.stderr.write('[email-fetcher] Done\n');
}

main().catch((err) => {
  process.stderr.write(`[email-fetcher] Fatal error: ${String(err)}\n`);
  process.exit(1);
});
