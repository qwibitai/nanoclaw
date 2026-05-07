import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addressToEnvSlug,
  buildPlatformId,
  parsePlatformId,
  parseFromHeader,
  decodeBase64Url,
  extractBodyText,
  stripHtml,
  buildReplySubject,
  headersToMap,
  resolveAccountsFromEnv,
  envKeysForAccounts,
  parseSimpleEnvFile,
  stateFilePath,
  loadAccountState,
  saveAccountState,
  preroute,
  payloadHasCalendarPart,
  renderThreadContext,
} from './email.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('addressToEnvSlug', () => {
  it('replaces @ and .', () => {
    expect(addressToEnvSlug('jibot@gidc.bt')).toBe('jibot_at_gidc_bt');
    expect(addressToEnvSlug('joi@ito.com')).toBe('joi_at_ito_com');
  });
  it('lower-cases', () => {
    expect(addressToEnvSlug('Jibot@Ito.COM')).toBe('jibot_at_ito_com');
  });
});

describe('buildPlatformId / parsePlatformId', () => {
  it('round-trips', () => {
    const id = buildPlatformId('jibot@ito.com', 'alice@example.com');
    expect(id).toBe('email:jibot@ito.com:alice@example.com');
    const parsed = parsePlatformId(id);
    expect(parsed).toEqual({ botMailbox: 'jibot@ito.com', fromAddress: 'alice@example.com' });
  });
  it('lower-cases on build (case-insensitive identity)', () => {
    expect(buildPlatformId('Jibot@ITO.com', 'Alice@Example.COM')).toBe('email:jibot@ito.com:alice@example.com');
  });
  it('returns null on malformed input', () => {
    expect(parsePlatformId('email:onlyone')).toBeNull();
    expect(parsePlatformId('whatsapp:1234')).toBeNull();
    expect(parsePlatformId('email::missing-bot')).toBeNull();
  });
  it('preserves the from-address even when it contains additional colons', () => {
    // Local-parts can technically contain quoted colons; the address half
    // of platformId is greedy and must capture everything after the first
    // delimiter.
    const id = 'email:jibot@ito.com:weird:address@example.com';
    expect(parsePlatformId(id)).toEqual({
      botMailbox: 'jibot@ito.com',
      fromAddress: 'weird:address@example.com',
    });
  });
});

describe('parseFromHeader', () => {
  it('handles "Display Name <addr@host>"', () => {
    expect(parseFromHeader('Joi Ito <joi@ito.com>')).toEqual({ name: 'Joi Ito', address: 'joi@ito.com' });
  });
  it('strips quotes around display name', () => {
    expect(parseFromHeader('"Joi, Ito" <joi@ito.com>')).toEqual({ name: 'Joi, Ito', address: 'joi@ito.com' });
  });
  it('handles bare addresses', () => {
    expect(parseFromHeader('joi@ito.com')).toEqual({ name: null, address: 'joi@ito.com' });
  });
  it('handles missing-name angle-form', () => {
    expect(parseFromHeader('<joi@ito.com>')).toEqual({ name: null, address: 'joi@ito.com' });
  });
});

describe('decodeBase64Url', () => {
  it('decodes URL-safe base64', () => {
    // "Hello, world!" with `-` and `_` substitutions exercised.
    const data = Buffer.from('Hello, world!', 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeBase64Url(data)).toBe('Hello, world!');
  });
});

describe('extractBodyText', () => {
  it('returns top-level body when present', () => {
    const data = Buffer.from('top body', 'utf-8').toString('base64');
    expect(extractBodyText({ body: { data } })).toBe('top body');
  });
  it('prefers text/plain over text/html when both present', () => {
    const plain = Buffer.from('plain version', 'utf-8').toString('base64');
    const html = Buffer.from('<p>html version</p>', 'utf-8').toString('base64');
    const out = extractBodyText({
      parts: [
        { mimeType: 'text/html', body: { data: html } },
        { mimeType: 'text/plain', body: { data: plain } },
      ],
    });
    expect(out).toBe('plain version');
  });
  it('falls back to stripped text/html when text/plain is absent', () => {
    const html = Buffer.from('<p>hello <b>world</b></p>', 'utf-8').toString('base64');
    const out = extractBodyText({
      parts: [{ mimeType: 'text/html', body: { data: html } }],
    });
    expect(out).toBe('hello world');
  });
  it('recurses into nested multipart parts', () => {
    const plain = Buffer.from('nested plain', 'utf-8').toString('base64');
    const out = extractBodyText({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: plain } }],
        },
      ],
    });
    expect(out).toBe('nested plain');
  });
  it('returns empty string for an empty payload', () => {
    expect(extractBodyText(undefined)).toBe('');
    expect(extractBodyText({})).toBe('');
  });
});

describe('stripHtml', () => {
  it('strips tags and decodes basic entities', () => {
    expect(stripHtml('<p>hello &amp; world</p>')).toBe('hello & world');
  });
  it('removes <style> and <script> blocks entirely', () => {
    expect(stripHtml('<style>body{}</style><p>x</p><script>y</script>')).toBe('x');
  });
});

describe('buildReplySubject', () => {
  it('prepends Re: when missing', () => {
    expect(buildReplySubject('Lunch?', false)).toBe('Re: Lunch?');
  });
  it('does not double-prepend when Re: already present', () => {
    expect(buildReplySubject('Re: Lunch?', false)).toBe('Re: Lunch?');
    expect(buildReplySubject('RE: Lunch?', false)).toBe('RE: Lunch?');
  });
  it('prepends [DRAFT] in pilot mode (in addition to Re:)', () => {
    expect(buildReplySubject('Lunch?', true)).toBe('[DRAFT] Re: Lunch?');
    expect(buildReplySubject('Re: Lunch?', true)).toBe('[DRAFT] Re: Lunch?');
  });
});

describe('headersToMap', () => {
  it('lower-cases keys', () => {
    const m = headersToMap([
      { name: 'From', value: 'a@b' },
      { name: 'SUBJECT', value: 'Hi' },
    ]);
    expect(m.get('from')).toBe('a@b');
    expect(m.get('subject')).toBe('Hi');
  });
  it('tolerates undefined / malformed entries', () => {
    expect(headersToMap(undefined).size).toBe(0);
    expect(headersToMap([]).size).toBe(0);
  });
});

describe('preroute', () => {
  const base = {
    defaultPlatformId: 'email:jibot@ito.com:joi@ito.com',
    fromAddress: 'joi@ito.com',
    labels: [] as string[],
    hasCalendarMimePart: false,
  };

  it('drops promotional category mail', () => {
    const r = preroute({ ...base, subject: 'Buy now!', labels: ['CATEGORY_PROMOTIONS', 'INBOX'] });
    expect(r).toEqual({ kind: 'drop', reason: 'category-promotions' });
  });

  it('promotions short-circuits even when #cal is in the subject', () => {
    // Without the ordering, a promo email with `#cal` would survive.
    const r = preroute({
      ...base,
      subject: 'Buy now! #cal special',
      labels: ['CATEGORY_PROMOTIONS'],
    });
    expect(r.kind).toBe('drop');
  });

  it('routes calendar invites to email:cal by subject prefix', () => {
    const r = preroute({ ...base, subject: 'Invitation: Sam / Joi @ Wed Apr 29' });
    expect(r).toEqual({ kind: 'route', platformId: 'email:cal', reason: 'calendar' });
  });

  it.each([
    ['Updated invitation: foo'],
    ['Accepted: foo'],
    ['Declined: foo'],
    ['Tentative: foo'],
    ['Cancelled: foo'],
    ['Canceled: foo'],
    ['Changed: foo'],
  ])('recognizes calendar subject prefix %p', (subject) => {
    const r = preroute({ ...base, subject });
    expect(r.kind === 'route' && r.platformId).toBe('email:cal');
  });

  it('routes calendar by #cal tag', () => {
    const r = preroute({ ...base, subject: 'Sync notes #cal next steps' });
    expect(r.kind === 'route' && r.platformId).toBe('email:cal');
  });

  it('routes calendar when sender is calendar-noreply@google.com', () => {
    const r = preroute({ ...base, subject: 'Reminder', fromAddress: 'calendar-noreply@google.com' });
    expect(r.kind === 'route' && r.platformId).toBe('email:cal');
  });

  it('routes calendar when payload has text/calendar part', () => {
    const r = preroute({ ...base, subject: 'No prefix', hasCalendarMimePart: true });
    expect(r.kind === 'route' && r.platformId).toBe('email:cal');
  });

  it('routes any #ws-tagged subject to the single email:ws-dispatch channel', () => {
    // Centralized: the agent (email-dispatch) reads the tag from the subject
    // at runtime, so we don't need a per-tag wiring.
    const r = preroute({ ...base, subject: 'Fwd: GMC update #ws:GMC' });
    expect(r).toEqual({ kind: 'route', platformId: 'email:ws-dispatch', reason: 'workstream' });
  });

  it('matches #ws tag regardless of name (still goes to ws-dispatch)', () => {
    const r = preroute({ ...base, subject: 'Fwd: x #ws:jp-ai_agent' });
    expect(r.kind === 'route' && r.platformId).toBe('email:ws-dispatch');
  });

  it('passes through to default platformId when no filter matches', () => {
    const r = preroute({ ...base, subject: 'just a normal email' });
    expect(r).toEqual({
      kind: 'route',
      platformId: 'email:jibot@ito.com:joi@ito.com',
      reason: 'default',
    });
  });

  it('calendar takes precedence over #ws (calendar listed first)', () => {
    const r = preroute({ ...base, subject: 'Invitation: meeting #ws:gmc' });
    expect(r.kind === 'route' && r.platformId).toBe('email:cal');
  });
});

describe('payloadHasCalendarPart', () => {
  it('finds text/calendar at the top level', () => {
    expect(payloadHasCalendarPart({ mimeType: 'text/calendar' })).toBe(true);
  });
  it('finds text/calendar nested inside multipart', () => {
    expect(
      payloadHasCalendarPart({
        mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/plain' }, { mimeType: 'text/calendar; method=REQUEST' }],
      }),
    ).toBe(true);
  });
  it('returns false for non-calendar payloads', () => {
    expect(payloadHasCalendarPart({ mimeType: 'text/plain' })).toBe(false);
    expect(payloadHasCalendarPart(undefined)).toBe(false);
  });
});

describe('renderThreadContext', () => {
  it('returns empty string for empty thread', () => {
    expect(renderThreadContext([])).toBe('');
  });
  it('renders one message with from/date/subject + body', () => {
    const out = renderThreadContext([
      {
        id: 'm1',
        internalDate: '0',
        payload: {
          headers: [
            { name: 'From', value: 'a@b' },
            { name: 'Date', value: 'Mon, 1 Jan 2026 00:00 +0000' },
            { name: 'Subject', value: 'Hi' },
          ],
          body: { data: Buffer.from('hello', 'utf-8').toString('base64') },
        },
      },
    ]);
    expect(out).toContain('Forwarded thread (1 message)');
    expect(out).toContain('From: a@b');
    expect(out).toContain('Subject: Hi');
    expect(out).toContain('hello');
  });
  it('separates multiple messages with a divider', () => {
    const mk = (id: string, body: string) => ({
      id,
      internalDate: '0',
      payload: {
        headers: [{ name: 'From', value: `${id}@x` }],
        body: { data: Buffer.from(body, 'utf-8').toString('base64') },
      },
    });
    const out = renderThreadContext([mk('m1', 'first'), mk('m2', 'second')]);
    expect(out).toContain('Forwarded thread (2 messages)');
    expect(out.match(/----------/g)?.length).toBeGreaterThanOrEqual(2);
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
  });
});

describe('parseSimpleEnvFile', () => {
  it('parses KEY=VALUE pairs', () => {
    const out = parseSimpleEnvFile('GOG_KEYRING_PASSWORD=secret\nOTHER=foo\n');
    expect(out.GOG_KEYRING_PASSWORD).toBe('secret');
    expect(out.OTHER).toBe('foo');
  });
  it('strips matched single or double quotes', () => {
    expect(parseSimpleEnvFile('A="quoted"').A).toBe('quoted');
    expect(parseSimpleEnvFile("B='also'").B).toBe('also');
  });
  it('ignores blank lines and # comments', () => {
    const out = parseSimpleEnvFile('# leading\n\nA=1\n# mid\nB=2\n');
    expect(out).toEqual({ A: '1', B: '2' });
  });
  it('preserves = signs inside the value', () => {
    expect(parseSimpleEnvFile('PW=abc=def=ghi').PW).toBe('abc=def=ghi');
  });
});

describe('envKeysForAccounts', () => {
  it('emits the per-account pilot keys', () => {
    expect(envKeysForAccounts(['jibot@ito.com', 'jibot@gidc.bt'])).toEqual([
      'EMAIL_PILOT_MODE_jibot_at_ito_com',
      'EMAIL_PILOT_REVIEWER_jibot_at_ito_com',
      'EMAIL_PILOT_MODE_jibot_at_gidc_bt',
      'EMAIL_PILOT_REVIEWER_jibot_at_gidc_bt',
    ]);
  });
});

describe('sidecar state', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-state-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stateFilePath uses the address slug', () => {
    expect(stateFilePath(tmpDir, 'jibot@gidc.bt')).toBe(path.join(tmpDir, 'email-state-jibot_at_gidc_bt.json'));
  });

  it('loadAccountState returns empty state when the file does not exist', () => {
    const s = loadAccountState(path.join(tmpDir, 'nope.json'));
    expect(s.threads.size).toBe(0);
  });

  it('loadAccountState tolerates corrupt JSON', () => {
    const file = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(file, '{not json');
    const s = loadAccountState(file);
    expect(s.threads.size).toBe(0);
  });

  it('saveAccountState then loadAccountState round-trips', () => {
    const file = path.join(tmpDir, 'rt.json');
    const s = {
      threads: new Map([
        ['t1', 'm1'],
        ['t2', 'm2'],
      ]),
    };
    saveAccountState(file, s);
    const loaded = loadAccountState(file);
    expect(loaded.threads.get('t1')).toBe('m1');
    expect(loaded.threads.get('t2')).toBe('m2');
  });

  it('saveAccountState is atomic (no .tmp file left behind on success)', () => {
    const file = path.join(tmpDir, 'atomic.json');
    saveAccountState(file, { threads: new Map([['a', 'b']]) });
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('resolveAccountsFromEnv', () => {
  it('returns empty when EMAIL_ACCOUNTS is missing', () => {
    expect(resolveAccountsFromEnv({})).toEqual([]);
  });
  it('parses a single non-pilot account', () => {
    expect(resolveAccountsFromEnv({ EMAIL_ACCOUNTS: 'jibot@ito.com' })).toEqual([
      { address: 'jibot@ito.com', pilotMode: false, pilotReviewer: null, canModifyLabels: false },
    ]);
  });
  it('parses pilot mode + reviewer', () => {
    const out = resolveAccountsFromEnv({
      EMAIL_ACCOUNTS: 'jibot@ito.com,jibot@gidc.bt',
      EMAIL_PILOT_MODE_jibot_at_gidc_bt: '1',
      EMAIL_PILOT_REVIEWER_jibot_at_gidc_bt: 'joi@ito.com',
    });
    expect(out).toEqual([
      { address: 'jibot@ito.com', pilotMode: false, pilotReviewer: null, canModifyLabels: false },
      { address: 'jibot@gidc.bt', pilotMode: true, pilotReviewer: 'joi@ito.com', canModifyLabels: false },
    ]);
  });
  it('drops pilot accounts that have no reviewer (refuse-on-misconfig)', () => {
    // Without a reviewer we cannot safely deliver — emitting the account
    // anyway would let `deliver` route a real reply to the original sender,
    // defeating pilot mode. Drop instead.
    const out = resolveAccountsFromEnv({
      EMAIL_ACCOUNTS: 'jibot@gidc.bt',
      EMAIL_PILOT_MODE_jibot_at_gidc_bt: 'true',
    });
    expect(out).toEqual([]);
  });
  it('accepts "true" as well as "1" for pilot mode', () => {
    const out = resolveAccountsFromEnv({
      EMAIL_ACCOUNTS: 'a@b.c',
      EMAIL_PILOT_MODE_a_at_b_c: 'true',
      EMAIL_PILOT_REVIEWER_a_at_b_c: 'r@x.y',
    });
    expect(out[0]?.pilotMode).toBe(true);
  });
});
