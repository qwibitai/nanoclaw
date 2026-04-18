# Agent-Runner (internals container)

## Architecture interne

```
/workspace/
  inbound.db    (ro)
  outbound.db   (rw)
  .heartbeat    (rw)
  agent/        (CLAUDE.md, skills, ...)
  .claude/      (session SDK data)

┌─────────────────────────────────────────────────────────────────┐
│                    agent-runner (Bun process)                   │
│                                                                 │
│   index.ts                                                      │
│   → load config (env vars)                                      │
│   → create provider (claude | codex | opencode)                 │
│   → build MCP server config                                     │
│   → start MCP server (STDIO)                                    │
│   → runPollLoop()                                               │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                   poll-loop.ts                          │  │
│   │                                                         │  │
│   │  while(true) :                                          │  │
│   │    messages = getPendingMessages()                      │  │
│   │    si vide → sleep 1s                                   │  │
│   │                                                         │  │
│   │    markProcessing(messages)                             │  │
│   │    formatted = formatMessages(messages)  ◀── formatter  │  │
│   │    systemPrompt = buildSystemPromptAddendum()           │  │
│   │    sessionId = getStoredSessionId()                     │  │
│   │                                                         │  │
│   │    query = provider.query({                             │  │
│   │      prompt, sessionId, cwd='/workspace/agent',         │  │
│   │      mcpServers, systemPrompt                           │  │
│   │    })                                                   │  │
│   │                                                         │  │
│   │    // pendant la query : poll continu 500ms             │  │
│   │    // nouveaux messages → provider.push()               │  │
│   │                                                         │  │
│   │    for await (event of query.events) :                  │  │
│   │      'init'     → setStoredSessionId()                  │  │
│   │      'progress' → log                                   │  │
│   │      'result'   → terminé                               │  │
│   │      'error'    → retry / fail                          │  │
│   └─────────────────────────────────────────────────────────┘  │
│                          │ MCP calls                            │
│   ┌──────────────────────▼──────────────────────────────────┐  │
│   │                  MCP Tool Server                        │  │
│   │  (écoute en STDIO, utilisé par Claude Agent SDK)        │  │
│   │                                                         │  │
│   │  core.ts        : send_message, send_file, send_card    │  │
│   │  scheduling.ts  : schedule_task, list/cancel/...        │  │
│   │  interactive.ts : ask_user_question, edit_message,      │  │
│   │                   add_reaction                          │  │
│   │  agents.ts      : send_to_agent                         │  │
│   │  self-mod.ts    : install_packages, add_mcp_server,     │  │
│   │                   request_rebuild, register_agent_group  │  │
│   └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Interface Provider

```typescript
interface AgentProvider {
  query(input: QueryInput): AgentQuery
}

interface QueryInput {
  prompt: string | ContentBlock[]
  sessionId?: string          // reprise depuis session SDK précédente
  resumeAt?: string           // point de reprise provider-specific
  cwd: string                 // /workspace/agent
  mcpServers: Record<string, McpServerConfig>
  systemPrompt?: string       // addendum (destinations, etc.)
  env: Record<string, string>
  additionalDirectories?: string[]
}

interface AgentQuery {
  push(message: string): void  // injecter un follow-up pendant query active
  end(): void
  abort(): void
  events: AsyncIterable<ProviderEvent>
}

type ProviderEvent =
  | { type: 'init';     sessionId: string }
  | { type: 'result';   text: string | null }
  | { type: 'error';    message: string; retryable: boolean }
  | { type: 'progress'; message: string }
```

---

## Provider Claude (`providers/claude.ts`)

```
provider.query()
  → @anthropic-ai/claude-agent-sdk  query()
  
  Hooks configurés :
    PreCompact  → archive les transcripts (avant compaction contexte)
    PreToolUse  → sanitise les commandes bash dangereuses
  
  Tools autorisés (allowlist) :
    Bash, Read, Write, Edit, Glob, Grep
    WebSearch, WebFetch
    Task, Skill
    mcp__nanoclaw__*   (tous les outils MCP custom)
  
  Resume :
    sessionId  → JSONL transcript existant
    resumeAt   → UUID de reprise dans le transcript
```

---

## Formatage des messages (`formatter.ts`)

Le formatter produit le prompt final envoyé à Claude :

```
formatMessages(messages) :
  
  pour chaque message :
    kind=chat :
      <message sender="Alice" time="2024-01-15 10:30">
        contenu du message
      </message>
    
    kind=task :
      <task id="task_abc" scheduled="2024-01-15 10:00">
        prompt de la tâche
      </task>
    
    kind=system (question_response) :
      <system type="question_response" questionId="q_123"
              selectedOption="Approuver">
        L'utilisateur a répondu : Approuver
      </system>
    
  Images/PDFs :
    → content blocks natifs si Claude (vision)
    → sauvegarde disque + référence texte sinon
```

---

## System prompt addendum (`destinations.ts`)

En plus du CLAUDE.md du groupe, l'agent reçoit un addendum injecté au runtime :

```
Tu as accès aux destinations suivantes :
- "general"    → #general sur Discord
- "tech-team"  → #tech-team sur Slack
- "alice"      → DM Alice sur Telegram
- "pr-worker"  → agent group pr-worker

Utilise send_message(to="nom") pour cibler une destination spécifique.
Par défaut, les messages vont dans la conversation d'origine.
```

---

## MCP Tools — référence rapide

### Core

| Outil | Description |
|-------|-------------|
| `send_message(to?, text)` | Envoie un message (destination optionnelle) |
| `send_file(to?, path, filename)` | Envoie un fichier depuis /workspace/outbox/ |
| `send_card(to?, title, body, actions?)` | Envoie une carte interactive |

### Scheduling

| Outil | Description |
|-------|-------------|
| `schedule_task(prompt, processAfter, recurrence?)` | Planifie une tâche |
| `list_tasks()` | Liste les tâches planifiées |
| `cancel_task(id)` | Annule une tâche |
| `pause_task(id)` | Met en pause une tâche récurrente |
| `resume_task(id)` | Reprend une tâche pausée |
| `update_task(id, ...)` | Met à jour prompt/schedule d'une tâche |

### Interactive

| Outil | Description |
|-------|-------------|
| `ask_user_question(title, question, options, timeout?)` | Pose une question avec boutons ; **bloque** jusqu'à réponse |
| `edit_message(seq, newText)` | Édite un message déjà envoyé (via seq impair) |
| `add_reaction(seq, emoji)` | Ajoute une réaction à un message |

### Agents

| Outil | Description |
|-------|-------------|
| `send_to_agent(agentGroupId, text)` | Envoie un message à un autre agent group |

### Self-Mod

| Outil | Description |
|-------|-------------|
| `install_packages(apt?, npm?)` | Demande installation packages (admin approval requis) |
| `add_mcp_server(name, config)` | Ajoute un MCP server (admin approval requis) |
| `request_rebuild()` | Demande rebuild du container (admin approval requis) |
| `register_agent_group(name, folder)` | Crée un nouveau agent group |
