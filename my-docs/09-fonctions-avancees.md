# Fonctions avancées

## 1. Questions interactives (`ask_user_question`)

```
AGENT                    HOST                    UTILISATEUR
  │                        │                          │
  │  ask_user_question()   │                          │
  │  (MCP tool)            │                          │
  │  → messages_out        │                          │
  │    operation='ask'     │                          │
  │    questionId='q_123'  │                          │
  │    options=['Oui','Non']│                         │
  │                        │                          │
  │                        │ active poll (1s)         │
  │                        │ lit messages_out         │
  │                        │                          │
  │                        │ pending_questions.insert │
  │                        │ → central DB             │
  │                        │                          │
  │                        │ deliver carte → adapter  │
  │                        │─────────────────────────▶│
  │                        │  ┌──────────────────┐    │
  │                        │  │ Question ?        │    │
  │                        │  │ [ Oui ] [ Non ]  │    │
  │                        │  └──────────────────┘    │
  │                        │                          │
  │ ... MCP tool bloque    │                          │
  │ (poll messages_in      │               clique Oui │
  │  500ms en attendant    │◀─────────────────────────│
  │  system message)       │ onAction(q_123, 'Oui')   │
  │                        │                          │
  │                        │ messages_in.insert({     │
  │                        │   kind='system',         │
  │                        │   type='question_resp',  │
  │                        │   questionId='q_123',    │
  │                        │   selectedOption='Oui'   │
  │                        │ })                       │
  │                        │ wakeContainer()          │
  │                        │                          │
  │◀── tool result 'Oui' ──│                          │
  │                        │ pending_questions.delete │
```

Le MCP tool `ask_user_question` **bloque** la query Claude jusqu'à réception de la réponse. La boucle de poll container (500ms) détecte le message system et le retourne comme résultat de l'outil.

---

## 2. Scheduling et récurrence

```
Lifecycle d'une tâche planifiée :

schedule_task(
  prompt    = "Envoie le rapport de la semaine",
  processAfter = "2024-01-22 09:00",
  recurrence   = "0 9 * * 1"   ← chaque lundi à 9h
)
   │
   ▼
messages_in :
  kind='task'
  status='pending'
  process_after='2024-01-22 09:00'
  recurrence='0 9 * * 1'
   │
   ▼ host-sweep (60s)

Exécution #1 (lundi 22 jan) :
  wakeContainer() → agent exécute
  markCompleted(msg_id)
  
  handleRecurrence() :
    next = cronParser.next('0 9 * * 1', from='2024-01-22 09:00')
         = '2024-01-29 09:00'   ← calculé depuis schedule, pas wall-clock
    
    messages_in.insert({
      kind='task', process_after='2024-01-29 09:00',
      recurrence='0 9 * * 1', status='pending'
    })

Exécution #2 (lundi 29 jan) : idem...
```

**Pourquoi calculer depuis le schedule ?** Si le sweep tourne à 09:01 au lieu de 09:00, calculer depuis `now` produirait la prochaine occurrence à 09:01 la semaine suivante — drift progressif. Calculer depuis le `process_after` prévu évite ce drift.

---

## 3. Communication agent-to-agent

```
AGENT A (pr-admin)          HOST                  AGENT B (pr-worker)
      │                       │                          │
      │ send_to_agent(         │                          │
      │   'pr-worker',         │                          │
      │   'Analyse cette PR'   │                          │
      │ )                      │                          │
      │ → messages_out :       │                          │
      │   channel_type='agent' │                          │
      │   platform_id=         │                          │
      │     'pr-worker'        │                          │
      │                        │                          │
      │                        │ active poll (1s)         │
      │                        │ channelType='agent'      │
      │                        │ → routing interne        │
      │                        │                          │
      │                        │ résolution session       │
      │                        │ pour pr-worker           │
      │                        │                          │
      │                        │ messages_in.insert(      │
      │                        │   session=pr-worker,     │
      │                        │   kind='chat',           │
      │                        │   sender='agent:pr-admin'│
      │                        │ )                        │
      │                        │                          │
      │                        │ wakeContainer(pr-worker) │
      │                        │─────────────────────────▶│
      │                        │                          │ poll + traitement
      │                        │                          │ sender='agent:pr-admin'
      │                        │◀──── messages_out ───────│
      │                        │ livraison → pr-admin      │
      │◀────── réponse ─────────│                          │
```

Les ACL sont vérifiées via `agent_destinations` — l'agent A doit avoir `pr-worker` dans ses destinations pour pouvoir lui envoyer un message.

---

## 4. Self-modification (admin approval)

Flux pour `install_packages` (identique pour `add_mcp_server` et `request_rebuild`) :

```
Agent                 Host                  Admin
  │                     │                     │
  │ install_packages(   │                     │
  │   apt=['ffmpeg'],   │                     │
  │   npm=['sharp@0.33']│                     │
  │ )                   │                     │
  │ → messages_out      │                     │
  │   action=           │                     │
  │   'install_packages'│                     │
  │                     │                     │
  │                     │ requestApproval()   │
  │                     │ pending_approvals   │
  │                     │ carte → DM admin    │
  │                     │────────────────────▶│
  │                     │                     │ [ Approuver ]
  │                     │◀────────────────────│
  │                     │                     │
  │                     │ updateContainerConfig()
  │                     │ → container.json    │
  │                     │   apt/npm packages  │
  │                     │                     │
  │                     │ buildAgentGroupImage()
  │                     │ → docker build       │
  │                     │   avec nouveaux pkgs │
  │                     │                     │
  │                     │ killContainer()     │
  │                     │ writeSystemMessage( │
  │                     │   "Rebuilt, verify" │
  │                     │ )                   │
  │                     │ wakeContainer()     │
  │◀── "Container       │                     │
  │    rebuilt"         │                     │
```

---

## 5. Destinations et routing ciblé

```
Configuration (central DB agent_destinations) :
  agent_group_id='assistant'
  local_name='equipe-dev'    → channel_type='slack', platform_id='C123', thread_id=null
  local_name='alice'         → channel_type='telegram', platform_id='U456'
  local_name='worker'        → target_type='agent', target_id='pr-worker'

Au wake du container :
  writeDestinations(sessionId, agentGroupId)
  → copie dans inbound.db destinations (projection)

L'agent appelle :
  send_message(to="equipe-dev", text="Déploiement terminé")
  
MCP tool :
  destinations.find('equipe-dev')
  → { channel_type:'slack', platform_id:'C123' }
  → messages_out avec ces routing fields

Host delivery :
  → adapter slack.deliver('C123', null, message)
```

---

## 6. Isolation des sessions

Trois niveaux d'isolation disponibles dans `messaging_group_agents.session_mode` :

```
agent-shared :
  Toutes les conversations de tous les canaux partagent
  un seul contexte Claude (une session).
  Usage : agent "oracle" unique qui doit avoir mémoire globale.

  Discord#general ─┐
  Telegram chat   ─┼──▶ session unique (agent-shared)
  Slack #random   ─┘

shared :
  Une session par conversation (messaging_group).
  Usage : agent spécialisé par canal.

  Discord#general ──▶ session A
  Telegram chat   ──▶ session B

per-thread :
  Une session par thread dans la conversation.
  Usage : support ou ticketing avec contexte isolé.

  Discord#general/thread-1 ──▶ session A
  Discord#general/thread-2 ──▶ session B
  Discord#general/thread-3 ──▶ session C
```
