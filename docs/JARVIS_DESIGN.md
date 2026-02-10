# Jarvis: High-Level Design & Principles

## Executive Summary

Transform NanoClaw from a group-based linked-device assistant into **Jarvis**: a dedicated WhatsApp account personal assistant with 4-tier user authorization, unified context management, Obsidian vault integration, and email capabilities.

## Core Transformation

### Current: NanoClaw
- **WhatsApp Mode**: Linked device to user's WhatsApp account
- **Authorization**: Binary (Main group vs Non-main groups)
- **Context**: Per-group isolation with separate sessions
- **Memory**: CLAUDE.md files in group folders
- **Communication**: WhatsApp-only

### Target: Jarvis
- **WhatsApp Mode**: Dedicated WhatsApp account (separate phone number)
- **Authorization**: 4-tier user system (Owner/Family/Friends/Strangers)
- **Context**: Three context models (Owner dedicated, Family unified, Friend isolated)
- **Memory**: Obsidian vaults as primary memory (main + private)
- **Communication**: Multi-channel (WhatsApp + Email)

## Architecture Principles

### 1. Security-First Authorization

**4-Tier User System:**

1. **Owner** (You)
   - Full control and system access
   - Can modify Jarvis code and configuration
   - Access to private + main Obsidian vaults
   - Dedicated isolated agent context
   - Can manage all users, groups, and settings
   - No trigger required in DMs or groups

2. **Family**
   - Unified shared context across all family members
   - Read-write access to main Obsidian vault
   - Can use most features (scheduling, tools, etc.)
   - Require `@Jarvis` trigger in groups
   - No trigger required in DMs

3. **Friends**
   - **Passive context only** - cannot invoke Jarvis
   - Per-group isolation (existing NanoClaw model)
   - NO Obsidian vault access
   - Messages processed as context when Owner/Family invokes Jarvis
   - Provides context without security risk

4. **Strangers**
   - **Complete ignore** - "stranger danger"
   - If ANY stranger in thread → ignore EVERYTHING
   - No agent spawned, no processing
   - Security risk too high (prompt injection vulnerability)

**Key Principle: Stranger Danger**
- A single unknown participant in a group chat blocks ALL processing
- This prevents prompt injection attacks from untrusted parties
- Protection is at the message routing level, before any agent spawns

### 2. Context Management Strategy

**Three-Tier Session Structure:**

```
Owner Context (Dedicated)
├── Session: data/sessions/owner/.claude/
├── Access: Owner only
└── Isolation: Complete separation from other contexts

Family Context (Unified)
├── Session: data/sessions/family/.claude/
├── Access: All family members share this session
└── Shared History: Family can see each other's conversations

Friend Context (Per-Group Isolated)
├── Sessions: data/sessions/friends/{group}/.claude/
├── Access: Per friend group
└── Isolation: Each group has its own context
```

**Context Routing:**
- Direct messages from Owner → Owner context
- Direct messages from Family → Family context
- Group messages with Owner → Owner context (if group configured as owner)
- Group messages with Family → Family context (if group configured as family)
- Group messages with Friends → Friend context (when Owner/Family invokes)

### 3. Memory Architecture

**Dual Memory System: CLAUDE.md + Obsidian Vaults**

**CLAUDE.md Files** - Static system prompts
- Agent personality and configuration
- Available tools documentation
- Workspace structure information
- Per-group customization

**Obsidian Vaults** - Dynamic knowledge base
- Daily notes and conversation archives
- Person/relationship notes
- Project documentation and context
- Knowledge base and reference materials
- Search and retrieval during conversations

**Two Vault Types:**

1. **Main Vault** (Owner + Family)
   - Mounted at: `/workspace/vaults/main`
   - Access: Owner (read-write), Family (read-write)
   - Content: Shared family knowledge, schedules, notes
   - Trust level: High - family is trusted to write

2. **Private Vault** (Owner Only)
   - Mounted at: `/workspace/vaults/private`
   - Access: Owner only (read-write)
   - Content: Personal notes, work documents, sensitive info
   - Trust level: Highest - owner-only access

**Vault Structure Example:**
```
Main Vault (Family Shared):
  Daily/
    2026-02-05.md
  Family/
    members/mom.md
    events/vacation-2026.md
  Knowledge/
    recipes/pasta.md
    home/wifi-password.md

Private Vault (Owner):
  Daily/
    2026-02-05.md
  Work/
    projects/project-alpha.md
  People/
    colleagues/john-notes.md
  Finance/
    taxes-2026.md
```

### 4. Email Integration

**Email as Parallel Channel** - runs alongside WhatsApp

**Architecture:**
- IMAP checking loop (polls every 60 seconds)
- SMTP sending with nodemailer
- Thread-based context preservation
- Separate authorization from WhatsApp users

**Email User Authorization:**
```json
{
  "users": {
    "you@example.com": { "tier": "owner", "name": "You" },
    "family@example.com": { "tier": "family", "name": "Mom" }
  },
  "settings": {
    "allowUnknownSenders": false
  }
}
```

**Access Levels:**
- Owner: Can email Jarvis, full feature access
- Family: Can email Jarvis, most features
- Friend: Cannot email (or read-only if enabled)
- Stranger: Auto-rejected

**Security:**
- Credentials stored outside project: `~/.nanoclaw-email/`
- Whitelist-based authorization (default deny)
- Rate limiting: max 50 emails/hour
- HTML converted to plain text (never render)
- Attachments disabled by default (security risk)

### 5. Container Security Model

**Mount Access by Tier:**

```typescript
Owner Tier:
  - Project root: /workspace/project (read-write)
  - Private vault: /workspace/vaults/private (read-write)
  - Main vault: /workspace/vaults/main (read-write)
  - Group folder: /workspace/group (read-write)
  - Session: /home/node/.claude (data/sessions/owner/)

Family Tier:
  - Main vault: /workspace/vaults/main (read-write)
  - Group folder: /workspace/group (read-write)
  - Session: /home/node/.claude (data/sessions/family/)
  - NO project root access
  - NO private vault access

Friend Tier:
  - Group folder: /workspace/group (read-write)
  - Session: /home/node/.claude (data/sessions/friends/{group}/)
  - NO vault access
  - NO project root access
```

**Mount Allowlist** (`~/.config/nanoclaw/mount-allowlist.json`):
- Stored OUTSIDE project root (tamper-proof)
- Never mounted into containers
- Explicit whitelist of allowed roots
- Blocked patterns (`.ssh`, `.gnupg`, credentials)
- Enforced at container spawn time

### 6. Defense in Depth

**Three Authorization Boundaries:**

1. **Entry Point** (`processMessage()`)
   - Who can invoke Jarvis?
   - Stranger detection
   - Tier-based routing

2. **IPC Boundary** (`processTaskIpc()`)
   - What can the agent do?
   - Privilege-based command authorization
   - User management restrictions

3. **Mount Time** (`buildVolumeMounts()`)
   - What can the agent access?
   - Tier-based filesystem mounts
   - Allowlist enforcement

**Security Principles:**
- Default deny (whitelist-based)
- Least privilege by tier
- Multiple validation layers
- Fail secure (errors block action)

## Data Structures

### User Registry (`data/users.json`)

```json
{
  "owner": {
    "jid": "1234567890@s.whatsapp.net",
    "name": "You",
    "addedAt": "2026-02-05T10:00:00.000Z"
  },
  "family": [
    {
      "jid": "9876543210@s.whatsapp.net",
      "name": "Mom",
      "addedAt": "2026-02-05T10:05:00.000Z",
      "addedBy": "1234567890@s.whatsapp.net"
    }
  ],
  "friends": [
    {
      "jid": "5555555555@s.whatsapp.net",
      "name": "John",
      "addedAt": "2026-02-05T10:10:00.000Z",
      "addedBy": "1234567890@s.whatsapp.net"
    }
  ]
}
```

### Enhanced Registered Groups

```typescript
interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  contextTier: 'owner' | 'family' | 'friend';  // NEW
  containerConfig?: ContainerConfig;
}
```

### Session Storage (`data/sessions.json`)

```json
{
  "owner": "session-abc123...",
  "family": "session-def456...",
  "friends": {
    "friend-group-1": "session-xyz...",
    "friend-group-2": "session-uvw..."
  }
}
```

## Message Routing Algorithm

```
Message Received
  ↓
Is Group Chat?
  ├─ YES → Check all participants for strangers
  │         ├─ Stranger found? → IGNORE ENTIRE THREAD
  │         │                     └─> Notify owner via secure DM
  │         └─ No strangers → Continue
  │              ↓
  │         Has @Jarvis trigger?
  │              ├─ NO → Is sender Friend?
  │              │       ├─ YES → Store as passive context
  │              │       └─ NO → Process normally
  │              └─ YES → Is sender Owner or Family?
  │                     ├─ YES → PROCESS with appropriate context
  │                     └─ NO → IGNORE (friends can't invoke)
  │
  └─ NO (Direct Message)
        ↓
   Get sender's tier
        ↓
   Owner or Family? → PROCESS (no trigger needed)
   Friend/Stranger? → IGNORE
```

## Key Technical Decisions

### 1. Why Stranger Danger?
- Prompt injection is a real threat from untrusted users
- Groups with strangers are too risky to process
- Better to miss legitimate requests than expose the system
- Owner gets notified when strangers block processing

### 2. Why Unified Family Context?
- Families share information naturally
- Reduces friction (no explaining context repeatedly)
- Vault access enables collaborative note-taking
- Trust model: family members are trusted users

### 3. Why Friend Passive Context?
- Friends provide useful context without risk
- Owner/Family can reference friend messages
- No direct invocation = no prompt injection risk
- Existing per-group isolation preserved

### 4. Why Obsidian Vaults?
- Users already manage knowledge in Obsidian
- Rich markdown support with links and tags
- Local-first (privacy and control)
- Searchable by agent during conversations
- Integration > duplication

### 5. Why Email Integration?
- Not everyone uses WhatsApp
- Professional communication channel
- Thread-based context works well
- Separate authorization for security

## Migration Strategy

### Backward Compatibility

**Phase 1-2: Dual Authorization**
- Old group-based checks continue to work
- New tier-based checks run in parallel
- Log all authorization decisions
- No breaking changes

**Phase 3: Context Migration**
- Migrate `data/sessions/main/.claude/` → `data/sessions/owner/.claude/`
- Create `data/sessions/family/.claude/`
- Keep backup of old structure
- Support rollback if needed

**Phase 4: Email Opt-In**
- Email integration disabled by default
- Enable via environment variable
- No impact on existing WhatsApp functionality

**Phase 5: Cleanup**
- Remove legacy authorization code
- Finalize migration
- Update documentation

### Owner Registration Flow

1. During first run or `/setup`
2. Extract owner JID from WhatsApp connection metadata
3. Initialize `data/users.json` with owner entry
4. Create owner context directory
5. Prompt owner to classify existing groups

## Success Criteria

The transformation is complete when:

1. ✅ Jarvis runs on dedicated WhatsApp account (not linked device)
2. ✅ 4-tier authorization system operational
3. ✅ Stranger danger blocks unknown users in groups
4. ✅ Owner has dedicated context + both vaults mounted
5. ✅ Family has unified context + main vault access
6. ✅ Friends provide passive context only (cannot invoke)
7. ✅ Email integration functional (IMAP/SMTP)
8. ✅ All tests passing
9. ✅ Documentation complete and up-to-date
10. ✅ Production-ready and stable for daily use

## Future Considerations

### Potential Enhancements

- **Voice Messages**: Transcription via Whisper API
- **Multi-Device**: Owner on multiple devices (session sync)
- **Telegram/Slack**: Additional communication channels
- **Advanced Scheduling**: Recurring context-aware tasks
- **Vault Sync**: Auto-sync with Obsidian on edits

### Non-Goals

- Not a chatbot for public use
- Not a group admin bot
- Not a business automation platform
- Personal assistant only

---

**Document Version**: 1.0
**Last Updated**: 2026-02-05
**Status**: Design finalized, implementation pending
