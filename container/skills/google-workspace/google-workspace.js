#!/usr/bin/env node
/**
 * Google Workspace tool for NanoClaw agents
 * Reads credentials from /workspace/accounts/accounts.json
 * Uses Node.js native fetch — no external dependencies
 *
 * Usage:
 *   node google-workspace.js <service> <command> --account <alias> [options]
 *
 * Examples:
 *   node google-workspace.js gmail list --account workspace --limit 10
 *   node google-workspace.js gmail read --account workspace --id MSG_ID
 *   node google-workspace.js gmail send --account workspace --to "x@y.com" --subject "Hi" --body "Hello"
 *   node google-workspace.js gmail search --account workspace --query "from:boss@company.com"
 *   node google-workspace.js calendar list --account workspace --days 7
 *   node google-workspace.js calendar create --account workspace --title "Meeting" --start "2026-02-25T10:00" --end "2026-02-25T11:00"
 *   node google-workspace.js drive list --account workspace
 *   node google-workspace.js drive search --account workspace --query "budget 2026"
 *   node google-workspace.js drive read --account workspace --id FILE_ID
 *   node google-workspace.js sheets read --account workspace --id SHEET_ID --range "Sheet1!A1:Z100"
 *   node google-workspace.js sheets write --account workspace --id SHEET_ID --range "Sheet1!A1" --values '[["Name","Score"],["Alice",95]]'
 *   node google-workspace.js docs read --account workspace --id DOC_ID
 *   node google-workspace.js docs create --account workspace --title "New Doc" --content "Hello world"
 *   node google-workspace.js accounts list
 */

import fs from 'fs';

const ACCOUNTS_PATH = '/workspace/accounts/accounts.json';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// --- Credential management ---

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    die(`accounts.json not found at ${ACCOUNTS_PATH}. Run /add-google-workspace to set up accounts.`);
  }
  return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf-8'));
}

function getAccount(accounts, alias) {
  const account = accounts[alias];
  if (!account) {
    die(`Account "${alias}" not found. Available accounts: ${Object.keys(accounts).join(', ')}`);
  }
  if (account.provider !== 'google') {
    die(`Account "${alias}" is not a Google account (provider: ${account.provider})`);
  }
  return account;
}

async function getAccessToken(account) {
  const body = new URLSearchParams({
    client_id: account.client_id,
    client_secret: account.client_secret,
    refresh_token: account.refresh_token,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    die(`Failed to refresh access token: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

// --- HTTP helpers ---

async function gapi(token, method, url, body) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    die(`Google API error ${res.status}: ${text}`);
  }
  return res.json();
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

// --- Argument parsing ---

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] ?? true;
      i++;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

// --- Gmail ---

async function gmailList(token, args) {
  const limit = parseInt(args.limit || '10');
  const q = args.query || '';
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const data = await gapi(token, 'GET', url);
  if (!data.messages?.length) { out({ messages: [] }); return; }

  const messages = await Promise.all(
    data.messages.slice(0, limit).map(async ({ id }) => {
      const msg = await gapi(token, 'GET',
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      const headers = Object.fromEntries(
        (msg.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
      );
      return { id, from: headers.from, subject: headers.subject, date: headers.date, snippet: msg.snippet };
    })
  );
  out({ messages });
}

async function gmailRead(token, args) {
  if (!args.id) die('--id required');
  const msg = await gapi(token, 'GET',
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.id}?format=full`
  );
  const headers = Object.fromEntries(
    (msg.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
  );

  function decodeBody(part) {
    if (part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.parts) {
      const text = part.parts.find(p => p.mimeType === 'text/plain');
      const html = part.parts.find(p => p.mimeType === 'text/html');
      return decodeBody(text || html || part.parts[0]);
    }
    return '';
  }

  out({
    id: msg.id,
    from: headers.from,
    to: headers.to,
    subject: headers.subject,
    date: headers.date,
    body: decodeBody(msg.payload),
  });
}

async function gmailSend(token, args) {
  if (!args.to) die('--to required');
  if (!args.subject) die('--subject required');
  const body = args.body || '';
  const raw = Buffer.from(
    `To: ${args.to}\r\nSubject: ${args.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');
  const result = await gapi(token, 'POST',
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    { raw }
  );
  out({ sent: true, id: result.id });
}

async function gmailSearch(token, args) {
  if (!args.query) die('--query required');
  args.query = args.query;
  return gmailList(token, { ...args, limit: args.limit || '20' });
}

async function gmailReply(token, args) {
  if (!args.id) die('--id required (original message id)');
  if (!args.body) die('--body required');

  const orig = await gapi(token, 'GET',
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-Id&metadataHeaders=References`
  );
  const headers = Object.fromEntries(
    (orig.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
  );

  const threadId = orig.threadId;
  const replyTo = headers.from;
  const subject = headers.subject?.startsWith('Re:') ? headers.subject : `Re: ${headers.subject}`;
  const references = [headers['message-id'], headers.references].filter(Boolean).join(' ');

  const raw = Buffer.from(
    `To: ${replyTo}\r\nSubject: ${subject}\r\nIn-Reply-To: ${headers['message-id']}\r\nReferences: ${references}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`
  ).toString('base64url');

  const result = await gapi(token, 'POST',
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    { raw, threadId }
  );
  out({ sent: true, id: result.id, threadId: result.threadId });
}

// --- Calendar ---

async function calendarListCalendars(token, args) {
  const url = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
  const data = await gapi(token, 'GET', url);
  const calendars = (data.items || []).map(c => ({
    id: c.id,
    name: c.summary,
    primary: c.primary || false,
    accessRole: c.accessRole,
  }));
  out({ calendars });
}

async function calendarList(token, args) {
  const calId = encodeURIComponent(args.calendar || 'primary');
  let timeMin, timeMax;

  if (args.date) {
    // Specific date: YYYY-MM-DD
    const d = new Date(args.date);
    timeMin = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    timeMax = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
  } else {
    // Future events (days from now)
    const days = parseInt(args.days || '7');
    const now = new Date();
    timeMin = now.toISOString();
    timeMax = new Date(now.getTime() + days * 86400000).toISOString();
  }

  const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=50`;
  const data = await gapi(token, 'GET', url);
  const events = (data.items || []).map(e => ({
    id: e.id,
    title: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location,
    description: e.description,
    attendees: e.attendees?.map(a => a.email),
  }));
  out({ events });
}

async function calendarCreate(token, args) {
  if (!args.title) die('--title required');
  if (!args.start) die('--start required (ISO 8601, e.g. 2026-02-25T10:00:00)');
  if (!args.end) die('--end required (ISO 8601)');
  const calId = encodeURIComponent(args.calendar || 'primary');
  const event = {
    summary: args.title,
    description: args.description,
    location: args.location,
    start: { dateTime: new Date(args.start).toISOString(), timeZone: args.timezone || 'UTC' },
    end: { dateTime: new Date(args.end).toISOString(), timeZone: args.timezone || 'UTC' },
  };
  if (args.attendees) {
    event.attendees = args.attendees.split(',').map(e => ({ email: e.trim() }));
  }
  const result = await gapi(token, 'POST',
    `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`, event
  );
  out({ created: true, id: result.id, link: result.htmlLink });
}

// --- Drive ---

async function driveList(token, args) {
  const folder = args.folder ? `'${args.folder}' in parents and ` : '';
  const q = encodeURIComponent(`${folder}trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=${args.limit || 20}`;
  const data = await gapi(token, 'GET', url);
  out({ files: data.files || [] });
}

async function driveSearch(token, args) {
  if (!args.query) die('--query required');
  const q = encodeURIComponent(`fullText contains '${args.query}' and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&pageSize=${args.limit || 20}`;
  const data = await gapi(token, 'GET', url);
  out({ files: data.files || [] });
}

async function driveRead(token, args) {
  if (!args.id) die('--id required');
  // Export Google Docs/Sheets/Slides as plain text; download others
  const meta = await gapi(token, 'GET',
    `https://www.googleapis.com/drive/v3/files/${args.id}?fields=name,mimeType`
  );

  const exportMimeTypes = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  };

  const exportMime = exportMimeTypes[meta.mimeType];
  let url;
  if (exportMime) {
    url = `https://www.googleapis.com/drive/v3/files/${args.id}/export?mimeType=${encodeURIComponent(exportMime)}`;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${args.id}?alt=media`;
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) die(`Drive read failed: ${res.status}`);
  const content = await res.text();
  out({ name: meta.name, mimeType: meta.mimeType, content });
}

// --- Sheets ---

async function sheetsRead(token, args) {
  if (!args.id) die('--id required');
  const range = args.range || 'Sheet1';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${args.id}/values/${encodeURIComponent(range)}`;
  const data = await gapi(token, 'GET', url);
  out({ range: data.range, values: data.values || [] });
}

async function sheetsWrite(token, args) {
  if (!args.id) die('--id required');
  if (!args.range) die('--range required');
  if (!args.values) die('--values required (JSON array of arrays)');
  const values = JSON.parse(args.values);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${args.id}/values/${encodeURIComponent(args.range)}?valueInputOption=USER_ENTERED`;
  const result = await gapi(token, 'PUT', url, { range: args.range, majorDimension: 'ROWS', values });
  out({ updated: true, updatedCells: result.updatedCells });
}

async function sheetsAppend(token, args) {
  if (!args.id) die('--id required');
  if (!args.range) die('--range required');
  if (!args.values) die('--values required (JSON array of arrays)');
  const values = JSON.parse(args.values);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${args.id}/values/${encodeURIComponent(args.range)}:append?valueInputOption=USER_ENTERED`;
  const result = await gapi(token, 'POST', url, { values });
  out({ appended: true, updatedCells: result.updates?.updatedCells });
}

// --- Docs ---

async function docsRead(token, args) {
  if (!args.id) die('--id required');
  const doc = await gapi(token, 'GET',
    `https://docs.googleapis.com/v1/documents/${args.id}`
  );
  // Extract plain text from document body
  function extractText(elements) {
    return (elements || []).map(el => {
      if (el.paragraph) {
        return (el.paragraph.elements || [])
          .map(e => e.textRun?.content || '')
          .join('');
      }
      if (el.table) {
        return el.table.tableRows
          .map(row => row.tableCells.map(cell => extractText(cell.content)).join('\t'))
          .join('\n');
      }
      return '';
    }).join('');
  }
  out({
    title: doc.title,
    content: extractText(doc.body?.content),
  });
}

async function docsCreate(token, args) {
  if (!args.title) die('--title required');
  const doc = await gapi(token, 'POST',
    'https://docs.googleapis.com/v1/documents',
    { title: args.title }
  );
  if (args.content) {
    await gapi(token, 'POST',
      `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`,
      {
        requests: [{
          insertText: { location: { index: 1 }, text: args.content }
        }]
      }
    );
  }
  out({ created: true, id: doc.documentId, title: doc.title });
}

// --- accounts list (no token needed) ---

function accountsList() {
  const accounts = loadAccounts();
  const summary = Object.entries(accounts).map(([alias, acc]) => ({
    alias,
    provider: acc.provider,
    services: acc.services,
  }));
  out({ accounts: summary });
}

// --- Router ---

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [service, command] = args._;

  if (!service) {
    console.error('Usage: google-workspace.js <service> <command> --account <alias> [options]');
    console.error('Services: gmail, calendar, drive, sheets, docs, accounts');
    process.exit(1);
  }

  if (service === 'accounts' && command === 'list') {
    accountsList();
    return;
  }

  const accounts = loadAccounts();
  const alias = args.account;
  if (!alias) die('--account <alias> required');
  const account = getAccount(accounts, alias);

  if (!account.services.includes(service)) {
    die(`Account "${alias}" does not have "${service}" enabled. Enabled: ${account.services.join(', ')}`);
  }

  const token = await getAccessToken(account);

  const handlers = {
    gmail: { list: gmailList, read: gmailRead, send: gmailSend, search: gmailSearch, reply: gmailReply },
    calendar: { list: calendarList, calendars: calendarListCalendars, create: calendarCreate },
    drive: { list: driveList, search: driveSearch, read: driveRead },
    sheets: { read: sheetsRead, write: sheetsWrite, append: sheetsAppend },
    docs: { read: docsRead, create: docsCreate },
  };

  const serviceHandlers = handlers[service];
  if (!serviceHandlers) die(`Unknown service "${service}". Valid: gmail, calendar, drive, sheets, docs`);
  const handler = serviceHandlers[command];
  if (!handler) die(`Unknown command "${command}" for ${service}. Valid: ${Object.keys(serviceHandlers).join(', ')}`);

  await handler(token, args);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
