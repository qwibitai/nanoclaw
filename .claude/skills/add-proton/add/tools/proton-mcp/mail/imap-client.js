/**
 * IMAP client for Proton Bridge
 * Handles read operations: list, get, search, unread
 */

import Imap from 'imap';
import { simpleParser } from 'mailparser';

/**
 * Create a short-lived IMAP connection, run `fn`, then close.
 */
function withImap(config, fn) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.username,
      password: config.password,
      host: config.imap_host || '127.0.0.1',
      port: config.imap_port || 1143,
      tls: false,
      authTimeout: 10000,
    });

    imap.once('ready', () => {
      fn(imap)
        .then((result) => {
          imap.end();
          resolve(result);
        })
        .catch((err) => {
          imap.end();
          reject(err);
        });
    });

    imap.once('error', (err) => reject(new Error(`IMAP connection failed: ${err.message}. Is Proton Bridge running?`)));
    imap.connect();
  });
}

/**
 * Fetch messages by sequence numbers. Returns parsed message objects.
 */
function fetchMessages(imap, seqnos, bodiesOpt = '') {
  return new Promise((resolve, reject) => {
    if (seqnos.length === 0) { resolve([]); return; }

    const messages = [];
    const f = imap.fetch(seqnos, { bodies: bodiesOpt, struct: true });

    f.on('message', (msg, seqno) => {
      let raw = '';
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      });
      msg.once('end', () => {
        messages.push({ seqno, raw });
      });
    });

    f.once('error', reject);
    f.once('end', async () => {
      const parsed = [];
      for (const m of messages) {
        try {
          const mail = await simpleParser(m.raw);
          parsed.push({
            id: m.seqno,
            subject: mail.subject || '(no subject)',
            from: mail.from?.text || 'unknown',
            to: mail.to?.text || '',
            date: mail.date?.toISOString() || '',
            body: mail.text || mail.html || '',
            seen: true, // will be overridden by caller if needed
          });
        } catch {
          parsed.push({ id: m.seqno, subject: '(parse error)', from: '', to: '', date: '', body: '', seen: true });
        }
      }
      resolve(parsed);
    });
  });
}

/**
 * Open INBOX and return box info.
 */
function openInbox(imap, readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', readOnly, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

/**
 * IMAP SEARCH wrapper.
 */
function imapSearch(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) reject(err);
      else resolve(results || []);
    });
  });
}

// --- Exported operations ---

export async function getUnread(config) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);
    const uids = await imapSearch(imap, ['UNSEEN']);
    if (uids.length === 0) return { count: 0, messages: [] };

    const recent = uids.slice(-20);
    const messages = await fetchMessages(imap, recent, 'HEADER');
    return {
      count: uids.length,
      messages: messages.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from,
        date: m.date,
      })),
    };
  });
}

export async function listMessages(config, limit = 10) {
  return withImap(config, async (imap) => {
    const box = await openInbox(imap, true);
    const total = box.messages.total;
    if (total === 0) return [];

    const start = Math.max(1, total - limit + 1);
    const range = `${start}:${total}`;

    const messages = await fetchMessages(imap, range, 'HEADER');

    // Check which are unseen
    const unseenIds = new Set(await imapSearch(imap, ['UNSEEN']));
    return messages
      .map((m) => ({ ...m, seen: !unseenIds.has(m.id), body: undefined }))
      .reverse();
  });
}

export async function getMessage(config, messageId) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);
    const messages = await fetchMessages(imap, [messageId], '');
    if (messages.length === 0) throw new Error(`Message ${messageId} not found`);
    return messages[0];
  });
}

export async function searchMessages(config, query) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);
    const uids = await imapSearch(imap, [['TEXT', query]]);
    if (uids.length === 0) return [];

    const recent = uids.slice(-10);
    const messages = await fetchMessages(imap, recent, 'HEADER');
    return messages.map((m) => ({ ...m, body: undefined }));
  });
}
