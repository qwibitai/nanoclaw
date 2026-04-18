# Flux complet d'un message

## Vue chronologique

```
PLATEFORME          HOST (Node)                    CONTAINER (Bun)
    │                    │                               │
    │── événement ──────▶│                               │
    │                    │ 1. routeInbound()             │
    │                    │    - résolution messaging_group│
    │                    │    - upsert user              │
    │                    │    - vérif accès              │
    │                    │    - résolution session        │
    │                    │                               │
    │                    │ 2. writeSessionMessage()       │
    │                    │    - écrit messages_in         │
    │                    │      seq PAIR                 │
    │                    │                               │
    │                    │ 3. wakeContainer()             │
    │                    │    - spawn docker run          │
    │                    │      (si pas actif)           │
    │                    │                               │
    │                    │ ........ typing .............. │
    │◀── typing ─────────│ 4. setTyping() 3s refresh     │
    │                    │    (gated sur heartbeat)       │
    │                    │                               │
    │                    │                               │◀── .heartbeat touch
    │                    │                               │
    │                    │                               │ 5. poll messages_in
    │                    │                               │    status=pending
    │                    │                               │
    │                    │                               │ 6. formatMessages()
    │                    │                               │    XML delimiters
    │                    │                               │
    │                    │                               │ 7. provider.query()
    │                    │                               │    Claude Agent SDK
    │                    │                               │
    │                    │                               │ 8. MCP tool: send_message
    │                    │                               │    écrit messages_out
    │                    │                               │    seq IMPAIR
    │                    │                               │
    │                    │ 9. active poll 1s             │
    │                    │    lit messages_out            │
    │                    │                               │
    │                    │ 10. deliverSessionMessages()   │
    │                    │     adapter.deliver()          │
    │                    │     markDelivered()            │
    │                    │                               │
    │◀── message ────────│                               │
```

---

## 1. Routage entrant (`src/router.ts`)

```
onInbound(platformId, threadId, message)
         │
         ▼
   extractAndUpsertUser()
   → users table (id = "telegram:123")
         │
         ▼
   findOrCreateMessagingGroup()
   → messaging_groups (channel_type + platform_id, unique pair)
         │
         ▼
   enforceAccess()
   → owner/admin/member → OK
   → inconnu → drop | request_approval | public
         │
         ▼
   pickAgent()
   → messaging_group_agents : prend l'agent de plus haute priorité
     dont les trigger_rules correspondent au message
         │
         ▼
   resolveSession()
   → session_mode : shared | per-thread | agent-shared
   → crée si absente (inbound.db + outbound.db créés vides)
         │
         ▼
   writeSessionMessage()    writeDestinations()    writeSessionRouting()
   → inbound.db             → inbound.db           → inbound.db
     messages_in              destinations           session_routing
     seq=nextEvenSeq()
```

---

## 2. Wake du container (`src/container-runner.ts`)

```
wakeContainer(sessionId, agentGroupId)
         │
         ├── déjà en cours ? → join le wakePromise existant (déduplication)
         │
         ├── activeContainers.has() ? → return (déjà running)
         │
         ▼
   refreshProjections()
   writeDestinations() + writeSessionRouting()
         │
         ▼
   buildMounts()
   ┌──────────────────────────────────────────────────────┐
   │ /workspace/inbound.db    ← data/v2-sessions/…/inbound.db  │
   │ /workspace/outbound.db   ← data/v2-sessions/…/outbound.db │
   │ /workspace/.heartbeat    ← data/v2-sessions/…/.heartbeat  │
   │ /workspace/outbox/       ← data/v2-sessions/…/outbox/     │
   │ /workspace/agent/        ← groups/<folder>/               │
   │ /workspace/.claude/      ← data/v2-sessions/<agId>/.claude-shared/ │
   └──────────────────────────────────────────────────────┘
         │
         ▼
   spawn(CONTAINER_RUNTIME_BIN, ["run", ...args])
   markContainerRunning()
   startIdleTimer(30min)
```

---

## 3. Poll loop container (`container/agent-runner/src/poll-loop.ts`)

```
loop:
  messages = getPendingMessages()   ← messages_in WHERE status='pending'
                                       AND process_after <= now()

  si vide → sleep 1s → continue

  markProcessing(messages)           ← status='processing', status_changed=now

  routing = extractRouting(messages[0])   ← channelType, platformId, threadId

  categorize(messages) :
    admin commands  → /clear, /remote-control
    filtered        → /help
    passthrough     → autres /commandes
    normal          → tout le reste

  formatted = formatMessages(messages)
  ┌────────────────────────────────────────────────┐
  │ <message sender="Alice" time="10:00">          │
  │   Regarde ce bug                               │
  │ </message>                                     │
  │ <message sender="Bob" time="10:01">            │
  │   +1, c'est urgent                             │
  │ </message>                                     │
  └────────────────────────────────────────────────┘

  sessionId = getStoredSessionId()   ← outbound.db session_state

  events = provider.query({ prompt, sessionId, cwd, mcpServers, ... })

  pour chaque événement :
    'init'     → setStoredSessionId(newSessionId)
    'progress' → log
    'result'   → log texte final
    'error'    → retry ou fail avec backoff
```

---

## 4. Livraison (`src/delivery.ts`)

```
startActiveDeliveryPoll() ← toutes les 1s, sessions running

  pour chaque session active :
    si déjà in-flight → skip (guard double-delivery)
    
    rows = messages_out WHERE delivered=0 
                          AND deliver_after <= now()
    
    pour chaque row :
      inflightDeliveries.add(sessionId)
      
      adapter.deliver(channelType, platformId, threadId, kind, content, files)
      → retourne platform_message_id (si disponible)
      
      markDelivered(seq, platform_message_id)
      → inbound.db delivered table
      
      resetIdleTimer()   ← garde le container chaud
      
      inflightDeliveries.delete(sessionId)
```

---

## Formatage des messages par kind

| Kind | Formatage |
|------|-----------|
| `chat` | `<message sender="..." time="...">contenu</message>` |
| `chat-sdk` | idem, avec métadonnées Chat SDK |
| `task` | `<task id="..." scheduled="...">prompt</task>` |
| `webhook` | `<webhook source="...">payload JSON</webhook>` |
| `system` | `<system type="question_response" ...>...</system>` |
