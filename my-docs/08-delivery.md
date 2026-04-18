# Système de livraison

## Deux boucles de poll

```
                HOST PROCESS
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
  Active Poll (1s)           Sweep Poll (60s)
  sessions running           toutes sessions actives
        │                         │
        └────────────┬────────────┘
                     │
                     ▼
          deliverSessionMessages(sessionId)
                     │
                     ▼
          messages_out WHERE delivered=0
               AND deliver_after <= now()
                     │
                for each row
                     │
          ┌──────────▼──────────────┐
          │  inflightDeliveries Set │  ← guard double-delivery
          │  add(sessionId)         │
          └──────────┬──────────────┘
                     │
                     ▼
          deliveryAdapter.deliver()
                     │
            ┌────────┴──────────┐
            │                   │
            ▼                   ▼
      normal send          operation type ?
      adapter.deliver()    ├── edit_message
                           │   → adapter.editMessage(platform_msg_id)
                           ├── add_reaction
                           │   → adapter.addReaction(platform_msg_id)
                           └── card / system action
                               → host handles directly
                     │
                     ▼
          markDelivered(seq, platform_message_id)
          → inbound.db delivered table
                     │
                     ▼
          resetIdleTimer(sessionId)
          inflightDeliveries.delete(sessionId)
```

---

## Livraison de fichiers

```
Agent : send_file(path="rapport.pdf")
  → MCP tool : copie fichier dans /workspace/outbox/<msg_id>/rapport.pdf
  → messages_out : { kind:'file', files:['rapport.pdf'], ... }

Host delivery :
  → lit outbox/<msg_id>/rapport.pdf depuis le dossier session
  → crée FileUpload (Chat SDK) ou appelle upload API natif
  → envoie via adapter
  → nettoie le dossier outbox/<msg_id>/
```

---

## Typing indicator

```
wakeContainer()
  → startTypingRefresh(sessionId, channelType, platformId, threadId)
  
  loop toutes les ~3s :
    heartbeatAge = now - mtime(.heartbeat)
    si heartbeatAge < STALE_THRESHOLD :
      adapter.setTyping(platformId, threadId)
    sinon :
      stop le refresh
  
killContainer()
  → stopTypingRefresh(sessionId)
```

Le typing indicator n'est affiché que si le container est vivant (heartbeat frais). Si le container crashe, le typing s'arrête automatiquement.

---

## Flux d'approbation (`delivery.ts:requestApproval()`)

Déclenché quand l'agent appelle `install_packages`, `add_mcp_server`, ou `request_rebuild`.

```
messages_out : { kind:'system', action:'install_packages', payload:{...} }
                     │
                     ▼
          requestApproval(sessionId, action, payload)
                     │
                     ▼
          pickApprover() :
            1. admins scopés à cet agent_group
            2. admins globaux
            3. owners
            tie-break : préférer même channel_type que l'origin
                     │
                     ▼
          ensureUserDm(approver) :
            → cache user_dms (central DB)
            → adapter.openDm(userHandle) si cache miss
                     │
                     ▼
          pending_approvals.insert({
            approval_id, session_id, action, payload, status='pending'
          })
                     │
                     ▼
          deliver carte approbation → DM de l'admin
          ┌──────────────────────────────────────┐
          │  🔧 Demande d'installation           │
          │                                      │
          │  L'agent demande d'installer :       │
          │  apt: ffmpeg                         │
          │  npm: sharp@0.33.0                   │
          │                                      │
          │  [ Approuver ]  [ Rejeter ]          │
          └──────────────────────────────────────┘
                     │
          admin clique
                     │
                     ▼
          handleApprovalResponse(approvalId, decision)
            si 'approved' :
              updateContainerConfig(agentGroupId, ...)
              buildAgentGroupImage()     ← rebuild Docker image
              killContainer(sessionId)
              writeSystemMessage("Container rebuilt, verify packages")
              → réveille le container sur la nouvelle image
            si 'rejected' :
              writeSystemMessage("Request rejected by admin")
            
          pending_approvals.delete(approvalId)
```

---

## Host Sweep (`src/host-sweep.ts`, toutes les 60s)

```
sweepAllSessions()
  │
  ├── syncProcessingAcks()
  │     → lit processing_ack depuis outbound.db
  │     → met à jour messages_in.status dans inbound.db
  │
  ├── detectStaleContainers()
  │     → heartbeat > 10min + messages 'processing'
  │     → reset + backoff exponentiel
  │
  ├── wakeForDueMessages()
  │     → sessions stopped avec messages process_after <= now
  │     → wakeContainer()
  │
  └── handleRecurrence()
        → messages_in completed avec recurrence != null
        → next = cronParser.next(recurrence, from=process_after)
        → insert nouveau messages_in avec process_after=next
        → NB: calculé depuis le schedule prévu, pas le wall-clock
          (évite le drift si le sweep est en retard)
```

---

## Livraison schedulée

```
Agent : schedule_task("Rapport hebdo", processAfter="2024-01-22 09:00", 
                       recurrence="0 9 * * 1")
  
  MCP tool : messages_in.insert({
    kind='task',
    process_after='2024-01-22 09:00',
    recurrence='0 9 * * 1',
    status='pending'
  })

  Host sweep (60s) :
    → trouve messages_in WHERE process_after <= now AND status='pending'
    → wakeContainer() → agent traite la tâche
    → markCompleted()
    → si recurrence : insert prochain occurrence
```
