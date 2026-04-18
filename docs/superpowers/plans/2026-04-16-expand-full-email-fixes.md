# Expand & Full Email Button Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 bugs in the Telegram Expand and Full Email button flows: account loss after collapse/re-expand, missing metadata in mini app, XSS vulnerability, and dead action buttons.

**Architecture:** Seven tasks in dependency order: (1) thread account through expand/collapse cycle, (2) add `getMessageMeta()` to GmailOps interfaces, (3) enrich the email cache with metadata, (4) wire mini app to show real metadata, (5) sandbox email body to prevent XSS, (6) wire mini app Archive and Open in Gmail buttons, (7) expand handler uses enriched cache.

**Tech Stack:** TypeScript, Vitest, Express, grammy, googleapis

---

### Task 1: Fix Account Propagation in Expand/Collapse Cycle (Bugs 1 + 2)

**Files:**
- Modify: `src/callback-router.ts`
- Modify: `src/__tests__/callback-router.test.ts`

- [ ] **Step 1: Write failing tests for account propagation**

Add tests to `src/__tests__/callback-router.test.ts`:

```typescript
it('expand passes account through to Collapse callback data', async () => {
  const deps = makeDeps();
  await handleCallback(makeQuery('expand:msg1:personal'), deps);
  const channel = (deps.findChannel as any).mock.results[0]?.value;
  const buttons = channel.editMessageTextAndButtons.mock.calls[0][3];
  const collapseBtn = buttons.find((b: any) => b.label.includes('Collapse'));
  expect(collapseBtn.callbackData).toBe('collapse:msg1:personal');
});

it('collapse passes account through to Expand and Full Email buttons', async () => {
  const deps = makeDeps();
  const { cacheEmailBody } = await import('../email-preview.js');
  cacheEmailBody('msg1', 'A'.repeat(500));
  await handleCallback(makeQuery('collapse:msg1:personal'), deps);
  const channel = (deps.findChannel as any).mock.results[0]?.value;
  const buttons = channel.editMessageTextAndButtons.mock.calls[0][3];
  const expandBtn = buttons.find((b: any) => b.label.includes('Expand'));
  expect(expandBtn.callbackData).toBe('expand:msg1:personal');
  const fullBtn = buttons.find((b: any) => b.label.includes('Full Email'));
  expect(fullBtn.webAppUrl).toContain('?account=personal');
});

it('collapse without account still works (graceful degradation)', async () => {
  const deps = makeDeps();
  const { cacheEmailBody } = await import('../email-preview.js');
  cacheEmailBody('msg1', 'A'.repeat(500));
  await handleCallback(makeQuery('collapse:msg1'), deps);
  const channel = (deps.findChannel as any).mock.results[0]?.value;
  expect(channel.editMessageTextAndButtons).toHaveBeenCalled();
});
```

Run: `npx vitest run src/__tests__/callback-router.test.ts`
Expected: FAIL — collapse doesn't thread account through buttons

- [ ] **Step 2: Fix expand handler — pass account to Collapse callback**

In `src/callback-router.ts`, change line 159:
```typescript
// Before:
callbackData: `collapse:${entityId}`,
// After:
callbackData: `collapse:${entityId}:${account}`,
```

- [ ] **Step 3: Fix collapse handler — extract account and pass it to buttons**

In `src/callback-router.ts`, replace the collapse handler:

```typescript
case 'collapse': {
  const account = extra;  // extract account from collapse:entityId:account
  const body = getCachedEmailBody(entityId);
  if (body && channel?.editMessageTextAndButtons) {
    const summary = truncatePreview(body, 300);
    await channel.editMessageTextAndButtons(
      query.chatJid,
      query.messageId,
      summary,
      [
        {
          label: '📧 Expand',
          callbackData: `expand:${entityId}:${account}`,
          style: 'secondary',
        },
        {
          label: '🌐 Full Email',
          callbackData: `noop:${entityId}`,
          webAppUrl: MINI_APP_URL
            ? `${MINI_APP_URL}/email/${entityId}${account ? `?account=${account}` : ''}`
            : undefined,
          style: 'secondary',
        },
        {
          label: '🗄 Archive',
          callbackData: `archive:${entityId}`,
          style: 'secondary',
        },
      ],
    );
  }
  break;
}
```

- [ ] **Step 4: Run tests and verify green**

Run: `npx vitest run src/__tests__/callback-router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/callback-router.ts src/__tests__/callback-router.test.ts
git commit -m "fix: thread account through expand/collapse cycle (bugs 1+2)"
```

---

### Task 2: Add `getMessageMeta()` to GmailOps (Bug 3 + Bug 6 foundation)

**Files:**
- Modify: `src/gmail-ops.ts`
- Modify: `src/channels/gmail.ts`
- Create: `src/__tests__/gmail-get-message-meta.test.ts`

- [ ] **Step 1: Define EmailMeta type and add interface methods**

In `src/gmail-ops.ts`, add the type and methods:

```typescript
export interface EmailMeta {
  subject: string;
  from: string;
  to: string;
  date: string;
  cc?: string;
  body: string;
}
```

Add to `GmailOps` interface:
```typescript
getMessageMeta(account: string, messageId: string): Promise<EmailMeta | null>;
```

Add to `GmailOpsProvider` interface:
```typescript
getMessageMeta(messageId: string): Promise<EmailMeta | null>;
```

Add router method in `GmailOpsRouter`:
```typescript
async getMessageMeta(account: string, messageId: string): Promise<EmailMeta | null> {
  return this.getChannel(account).getMessageMeta(messageId);
}
```

- [ ] **Step 2: Write failing test for getMessageMeta**

Create `src/__tests__/gmail-get-message-meta.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { GmailOpsRouter, type GmailOpsProvider } from '../gmail-ops.js';

function mockProvider(overrides: Partial<GmailOpsProvider> = {}): GmailOpsProvider {
  return {
    archiveThread: vi.fn(),
    listRecentDrafts: vi.fn().mockResolvedValue([]),
    updateDraft: vi.fn(),
    getMessageBody: vi.fn().mockResolvedValue(null),
    getMessageMeta: vi.fn().mockResolvedValue({
      subject: 'Test Subject',
      from: 'alice@example.com',
      to: 'bob@example.com',
      date: 'Mon, 14 Apr 2026 10:00:00 -0700',
      body: 'Hello world',
    }),
    ...overrides,
  };
}

describe('GmailOpsRouter.getMessageMeta', () => {
  it('delegates to the correct provider', async () => {
    const router = new GmailOpsRouter();
    const provider = mockProvider();
    router.registerChannel('personal', provider);
    const result = await router.getMessageMeta('personal', 'msg123');
    expect(provider.getMessageMeta).toHaveBeenCalledWith('msg123');
    expect(result?.subject).toBe('Test Subject');
    expect(result?.from).toBe('alice@example.com');
  });

  it('returns null when provider returns null', async () => {
    const router = new GmailOpsRouter();
    const provider = mockProvider({
      getMessageMeta: vi.fn().mockResolvedValue(null),
    });
    router.registerChannel('personal', provider);
    const result = await router.getMessageMeta('personal', 'msg123');
    expect(result).toBeNull();
  });
});
```

Run: `npx vitest run src/__tests__/gmail-get-message-meta.test.ts`
Expected: FAIL — `getMessageMeta` doesn't exist yet

- [ ] **Step 3: Implement getMessageMeta in gmail.ts channel**

In `src/channels/gmail.ts`, add the method:

```typescript
async getMessageMeta(messageId: string): Promise<EmailMeta | null> {
  if (!this.gmail) return null;
  try {
    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    const headers = msg.data.payload?.headers || [];
    const header = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
    const body = this.extractTextBody(msg.data.payload);
    return {
      subject: header('Subject'),
      from: header('From'),
      to: header('To'),
      date: header('Date'),
      cc: header('Cc') || undefined,
      body: body || '',
    };
  } catch (err) {
    logger.warn({ messageId, err }, 'Failed to fetch message meta');
    return null;
  }
}
```

Import `EmailMeta` from `../gmail-ops.js`.

- [ ] **Step 4: Run tests and verify green**

Run: `npx vitest run src/__tests__/gmail-get-message-meta.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gmail-ops.ts src/channels/gmail.ts src/__tests__/gmail-get-message-meta.test.ts
git commit -m "feat: add getMessageMeta() to GmailOps for email metadata extraction"
```

---

### Task 3: Enrich Email Cache with Metadata (Bug 6)

**Files:**
- Modify: `src/email-preview.ts`
- Create: `src/__tests__/email-preview.test.ts`

- [ ] **Step 1: Write failing tests for enriched cache**

Create `src/__tests__/email-preview.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cacheEmailBody,
  getCachedEmailBody,
  cacheEmailMeta,
  getCachedEmailMeta,
  cleanupCache,
} from '../email-preview.js';

describe('email cache with metadata', () => {
  beforeEach(() => {
    cleanupCache();
  });

  it('cacheEmailMeta stores and retrieves full metadata', () => {
    cacheEmailMeta('msg1', {
      subject: 'Test',
      from: 'alice@example.com',
      to: 'bob@example.com',
      date: 'Mon, 14 Apr 2026',
      body: 'Hello world',
    });
    const meta = getCachedEmailMeta('msg1');
    expect(meta?.subject).toBe('Test');
    expect(meta?.from).toBe('alice@example.com');
    expect(meta?.body).toBe('Hello world');
  });

  it('getCachedEmailBody works with metadata cache entries', () => {
    cacheEmailMeta('msg2', {
      subject: 'Test',
      from: '',
      to: '',
      date: '',
      body: 'Body text',
    });
    expect(getCachedEmailBody('msg2')).toBe('Body text');
  });

  it('cacheEmailBody (legacy) still works for body-only entries', () => {
    cacheEmailBody('msg3', 'Just body');
    expect(getCachedEmailBody('msg3')).toBe('Just body');
    expect(getCachedEmailMeta('msg3')).toBeNull();
  });
});
```

Run: `npx vitest run src/__tests__/email-preview.test.ts`
Expected: FAIL — `cacheEmailMeta`/`getCachedEmailMeta` don't exist

- [ ] **Step 2: Extend cache in email-preview.ts**

```typescript
import type { EmailMeta } from './gmail-ops.js';

interface CacheEntry {
  body: string;
  meta?: EmailMeta;
  fetchedAt: number;
}

const emailCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;

// Existing functions — unchanged signatures, work with new CacheEntry
export function getCachedEmailBody(emailId: string): string | null {
  const entry = emailCache.get(emailId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    emailCache.delete(emailId);
    return null;
  }
  return entry.body;
}

export function cacheEmailBody(emailId: string, body: string): void {
  emailCache.set(emailId, { body, fetchedAt: Date.now() });
}

// New functions for enriched metadata
export function cacheEmailMeta(emailId: string, meta: EmailMeta): void {
  emailCache.set(emailId, { body: meta.body, meta, fetchedAt: Date.now() });
}

export function getCachedEmailMeta(emailId: string): EmailMeta | null {
  const entry = emailCache.get(emailId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    emailCache.delete(emailId);
    return null;
  }
  return entry.meta || null;
}

export function truncatePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cutoff = text.lastIndexOf(' ', maxChars);
  if (cutoff === -1) cutoff = maxChars;
  return text.slice(0, cutoff).trimEnd() + '— truncated —';
}

export function cleanupCache(): void {
  const now = Date.now();
  for (const [id, entry] of emailCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS) {
      emailCache.delete(id);
    }
  }
}
```

- [ ] **Step 3: Run tests and verify green**

Run: `npx vitest run src/__tests__/email-preview.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/email-preview.ts src/__tests__/email-preview.test.ts
git commit -m "feat: extend email cache to store metadata alongside body"
```

---

### Task 4: Wire Mini App to Show Real Metadata (Bug 3 completion)

**Files:**
- Modify: `src/mini-app/server.ts`
- Modify: `src/__tests__/mini-app-routes.test.ts`

- [ ] **Step 1: Write failing test for metadata in rendered HTML**

Add to `src/__tests__/mini-app-routes.test.ts`:

```typescript
it('GET /email/:emailId renders real subject, from, to, date', async () => {
  const { app, mockGmailOps } = setup();
  mockGmailOps.getMessageMeta = vi.fn().mockResolvedValue({
    subject: 'Invoice #42',
    from: 'billing@acme.com',
    to: 'me@example.com',
    date: 'Mon, 14 Apr 2026 10:00:00 GMT',
    body: 'Please pay invoice.',
  });
  const res = await request(app).get('/email/msg456?account=personal');
  expect(res.text).toContain('Invoice #42');
  expect(res.text).toContain('billing@acme.com');
  expect(res.text).toContain('me@example.com');
  expect(res.text).toContain('Mon, 14 Apr 2026');
});

it('GET /email/:emailId falls back to getMessageBody when getMessageMeta unavailable', async () => {
  const { app, mockGmailOps } = setup();
  // No getMessageMeta on mock
  const res = await request(app).get('/email/msg789?account=personal');
  expect(res.text).toContain('Full email body for test');
});
```

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts`
Expected: FAIL

- [ ] **Step 2: Update mini app server to use getMessageMeta**

In `src/mini-app/server.ts`, update the `/email/:emailId` handler:

```typescript
app.get('/email/:emailId', async (req, res) => {
  const { emailId } = req.params;
  const account = (req.query.account as string) || '';

  // Try enriched cache first
  let meta = getCachedEmailMeta(emailId);

  if (!meta && opts.gmailOps && account) {
    try {
      if ('getMessageMeta' in opts.gmailOps) {
        meta = await (opts.gmailOps as any).getMessageMeta(account, emailId);
        if (meta) cacheEmailMeta(emailId, meta);
      }
    } catch (err) {
      logger.warn({ emailId, err }, 'Failed to fetch email meta for Mini App');
    }
  }

  // Fall back to body-only
  if (!meta) {
    let body = getCachedEmailBody(emailId);
    if (!body && opts.gmailOps && account) {
      try {
        body = await opts.gmailOps.getMessageBody(account, emailId);
        if (body) cacheEmailBody(emailId, body);
      } catch (err) {
        logger.warn({ emailId, err }, 'Failed to fetch email body for Mini App');
      }
    }
    meta = {
      subject: '',
      from: '',
      to: '',
      date: '',
      body: body || 'Email body could not be loaded.',
    };
  }

  const html = renderEmailFull({
    subject: meta.subject || `Email ${emailId}`,
    from: meta.from || '',
    to: meta.to || '',
    date: meta.date || '',
    body: meta.body || 'Email body could not be loaded.',
    cc: meta.cc,
    attachments: [],
    emailId,
    account,
  });
  res.type('html').send(html);
});
```

Add imports for `getCachedEmailMeta`, `cacheEmailMeta` from `../email-preview.js`.

- [ ] **Step 3: Run tests and verify green**

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mini-app/server.ts src/__tests__/mini-app-routes.test.ts
git commit -m "feat: wire mini app to display real email metadata"
```

---

### Task 5: Sandbox Email Body in Mini App (Bug 4 — XSS)

**Files:**
- Modify: `src/mini-app/templates/email-full.ts`
- Modify: `src/__tests__/mini-app-routes.test.ts`

- [ ] **Step 1: Write test proving XSS is blocked**

Add to `src/__tests__/mini-app-routes.test.ts`:

```typescript
it('GET /email/:emailId does not render raw script tags in body', async () => {
  const { app, mockGmailOps } = setup();
  mockGmailOps.getMessageBody = vi.fn().mockResolvedValue(
    '<script>alert("xss")</script><p>Hello</p>'
  );
  const res = await request(app).get('/email/xss1?account=personal');
  expect(res.text).not.toContain('<script>alert');
  expect(res.text).toMatch(/sandbox/i);
});
```

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts`
Expected: FAIL — body currently injected raw

- [ ] **Step 2: Render body inside sandboxed iframe**

In `src/mini-app/templates/email-full.ts`, replace:
```html
<div class="body">${data.body}</div>
```
with:
```html
<div class="body">
  <iframe
    sandbox=""
    srcdoc="${escapeHtml(data.body)}"
    style="width:100%;border:none;min-height:300px;background:#0d1117;color-scheme:dark;"
    onload="this.style.height=this.contentDocument.body.scrollHeight+'px'"
  ></iframe>
</div>
```

The `sandbox=""` attribute blocks all scripts, forms, popups, navigation. The `escapeHtml` on `srcdoc` prevents attribute breakout.

- [ ] **Step 3: Run tests and verify green**

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mini-app/templates/email-full.ts src/__tests__/mini-app-routes.test.ts
git commit -m "fix: sandbox email body in iframe to prevent XSS (bug 4)"
```

---

### Task 6: Wire Mini App Archive and Open in Gmail Buttons (Bug 5)

**Files:**
- Modify: `src/mini-app/templates/email-full.ts`
- Modify: `src/mini-app/server.ts`
- Modify: `src/__tests__/mini-app-routes.test.ts`

- [ ] **Step 1: Write tests for button functionality**

Add to `src/__tests__/mini-app-routes.test.ts`:

```typescript
it('GET /email/:emailId renders Open in Gmail as a link', async () => {
  const { app } = setup();
  const res = await request(app).get('/email/msg100?account=personal');
  expect(res.text).toContain('https://mail.google.com/mail/u/0/#inbox/msg100');
});

it('GET /email/:emailId renders Archive button with data attributes', async () => {
  const { app } = setup();
  const res = await request(app).get('/email/msg100?account=personal');
  expect(res.text).toContain('data-email-id="msg100"');
  expect(res.text).toContain('data-account="personal"');
});

it('POST /api/email/:emailId/archive calls gmailOps.archiveThread', async () => {
  const { app, mockGmailOps } = setup();
  mockGmailOps.archiveThread = vi.fn().mockResolvedValue(undefined);
  const res = await request(app)
    .post('/api/email/msg100/archive')
    .send({ account: 'personal', threadId: 'thread100' });
  expect(res.status).toBe(200);
  expect(mockGmailOps.archiveThread).toHaveBeenCalledWith('personal', 'thread100');
});
```

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts`
Expected: FAIL

- [ ] **Step 2: Add emailId/account to EmailFullData interface**

In `src/mini-app/templates/email-full.ts`, extend the interface:

```typescript
export interface EmailFullData {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachments: Array<{ name: string; size: string }>;
  cc?: string;
  emailId?: string;
  account?: string;
}
```

- [ ] **Step 3: Replace dead buttons with functional elements**

In the template, replace:
```html
<button class="btn" style="background:#276749;color:#c6f6d5;">Archive</button>
<button class="btn">Open in Gmail</button>
```
with:
```html
<button class="btn" style="background:#276749;color:#c6f6d5;"
  data-email-id="${escapeHtml(data.emailId || '')}"
  data-account="${escapeHtml(data.account || '')}"
  onclick="archiveEmail(this)">Archive</button>
<a class="btn" href="https://mail.google.com/mail/u/0/#inbox/${escapeHtml(data.emailId || '')}"
  target="_blank" rel="noopener" style="text-decoration:none;display:inline-block;">Open in Gmail</a>
```

Add inline JS for the Archive button:
```html
<script>
async function archiveEmail(btn) {
  btn.disabled = true;
  btn.textContent = 'Archiving...';
  try {
    const resp = await fetch('/api/email/' + btn.dataset.emailId + '/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: btn.dataset.account }),
    });
    if (resp.ok) {
      btn.textContent = 'Archived';
      btn.style.opacity = '0.5';
      if (window.Telegram && window.Telegram.WebApp) window.Telegram.WebApp.close();
    } else {
      btn.textContent = 'Failed - Retry';
      btn.disabled = false;
    }
  } catch(e) {
    btn.textContent = 'Failed - Retry';
    btn.disabled = false;
  }
}
</script>
```

- [ ] **Step 4: Add archive API endpoint to mini-app server**

In `src/mini-app/server.ts`, add after the email route:

```typescript
app.post('/api/email/:emailId/archive', async (req, res) => {
  const { emailId } = req.params;
  const { account, threadId } = req.body;
  if (!opts.gmailOps || !account) {
    res.status(400).json({ error: 'Missing account or gmailOps' });
    return;
  }
  try {
    await opts.gmailOps.archiveThread(account, threadId || emailId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ emailId, err }, 'Mini app archive failed');
    res.status(500).json({ error: 'Archive failed' });
  }
});
```

- [ ] **Step 5: Run tests and verify green**

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mini-app/templates/email-full.ts src/mini-app/server.ts src/__tests__/mini-app-routes.test.ts
git commit -m "feat: wire Archive and Open in Gmail buttons in mini app (bug 5)"
```

---

### Task 7: Expand Handler Uses Enriched Cache via getMessageMeta

**Files:**
- Modify: `src/callback-router.ts`
- Modify: `src/__tests__/callback-router.test.ts`

- [ ] **Step 1: Write test verifying getMessageMeta is used in expand**

Add to `src/__tests__/callback-router.test.ts`:

```typescript
it('expand uses getMessageMeta when available to populate cache', async () => {
  const deps = makeDeps();
  (deps.gmailOps as any).getMessageMeta = vi.fn().mockResolvedValue({
    subject: 'Test', from: 'a@b.com', to: 'c@d.com',
    date: 'Mon', body: 'Full body text here',
  });
  await handleCallback(makeQuery('expand:msg1:personal'), deps);
  expect((deps.gmailOps as any).getMessageMeta).toHaveBeenCalledWith('personal', 'msg1');
});
```

Run: `npx vitest run src/__tests__/callback-router.test.ts`
Expected: FAIL

- [ ] **Step 2: Update expand handler to prefer getMessageMeta**

In `src/callback-router.ts`, update the expand handler:

```typescript
case 'expand': {
  const account = extra;
  let body = getCachedEmailBody(entityId);
  if (!body && deps.gmailOps && account) {
    // Prefer getMessageMeta to populate enriched cache
    if ('getMessageMeta' in deps.gmailOps) {
      const meta = await (deps.gmailOps as any).getMessageMeta(account, entityId);
      if (meta) {
        cacheEmailMeta(entityId, meta);
        body = meta.body;
      }
    }
    if (!body) {
      body = await deps.gmailOps.getMessageBody(account, entityId);
      if (body) cacheEmailBody(entityId, body);
    }
  }
  // ... rest of handler unchanged
```

Add import for `cacheEmailMeta` from `./email-preview.js`.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/callback-router.ts src/__tests__/callback-router.test.ts
git commit -m "feat: expand handler populates enriched cache via getMessageMeta"
```

---

### Summary of Changes by File

| File | Changes |
|------|---------|
| `src/callback-router.ts` | Thread `account` through collapse callback; expand uses getMessageMeta |
| `src/gmail-ops.ts` | Add `EmailMeta` type; add `getMessageMeta` to interfaces + router |
| `src/channels/gmail.ts` | Implement `getMessageMeta` — extract headers from payload |
| `src/email-preview.ts` | Add `cacheEmailMeta`, `getCachedEmailMeta`; extend cache entry type |
| `src/mini-app/server.ts` | Use `getMessageMeta` for `/email/:emailId`; add `POST /api/email/:emailId/archive` |
| `src/mini-app/templates/email-full.ts` | Sandbox body in iframe; wire buttons; add emailId/account to data |
| `src/__tests__/callback-router.test.ts` | Tests for account propagation, getMessageMeta in expand |
| `src/__tests__/mini-app-routes.test.ts` | Tests for metadata, XSS, archive API, Gmail link |
| `src/__tests__/gmail-get-message-meta.test.ts` | New: tests for getMessageMeta |
| `src/__tests__/email-preview.test.ts` | New: tests for enriched cache |
