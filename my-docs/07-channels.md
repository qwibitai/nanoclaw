# Système d'adaptateurs de canaux

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │         Channel Registry                │
                    │   (src/channels/channel-registry.ts)    │
                    │                                         │
                    │  registerChannel(name, factory)         │
                    │  getChannelAdapter(channelType)         │
                    └───────────┬─────────────────────────────┘
                                │
             ┌──────────────────┼──────────────────────────┐
             │                  │                          │
             ▼                  ▼                          ▼
    ┌─────────────────┐ ┌──────────────────┐  ┌────────────────────┐
    │  Chat SDK Bridge │ │  Chat SDK Bridge  │  │  Native Adapter    │
    │  (Discord)       │ │  (Slack, Telegram │  │  (WhatsApp/Baileys) │
    │                  │ │   Linear, etc.)   │  │                    │
    │  ChannelAdapter  │ │  ChannelAdapter   │  │  ChannelAdapter    │
    └─────────────────┘ └──────────────────┘  └────────────────────┘
```

Les adaptateurs sont installés via des skills (`/add-discord`, `/add-slack`, etc.) depuis la branche `channels`. Trunk ne ship aucun adaptateur spécifique.

---

## Interface `ChannelAdapter`

```typescript
interface ChannelAdapter {
  name: string
  channelType: string           // 'telegram', 'discord', 'slack', ...
  supportsThreads: boolean      // Discord/Slack/Linear = true ; Telegram/WhatsApp = false

  setup(config: ChannelSetup): Promise<void>
  teardown(): Promise<void>
  isConnected(): boolean

  // Livraison
  deliver(
    platformId: string,
    threadId: string | null,
    message: OutboundMessage
  ): Promise<string | undefined>  // retourne platform_message_id si dispo

  // Optionnels
  setTyping?(platformId: string, threadId: string | null): Promise<void>
  syncConversations?(): Promise<ConversationInfo[]>
  updateConversations?(conversations: ConversationInfo[]): void
  openDm?(userHandle: string): Promise<string>  // handle → DM platformId
}
```

---

## `ChannelSetup` (config injectée au démarrage)

```typescript
interface ChannelSetup {
  onInbound(
    platformId: string,
    threadId: string | null,
    message: InboundMessage
  ): Promise<void>

  onAction(
    questionId: string,
    selectedOption: string,
    userId: string
  ): void

  getConversationConfigs(): ConversationConfig[]
}
```

---

## Message entrant (`InboundMessage`)

```typescript
interface InboundMessage {
  id: string
  kind: 'chat' | 'chat-sdk'
  content: unknown     // objet JS → JSON.stringify avant écriture DB
  timestamp: string    // ISO 8601
  sender?: {
    id: string         // platform-native ID
    name: string
  }
  attachments?: Attachment[]
}
```

---

## Message sortant (`OutboundMessage`)

```typescript
interface OutboundMessage {
  kind: string
  content: unknown     // JSON depuis messages_out
  files?: OutboundFile[]
}
```

---

## Chat SDK Bridge (`src/channels/bridge.ts`)

Pour les canaux utilisant le Chat SDK (Discord, Slack, Linear, GitHub, etc.) :

```
Événement Chat SDK
      │
      ▼
bridge.ts
  → déduplication (évite re-delivery des propres messages)
  → conversion Chat SDK event → InboundMessage
  → appel onInbound()
  
Livraison via bridge.ts :
  → adapter.postMessage() / editMessage() / addReaction()
  → retourne platform_message_id
```

---

## Enregistrement d'un adaptateur

Chaque skill `/add-<channel>` ajoute une ligne dans `src/channels/index.ts` :

```typescript
// src/channels/index.ts
import './adapters/discord'   // ← ajouté par /add-discord
import './adapters/telegram'  // ← ajouté par /add-telegram
// ...
```

Chaque fichier appelle `registerChannel()` à son import :

```typescript
// src/channels/adapters/discord.ts
registerChannel('discord', (config) => new DiscordAdapter(config))
```

---

## Channels supportés (branche `channels`)

| Channel | Skill | Threads | Transport |
|---------|-------|---------|-----------|
| Discord | `/add-discord` | oui | Chat SDK |
| Slack | `/add-slack` | oui | Chat SDK |
| Telegram | `/add-telegram` | non | Chat SDK |
| WhatsApp (Baileys) | `/add-whatsapp` | non | Natif |
| WhatsApp Cloud | `/add-whatsapp-cloud` | non | Chat SDK |
| Linear | `/add-linear` | oui | Chat SDK |
| GitHub | `/add-github` | oui | Chat SDK |
| iMessage | `/add-imessage` | non | Natif |
| Teams | `/add-teams` | oui | Chat SDK |
| Matrix | `/add-matrix` | oui | Chat SDK |
| Google Chat | `/add-gchat` | non | Chat SDK |
| Webex | `/add-webex` | non | Chat SDK |
| Resend (email) | `/add-resend` | non | Chat SDK |

---

## Canal `agent` (interne)

Pour la communication agent-to-agent, NanoClaw utilise un `channelType='agent'` virtuel qui ne passe pas par un adaptateur externe mais par le système de routing interne.

```
Agent A : send_to_agent(agentGroupId='worker', text='...')
  → messages_out : channel_type='agent', platform_id='worker'
  
Host delivery :
  → channelType='agent' → routing interne
  → résolution session pour l'agent cible
  → écriture dans inbound.db de la session cible
  → wake du container cible
```
