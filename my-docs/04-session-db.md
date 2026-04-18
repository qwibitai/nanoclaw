# Les deux DBs de session

## Principe fondamental : un seul écrivain par fichier

```
HOST (Node)                          CONTAINER (Bun)
     │                                      │
     │ ÉCRIT                                │ LIT (read-only)
     ▼                                      ▼
┌──────────────┐                   ┌──────────────┐
│  inbound.db  │                   │  inbound.db  │
│              │                   │              │
│ messages_in  │                   │ messages_in  │
│ delivered    │                   │ delivered    │
│ destinations │                   │ destinations │
│ session_     │                   │ session_     │
│  routing     │                   │  routing     │
└──────────────┘                   └──────────────┘

┌──────────────┐                   ┌──────────────┐
│  outbound.db │                   │  outbound.db │
│              │                   │              │
│ LIT          │◀──────────────────│ ÉCRIT        │
│ (read-only)  │                   │              │
│              │                   │ messages_out │
│ messages_out │                   │ processing_  │
│ processing_  │                   │  ack         │
│  ack         │                   │ session_     │
│ session_     │                   │  state       │
│  state       │                   └──────────────┘
└──────────────┘
```

**Pourquoi pas WAL ?** Le WAL de SQLite utilise mmap, qui ne fonctionne pas de façon fiable à travers les mounts Docker. Toutes les session DBs utilisent `journal_mode=DELETE`. Le host doit fermer sa connexion après chaque écriture pour forcer le flush des pages cache et les rendre visibles au container.

---

## Schema `inbound.db`

### `messages_in`

```sql
CREATE TABLE messages_in (
  id            TEXT PRIMARY KEY,
  seq           INTEGER UNIQUE NOT NULL,   -- toujours PAIR (host)
  kind          TEXT NOT NULL,             -- chat | task | webhook | system
  content       TEXT NOT NULL,             -- JSON stringifié
  sender_id     TEXT,                      -- user id (nullable pour webhooks)
  sender_name   TEXT,
  status        TEXT DEFAULT 'pending',    -- pending | processing | completed | failed
  status_changed TEXT,
  process_after TEXT,                      -- ISO timestamp (scheduling)
  recurrence    TEXT,                      -- cron expression
  tries         INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);
```

### `delivered`

```sql
CREATE TABLE delivered (
  seq                  INTEGER PRIMARY KEY,   -- seq du messages_out correspondant
  platform_message_id  TEXT,                  -- ID plateforme retourné par l'adapter
  delivered_at         TEXT DEFAULT (datetime('now'))
);
```

### `destinations`

```sql
CREATE TABLE destinations (
  local_name    TEXT PRIMARY KEY,   -- nom utilisé dans send_message(to="...")
  target_type   TEXT NOT NULL,      -- channel | agent
  target_id     TEXT NOT NULL,      -- platform_id ou agent_group_id
  channel_type  TEXT,               -- pour type=channel
  thread_id     TEXT
);
```

### `session_routing`

```sql
CREATE TABLE session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),   -- une seule ligne
  channel_type TEXT NOT NULL,
  platform_id  TEXT NOT NULL,
  thread_id    TEXT
);
```

---

## Schema `outbound.db`

### `messages_out`

```sql
CREATE TABLE messages_out (
  id           TEXT PRIMARY KEY,
  seq          INTEGER UNIQUE NOT NULL,   -- toujours IMPAIR (container)
  kind         TEXT NOT NULL,            -- message | system | card | file
  content      TEXT NOT NULL,            -- JSON (inclut operation, text, files, etc.)
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT,
  deliver_after TEXT,                    -- scheduling
  delivered    INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);
```

### `processing_ack`

```sql
CREATE TABLE processing_ack (
  message_in_id  TEXT PRIMARY KEY,
  status         TEXT NOT NULL,   -- processing | completed | failed
  error          TEXT,
  updated_at     TEXT DEFAULT (datetime('now'))
);
```

### `session_state`

```sql
CREATE TABLE session_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
-- Exemple : key='claude_session_id', value='session_abc123'
```

---

## Invariant de parité des `seq`

```
inbound.db messages_in  :  seq = 2, 4, 6, 8, ...   (host, PAIR)
outbound.db messages_out:  seq = 1, 3, 5, 7, ...   (container, IMPAIR)
```

**Ce n'est pas juste une anti-collision.** C'est le mécanisme de lookup pour `edit_message` et `add_reaction` : quand l'agent appelle `edit_message(seq=5)`, la lookup cherche dans `messages_out` (seuls les impairs) sans ambiguïté. L'agent voit les seq dans ses prompts et les réutilise pour cibler ses propres messages.

---

## Synchronisation `processing_ack`

Le container ne peut pas écrire dans `inbound.db`. Pour mettre à jour le statut des messages entrants :

```
Container:
  processing_ack.insert({ message_in_id, status='completed' })
  → outbound.db

Host (host-sweep.ts, 60s) :
  syncProcessingAcks()
  → lit processing_ack dans outbound.db
  → met à jour messages_in.status dans inbound.db
  → supprime les lignes de processing_ack traitées
```

---

## Heartbeat

Le container touche le fichier `.heartbeat` (mtime) toutes les quelques secondes plutôt que d'écrire en DB. Cela évite de sérialiser derrière d'autres écritures. Le host surveille le mtime pour :
- **Typing indicator** : affiche "typing" tant que le heartbeat est récent
- **Stale detection** : si mtime > 10 min → container considéré crashé
