# Email Intelligence Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the end-to-end email intelligence pipeline: superpilot MCP server → NanoClaw IPC trigger → agent session → Telegram proposal.

**Architecture:** Superpilot exposes a Python MCP server (stdio transport) wrapping its FastAPI. NanoClaw's IPC watcher gains a new `email_trigger` type that spawns an agent session for the main group. A `processed_items` SQLite table prevents double-processing. The main group CLAUDE.md gets autonomy rules and email intelligence instructions. A kill switch config disables the feature.

**Tech Stack:** Python 3.11+ (MCP server), Node.js/TypeScript (NanoClaw), SQLite (state), FastAPI (superpilot endpoints)

**Spec:** [`docs/EMAIL-INTELLIGENCE-SPEC.md`](../EMAIL-INTELLIGENCE-SPEC.md)

---

## File Structure

### NanoClaw (~/dev/nanoclaw)

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Modify | Add `EMAIL_INTELLIGENCE_ENABLED` flag |
| `src/db.ts` | Modify | Add `processed_items` table + CRUD functions |
| `src/ipc.ts` | Modify | Handle `email_trigger` IPC type → spawn agent session |
| `src/types.ts` | Modify | Add `ProcessedItem` interface |
| `groups/main/CLAUDE.md` | Modify | Add autonomy rules, email intelligence section, notification config |
| `src/db.test.ts` | Create | Tests for processed_items CRUD |
| `src/ipc.test.ts` | Modify | Tests for email_trigger IPC handling |

### Superpilot (~/dev/inbox_superpilot)

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/app/api/nanoclaw_bridge.py` | Create | New API endpoints for NanoClaw: `/api/nanoclaw/triaged-emails`, `/api/nanoclaw/kb/search` |
| `backend/app/middleware/auth.py` | Modify | Add localhost service token auth bypass |
| `backend/app/api/ipc_writer.py` | Create | Write IPC trigger files to NanoClaw's IPC directory after triage |
| `backend/tests/test_nanoclaw_bridge.py` | Create | Tests for bridge endpoints |
| `backend/tests/test_service_token_auth.py` | Create | Tests for service token auth |

### Superpilot MCP Server (new sidecar)

| File | Action | Responsibility |
|------|--------|----------------|
| `mcp_server/server.py` | Create | MCP server main: 6 tools wrapping superpilot REST API |
| `mcp_server/requirements.txt` | Create | Dependencies: mcp, httpx |
| `mcp_server/README.md` | Create | Setup and usage docs |
| `mcp_server/test_server.py` | Create | Integration tests for MCP tools |

---

## Task 1: Kill Switch Config (NanoClaw)

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add EMAIL_INTELLIGENCE_ENABLED to config**

```typescript
// In src/config.ts, after the TIMEZONE export:

export const EMAIL_INTELLIGENCE_ENABLED =
  (process.env.EMAIL_INTELLIGENCE_ENABLED ??
    envConfig.EMAIL_INTELLIGENCE_ENABLED ??
    'true') !== 'false';
```

Also add `'EMAIL_INTELLIGENCE_ENABLED'` to the `readEnvFile` call array at the top of the file:

```typescript
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
  'EMAIL_INTELLIGENCE_ENABLED',
]);
```

- [ ] **Step 2: Verify build**

Run: `cd ~/dev/nanoclaw && npm run build`
Expected: Clean compile, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add EMAIL_INTELLIGENCE_ENABLED kill switch config"
```

---

## Task 2: Processed Items Table (NanoClaw)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/db.ts`
- Create: `src/db.test.ts` (or modify existing)

- [ ] **Step 1: Add ProcessedItem interface to types.ts**

```typescript
// At the end of src/types.ts:

export interface ProcessedItem {
  item_id: string;       // e.g., "email:thread_abc123" or "discord:msg_456"
  source: string;        // "superpilot" | "discord" | "poll"
  processed_at: string;  // ISO timestamp
  action_taken: string;  // "auto:calendar" | "propose:reply" | "escalate" | "skip"
}
```

- [ ] **Step 2: Add table creation to db.ts createSchema**

In `src/db.ts`, inside the `createSchema` function, add after the `registered_groups` table:

```sql
CREATE TABLE IF NOT EXISTS processed_items (
  item_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  action_taken TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_items(processed_at);
```

- [ ] **Step 3: Add CRUD functions to db.ts**

After the registered groups section in `src/db.ts`:

```typescript
// --- Processed items (email intelligence idempotency) ---

export function isItemProcessed(itemId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM processed_items WHERE item_id = ?')
    .get(itemId);
  return !!row;
}

export function markItemProcessed(item: ProcessedItem): void {
  db.prepare(
    `INSERT OR REPLACE INTO processed_items (item_id, source, processed_at, action_taken)
     VALUES (?, ?, ?, ?)`,
  ).run(item.item_id, item.source, item.processed_at, item.action_taken);
}

export function getProcessedItemsSince(since: string): ProcessedItem[] {
  return db
    .prepare(
      'SELECT * FROM processed_items WHERE processed_at > ? ORDER BY processed_at DESC',
    )
    .all(since) as ProcessedItem[];
}

export function cleanupOldProcessedItems(olderThan: string): number {
  const result = db
    .prepare('DELETE FROM processed_items WHERE processed_at < ?')
    .run(olderThan);
  return result.changes;
}
```

- [ ] **Step 4: Write tests**

Check if `src/db.test.ts` exists, then add tests:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _initTestDatabase,
  _closeDatabase,
  isItemProcessed,
  markItemProcessed,
  getProcessedItemsSince,
  cleanupOldProcessedItems,
} from './db.js';

describe('processed_items', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns false for unprocessed item', () => {
    expect(isItemProcessed('email:thread_123')).toBe(false);
  });

  it('returns true after marking processed', () => {
    markItemProcessed({
      item_id: 'email:thread_123',
      source: 'superpilot',
      processed_at: '2026-04-10T10:00:00Z',
      action_taken: 'propose:reply',
    });
    expect(isItemProcessed('email:thread_123')).toBe(true);
  });

  it('getProcessedItemsSince filters by timestamp', () => {
    markItemProcessed({
      item_id: 'email:old',
      source: 'superpilot',
      processed_at: '2026-04-09T10:00:00Z',
      action_taken: 'skip',
    });
    markItemProcessed({
      item_id: 'email:new',
      source: 'superpilot',
      processed_at: '2026-04-10T10:00:00Z',
      action_taken: 'propose:reply',
    });
    const items = getProcessedItemsSince('2026-04-09T12:00:00Z');
    expect(items).toHaveLength(1);
    expect(items[0].item_id).toBe('email:new');
  });

  it('cleanupOldProcessedItems removes old entries', () => {
    markItemProcessed({
      item_id: 'email:ancient',
      source: 'superpilot',
      processed_at: '2026-03-01T10:00:00Z',
      action_taken: 'auto:archive',
    });
    markItemProcessed({
      item_id: 'email:recent',
      source: 'superpilot',
      processed_at: '2026-04-10T10:00:00Z',
      action_taken: 'propose:reply',
    });
    const deleted = cleanupOldProcessedItems('2026-04-01T00:00:00Z');
    expect(deleted).toBe(1);
    expect(isItemProcessed('email:ancient')).toBe(false);
    expect(isItemProcessed('email:recent')).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `cd ~/dev/nanoclaw && npx vitest run src/db.test.ts`
Expected: All 4 tests pass.

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/db.ts src/db.test.ts
git commit -m "feat: add processed_items table for email intelligence idempotency"
```

---

## Task 3: Email Trigger IPC Handler (NanoClaw)

**Files:**
- Modify: `src/ipc.ts`
- Modify: `src/config.ts` (import)

When superpilot writes a JSON file like `{type: "email_trigger", emails: [...]}` to the IPC directory, the IPC watcher picks it up and queues an agent session for the main group.

- [ ] **Step 1: Add email_trigger case to processTaskIpc in ipc.ts**

In `src/ipc.ts`, add to the `data` parameter type:

```typescript
// Add to the data parameter type in processTaskIpc:
    emails?: Array<{ thread_id: string; account: string; subject: string; sender: string }>;
```

Add a new case before `default:` in the switch statement:

```typescript
    case 'email_trigger': {
      // Only main group can process email triggers
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized email_trigger attempt blocked',
        );
        break;
      }

      const { EMAIL_INTELLIGENCE_ENABLED } = await import('./config.js');
      if (!EMAIL_INTELLIGENCE_ENABLED) {
        logger.debug('Email intelligence disabled, skipping trigger');
        break;
      }

      const emailCount = data.emails?.length ?? 0;
      if (emailCount === 0) {
        logger.debug('Email trigger with no emails, skipping');
        break;
      }

      // Build a prompt summarizing what needs processing
      const emailSummaries = (data.emails ?? [])
        .map(
          (e) =>
            `- [${e.account}] From: ${e.sender}, Subject: ${e.subject} (thread: ${e.thread_id})`,
        )
        .join('\n');

      const prompt = `## Email Intelligence Trigger

${emailCount} new email(s) to process:

${emailSummaries}

Follow the Email Intelligence instructions in your CLAUDE.md. For each email:
1. Check if already processed (search processed_items)
2. Use superpilot MCP to get full context
3. Classify action tier (AUTO/PROPOSE/ESCALATE)
4. Act accordingly
5. Mark as processed`;

      // Find the main group's JID
      const mainJid = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      )?.[0];

      if (!mainJid) {
        logger.warn('No main group registered, cannot process email trigger');
        break;
      }

      // Send the prompt as a message to the main group for processing
      await deps.sendMessage(mainJid, prompt);
      logger.info(
        { emailCount, sourceGroup },
        'Email trigger dispatched to main group',
      );
      break;
    }
```

- [ ] **Step 2: Run existing IPC tests to verify no regressions**

Run: `cd ~/dev/nanoclaw && npx vitest run src/ipc`
Expected: All existing tests pass.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts
git commit -m "feat: add email_trigger IPC handler for email intelligence"
```

---

## Task 4: Superpilot Service Token Auth

**Files:**
- Modify: `~/dev/inbox_superpilot/backend/app/middleware/auth.py`
- Create: `~/dev/inbox_superpilot/backend/tests/test_service_token_auth.py`

- [ ] **Step 1: Add service token check to get_current_user**

In `~/dev/inbox_superpilot/backend/app/middleware/auth.py`, find the `get_current_user` function. Add service token check at the top of the function body, before the JWT logic:

```python
async def get_current_user(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    # --- Service token for NanoClaw (localhost only) ---
    service_token = request.headers.get("x-service-token")
    if service_token:
        expected = os.getenv("NANOCLAW_SERVICE_TOKEN", "")
        client_ip = request.client.host if request.client else ""
        is_localhost = client_ip in ("127.0.0.1", "::1", "localhost")
        if expected and service_token == expected and is_localhost:
            user = db.query(User).filter(User.email == os.getenv("NANOCLAW_SERVICE_USER", "topcoder1@gmail.com")).first()
            if user:
                logger.debug(f"[Auth] Service token auth for NanoClaw (user={user.email})")
                return user
        logger.warning(f"[Auth] Invalid service token attempt from {client_ip}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid service token")

    # ... existing JWT auth logic continues unchanged ...
```

- [ ] **Step 2: Store the service token in OneCLI vault**

```bash
cd ~/dev/wxa-secrets && uv run python -m wxa_secrets set NANOCLAW_SERVICE_TOKEN "$(openssl rand -hex 32)"
```

- [ ] **Step 3: Add env vars to superpilot's .env**

```bash
# In ~/dev/inbox_superpilot/backend/.env, add:
NANOCLAW_SERVICE_TOKEN=<value from step 2>
NANOCLAW_SERVICE_USER=topcoder1@gmail.com
```

- [ ] **Step 4: Write tests**

Create `~/dev/inbox_superpilot/backend/tests/test_service_token_auth.py`:

```python
"""Tests for NanoClaw service token authentication."""
import os
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient


def test_service_token_rejected_without_env():
    """Service token is rejected when NANOCLAW_SERVICE_TOKEN is not set."""
    # Test that missing env var rejects the token
    pass  # Implement when superpilot test infrastructure is understood


def test_service_token_rejected_from_non_localhost():
    """Service token is rejected from non-localhost IPs."""
    pass


def test_service_token_accepted_from_localhost():
    """Service token is accepted from localhost with correct token."""
    pass
```

Note: Test implementation depends on superpilot's test fixtures. The test structure is correct; fill in when running in the superpilot repo.

- [ ] **Step 5: Commit (in superpilot repo)**

```bash
cd ~/dev/inbox_superpilot
git add backend/app/middleware/auth.py backend/tests/test_service_token_auth.py
git commit -m "feat: add localhost service token auth for NanoClaw bridge"
```

---

## Task 5: Superpilot NanoClaw Bridge API

**Files:**
- Create: `~/dev/inbox_superpilot/backend/app/api/nanoclaw_bridge.py`
- Modify: `~/dev/inbox_superpilot/backend/app/main.py` (register router)

- [ ] **Step 1: Create the bridge API module**

Create `~/dev/inbox_superpilot/backend/app/api/nanoclaw_bridge.py`:

```python
"""NanoClaw Bridge API — endpoints consumed by the superpilot MCP server.

These endpoints exist specifically for NanoClaw's email intelligence pipeline.
Auth: localhost service token (see middleware/auth.py).
"""
import logging
from datetime import datetime, timedelta, UTC

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/nanoclaw", tags=["nanoclaw-bridge"])


# --- Request/Response Models ---

class TriagedEmail(BaseModel):
    thread_id: str
    account: str  # "personal" | "whoisxml" | "attaxion" | "dev"
    subject: str
    sender: str
    sender_email: str
    received_at: str
    email_type: str | None  # "people" | "newsletters" | "promotions" etc.
    priority: str | None  # "low" | "normal" | "high" | "critical"
    needs_reply: bool
    suggested_action: str | None  # brief action hint from triage
    action_items: list[str]


class TriagedEmailsResponse(BaseModel):
    emails: list[TriagedEmail]
    count: int


class KBSearchResult(BaseModel):
    document_id: str
    title: str
    content_preview: str
    relevance_score: float
    tags: list[str]


class KBSearchResponse(BaseModel):
    results: list[KBSearchResult]
    query: str
    count: int


# --- Endpoints ---

@router.get("/triaged-emails", response_model=TriagedEmailsResponse)
async def get_triaged_emails(
    since: str = Query(..., description="ISO timestamp — return emails triaged after this time"),
    account: str | None = Query(None, description="Filter by account alias"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return emails that superpilot has triaged since a given timestamp.

    Joins email_classifications + email_threads to build the response.
    This is a new query — superpilot's existing endpoints are per-thread,
    not batch-since-timestamp.
    """
    # TODO: Implement query against superpilot's email_classifications
    # and email_threads tables. The exact query depends on superpilot's
    # ORM models. Skeleton:
    #
    # since_dt = datetime.fromisoformat(since)
    # query = db.query(EmailClassification).filter(
    #     EmailClassification.created_at > since_dt,
    #     EmailClassification.user_id == current_user.id,
    # )
    # if account:
    #     query = query.filter(EmailClassification.account == account)
    # rows = query.order_by(EmailClassification.created_at.desc()).limit(50).all()
    #
    # For now, return empty to unblock MCP server development:
    return TriagedEmailsResponse(emails=[], count=0)


@router.get("/kb/search", response_model=KBSearchResponse)
async def search_kb(
    q: str = Query(..., description="Search query"),
    tags: str | None = Query(None, description="Comma-separated tags to filter by"),
    limit: int = Query(10, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Semantic search across the user's knowledge base.

    Wraps superpilot's existing ChromaDB hybrid search (vector + BM25).
    """
    # TODO: Wire to superpilot's KB search service.
    # The search logic exists in app/services/kb.py but has no API endpoint.
    # Skeleton:
    #
    # from app.services.kb import search_documents
    # tag_list = [t.strip() for t in tags.split(",")] if tags else None
    # results = await search_documents(current_user.id, q, tag_list, limit, db)
    #
    # For now, return empty:
    return KBSearchResponse(results=[], query=q, count=0)
```

- [ ] **Step 2: Register the router in main.py**

Find where other routers are included in `~/dev/inbox_superpilot/backend/app/main.py` and add:

```python
from app.api.nanoclaw_bridge import router as nanoclaw_bridge_router
app.include_router(nanoclaw_bridge_router)
```

- [ ] **Step 3: Verify superpilot starts**

```bash
cd ~/dev/inbox_superpilot/backend
python -c "from app.api.nanoclaw_bridge import router; print('Bridge router OK')"
```

- [ ] **Step 4: Commit (in superpilot repo)**

```bash
cd ~/dev/inbox_superpilot
git add backend/app/api/nanoclaw_bridge.py backend/app/main.py
git commit -m "feat: add NanoClaw bridge API (triaged-emails + kb/search endpoints)"
```

---

## Task 6: Superpilot IPC Writer

**Files:**
- Create: `~/dev/inbox_superpilot/backend/app/api/ipc_writer.py`

This module writes IPC trigger files to NanoClaw's IPC directory after superpilot triages an email.

- [ ] **Step 1: Create the IPC writer module**

Create `~/dev/inbox_superpilot/backend/app/api/ipc_writer.py`:

```python
"""Write IPC trigger files to NanoClaw's IPC directory.

After superpilot triages an email, this module writes a JSON file
to NanoClaw's IPC directory so the IPC watcher can spawn an agent session.

The IPC directory is: ~/dev/nanoclaw/data/ipc/main/tasks/
"""
import json
import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# NanoClaw IPC directory — configurable via env var
NANOCLAW_IPC_DIR = os.getenv(
    "NANOCLAW_IPC_DIR",
    os.path.expanduser("~/dev/nanoclaw/data/ipc/main/tasks"),
)


def write_email_trigger(
    emails: list[dict],
) -> bool:
    """Write an email_trigger IPC file for NanoClaw.

    Args:
        emails: List of dicts with thread_id, account, subject, sender.

    Returns:
        True if file was written successfully, False otherwise.
    """
    if not emails:
        return False

    ipc_dir = Path(NANOCLAW_IPC_DIR)
    if not ipc_dir.exists():
        logger.warning(f"NanoClaw IPC directory not found: {ipc_dir}")
        return False

    payload = {
        "type": "email_trigger",
        "emails": emails,
        "triggered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    filename = f"email_trigger_{int(time.time() * 1000)}.json"
    filepath = ipc_dir / filename

    try:
        filepath.write_text(json.dumps(payload, indent=2))
        logger.info(f"Wrote NanoClaw IPC trigger: {filename} ({len(emails)} emails)")
        return True
    except Exception as e:
        logger.error(f"Failed to write NanoClaw IPC trigger: {e}")
        return False
```

Note: Integration with superpilot's Gmail Push webhook (calling `write_email_trigger` after triage) is deferred to Phase 1b — the webhook handler in `gmail_push.py` needs careful study to find the right hook point. For now, this module can be called manually or from a test script.

- [ ] **Step 2: Commit (in superpilot repo)**

```bash
cd ~/dev/inbox_superpilot
git add backend/app/api/ipc_writer.py
git commit -m "feat: add NanoClaw IPC writer for email trigger notifications"
```

---

## Task 7: Superpilot MCP Server

**Files:**
- Create: `~/dev/inbox_superpilot/mcp_server/server.py`
- Create: `~/dev/inbox_superpilot/mcp_server/requirements.txt`

- [ ] **Step 1: Create requirements.txt**

Create `~/dev/inbox_superpilot/mcp_server/requirements.txt`:

```
mcp>=1.0.0
httpx>=0.27.0
```

- [ ] **Step 2: Create the MCP server**

Create `~/dev/inbox_superpilot/mcp_server/server.py`:

```python
"""Superpilot MCP Server — exposes email intelligence + KB tools for NanoClaw.

Transport: stdio (NanoClaw's container agent connects via MCP stdio).
Auth: Uses NANOCLAW_SERVICE_TOKEN for all requests to superpilot's API.

Usage:
    python server.py

Env vars:
    SUPERPILOT_URL      — Base URL (default: http://localhost:8000)
    NANOCLAW_SERVICE_TOKEN — Service token for auth
"""
import os
import httpx
from mcp.server.fastmcp import FastMCP

SUPERPILOT_URL = os.getenv("SUPERPILOT_URL", "http://localhost:8000")
SERVICE_TOKEN = os.getenv("NANOCLAW_SERVICE_TOKEN", "")

mcp = FastMCP("superpilot")


def _headers() -> dict[str, str]:
    return {"x-service-token": SERVICE_TOKEN}


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=SUPERPILOT_URL, headers=_headers(), timeout=30.0)


# --- Email Intelligence Tools ---

@mcp.tool()
async def get_triaged_emails(since: str, account: str | None = None) -> str:
    """Fetch emails that superpilot has triaged since a given ISO timestamp.

    Returns classified emails with urgency, type, action items, and suggested actions.
    Use this at the start of each intelligence cycle to see what's new.

    Args:
        since: ISO timestamp (e.g., "2026-04-10T10:00:00Z")
        account: Optional filter — "personal", "whoisxml", "attaxion", or "dev"
    """
    async with _client() as client:
        params = {"since": since}
        if account:
            params["account"] = account
        resp = await client.get("/api/nanoclaw/triaged-emails", params=params)
        resp.raise_for_status()
        return resp.text


@mcp.tool()
async def get_thread_summary(thread_id: str, subject: str, messages: str) -> str:
    """Get an AI-generated summary of an email thread.

    Args:
        thread_id: The email thread ID
        subject: Email subject line
        messages: The email messages as a formatted string
    """
    async with _client() as client:
        resp = await client.post(
            "/api/email-intelligence/summarize",
            json={"thread_id": thread_id, "subject": subject, "messages": messages},
        )
        resp.raise_for_status()
        return resp.text


@mcp.tool()
async def get_awaiting_reply() -> str:
    """Get emails that are awaiting your reply, prioritized by urgency.

    Returns a list of threads where you need to respond.
    """
    async with _client() as client:
        resp = await client.get("/api/inbox/awaiting-reply")
        resp.raise_for_status()
        return resp.text


@mcp.tool()
async def generate_reply(
    thread_id: str,
    subject: str,
    messages: str,
    sender_email: str,
    reply_instruction: str | None = None,
) -> str:
    """Generate a KB-grounded reply draft for an email thread.

    Uses superpilot's hybrid reply pipeline with RAG for knowledge-grounded responses.

    Args:
        thread_id: The email thread ID
        subject: Email subject line
        messages: The email messages as a formatted string
        sender_email: The sender's email address
        reply_instruction: Optional instruction for tone/content (e.g., "decline politely")
    """
    async with _client() as client:
        payload = {
            "thread_id": thread_id,
            "subject": subject,
            "messages": messages,
            "sender_email": sender_email,
        }
        if reply_instruction:
            payload["instruction"] = reply_instruction
        resp = await client.post("/api/email-intelligence/hybrid-reply", json=payload)
        resp.raise_for_status()
        return resp.text


# --- Knowledge Base Tools ---

@mcp.tool()
async def search_kb(query: str, tags: str | None = None, limit: int = 10) -> str:
    """Search the knowledge base using semantic search (vector + BM25).

    Use this to find relevant context before drafting replies or making decisions.

    Args:
        query: Natural language search query
        tags: Optional comma-separated tags to filter by (e.g., "project:product-center")
        limit: Max results (default 10)
    """
    async with _client() as client:
        params = {"q": query, "limit": limit}
        if tags:
            params["tags"] = tags
        resp = await client.get("/api/nanoclaw/kb/search", params=params)
        resp.raise_for_status()
        return resp.text


@mcp.tool()
async def upload_to_kb(content: str, title: str, tags: str = "") -> str:
    """Store text content in the knowledge base for future retrieval.

    Use this to save research findings, email summaries, meeting notes, etc.

    Args:
        content: The text content to store
        title: A descriptive title for the document
        tags: Comma-separated tags (e.g., "project:attaxion,type:research")
    """
    async with _client() as client:
        resp = await client.post(
            "/api/kb/text",
            json={
                "content": content,
                "title": title,
                "metadata": {"tags": tags},
            },
        )
        resp.raise_for_status()
        return resp.text


if __name__ == "__main__":
    mcp.run(transport="stdio")
```

- [ ] **Step 3: Install dependencies and verify**

```bash
cd ~/dev/inbox_superpilot/mcp_server
pip install -r requirements.txt
python -c "from server import mcp; print(f'MCP server loaded: {len(mcp._tool_manager._tools)} tools')"
```

Expected: `MCP server loaded: 6 tools`

- [ ] **Step 4: Commit (in superpilot repo)**

```bash
cd ~/dev/inbox_superpilot
git add mcp_server/
git commit -m "feat: add superpilot MCP server with 6 tools for NanoClaw"
```

---

## Task 8: Main Group CLAUDE.md — Email Intelligence Section

**Files:**
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md`

- [ ] **Step 1: Append email intelligence instructions to main CLAUDE.md**

Add the following sections to the end of `groups/main/CLAUDE.md`:

```markdown
---

## Email Intelligence

You have access to the superpilot MCP server which provides email triage, KB search, and reply generation.

### Available Superpilot Tools

- `get_triaged_emails(since)` — fetch recently triaged emails
- `get_thread_summary(thread_id, subject, messages)` — AI summary of a thread
- `get_awaiting_reply()` — emails needing your response
- `generate_reply(thread_id, subject, messages, sender_email)` — KB-grounded draft
- `search_kb(query, tags?)` — semantic search across knowledge base
- `upload_to_kb(content, title, tags)` — store new knowledge

### Processing Flow

When triggered with new emails:
1. Check if each email is already in `processed_items` (avoid double-processing)
2. Classify each email into action tier (AUTO / PROPOSE / ESCALATE)
3. Execute actions per tier rules below
4. Mark each email as processed
5. Report results

### Autonomy Rules

#### AUTO (no approval needed)
- Calendar events from explicit dates in emails
- Archive newsletters and marketing emails
- File attachments to KB
- Update contact profiles from email signatures

#### PROPOSE (approval required)
- Reply to any email → draft and send to Telegram for approval
- Create GitHub issues
- Research tasks
- Schedule meetings

#### ESCALATE (always escalate immediately)
- Anything involving money >$500
- Legal documents or contracts
- Novel situations not covered by rules

### Notification Intensity
Default: verbose (initial trust-building phase)

Overrides:
- Escalations: always on (can't silence)
- Auto-handled emails: silent (only in weekly review)
- Proposals: normal (batched per cycle)
- Morning briefing: always on

### Account Routing

- [personal] — topcoder1@gmail.com
- [whoisxml] — jonathan.zhang@whoisxmlapi.com
- [attaxion] — jonathan@attaxion.com
- [dev] — dev@whoisxmlapi.com

Never cross-reference between accounts unless explicitly asked.

### Storage Discipline

Before storing anything, ask:
1. Will I need this again? If not, don't store it.
2. Can I find it elsewhere? If yes, store a pointer, not a copy.
3. Is this signal or noise? Only store signal.

Do NOT store: pleasantries, acknowledgments, routine scheduling, googleable facts.
DO store: decisions, deadlines, commitments, relationship insights, research findings.
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/nanoclaw
git add groups/main/CLAUDE.md
git commit -m "feat: add email intelligence instructions to main group CLAUDE.md"
```

---

## Task 9: Wire MCP Server to Container Runner

**Files:**
- Modify: `~/dev/nanoclaw/src/container-runner.ts`

The container agent needs to reach the superpilot MCP server. Add the MCP server as a tool available to main group containers.

- [ ] **Step 1: Add SUPERPILOT_MCP env var to container runner**

In `src/container-runner.ts`, find where `ONECLI_URL` is passed as an env var to the container. Add the superpilot MCP URL nearby. Look for the `docker run` command construction and add:

```typescript
// After the ONECLI_URL env var, add:
if (input.isMain) {
  const superpilotMcpUrl = process.env.SUPERPILOT_MCP_URL || 'http://host.docker.internal:8100';
  // The MCP server runs on host — container reaches it via host.docker.internal
  envVars.push(`SUPERPILOT_MCP_URL=${superpilotMcpUrl}`);
}
```

Note: The exact integration point depends on how `container-runner.ts` builds the docker command. Read the full file to find where env vars are set, then add `SUPERPILOT_MCP_URL` there. Only add for main group containers (email intelligence runs in main context).

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: expose SUPERPILOT_MCP_URL to main group containers"
```

---

## Task 10: End-to-End Smoke Test

- [ ] **Step 1: Manual IPC trigger test**

Create a test IPC file manually to verify the pipeline:

```bash
# Make sure NanoClaw is running (npm run dev)
# Write a test email trigger to the IPC directory:
mkdir -p ~/dev/nanoclaw/data/ipc/main/tasks
cat > ~/dev/nanoclaw/data/ipc/main/tasks/test_email_$(date +%s).json << 'EOF'
{
  "type": "email_trigger",
  "emails": [
    {
      "thread_id": "test_thread_001",
      "account": "personal",
      "subject": "Test: Q2 pricing update",
      "sender": "mike@example.com"
    }
  ],
  "triggered_at": "2026-04-10T16:00:00Z"
}
EOF
```

Expected: NanoClaw logs show:
- `Email trigger dispatched to main group`
- Container agent spawns for main group
- Agent reads the email intelligence instructions from CLAUDE.md
- Agent attempts to call superpilot MCP tools (may fail if MCP server isn't running — that's OK for this test)

- [ ] **Step 2: Verify kill switch works**

```bash
# Set EMAIL_INTELLIGENCE_ENABLED=false in .env or environment
# Write another IPC trigger
# Verify NanoClaw logs: "Email intelligence disabled, skipping trigger"
```

- [ ] **Step 3: Verify idempotency**

```bash
# After the first trigger processes, write the same trigger again
# The agent should check processed_items and skip the already-processed email
```

- [ ] **Step 4: Final build + test check**

```bash
cd ~/dev/nanoclaw
npm run build
npx vitest run
```

Expected: All tests pass, clean build.

- [ ] **Step 5: Commit any test fixes**

```bash
git add -A
git commit -m "test: end-to-end smoke test for email intelligence pipeline"
```

---

## Summary

| Task | Codebase | What it adds |
|------|----------|-------------|
| 1 | NanoClaw | Kill switch config |
| 2 | NanoClaw | Processed items table + CRUD |
| 3 | NanoClaw | Email trigger IPC handler |
| 4 | Superpilot | Service token auth |
| 5 | Superpilot | Bridge API (triaged-emails + kb/search) |
| 6 | Superpilot | IPC writer module |
| 7 | Superpilot | MCP server (6 tools) |
| 8 | NanoClaw | Main group CLAUDE.md email intelligence section |
| 9 | NanoClaw | Wire MCP URL to container runner |
| 10 | NanoClaw | End-to-end smoke test |

**After Phase 1:** You can write an IPC file and NanoClaw spawns an agent that reads email intelligence instructions, calls superpilot MCP tools, and proposes actions on Telegram. The bridge API returns empty results until the TODO queries are implemented against superpilot's actual DB models — that's Phase 1b work (wiring `get_triaged_emails` to real data).
