# Jarvis Implementation Plan

## Overview

This document provides the detailed implementation plan for transforming NanoClaw into Jarvis. The work is organized into 5 phases, each with specific tasks, deliverables, and verification steps.

## Development Workflow

### PR-Based Development Process

**All implementation must follow this workflow:**

1. **Implementation Agent** works on a task
2. **Code Review Agent** reviews the implementation
3. Agent addresses review feedback and submits a **Pull Request**
4. **PR Supervisor Agent** monitors the PR:
   - Waits for all status checks to pass
   - Waits for GitHub Copilot code review (up to 10 minutes)
   - If Copilot has feedback:
     - Delegates back to implementation agent
     - Agent must address each comment:
       - Fix the issue, OR
       - Mark as "not applicable" with reason, OR
       - Defer to later (create GitHub issue, link in comment)
   - Verifies ALL Copilot feedback has responses
   - Handles merge conflicts (delegates back to implementer if needed)
   - Only lands PR when:
     - ✅ All status checks pass
     - ✅ All Copilot feedback addressed comment-by-comment
     - ✅ No merge conflicts

**CRITICAL**: Do NOT land any PR without completed Copilot code reviews and responses to all feedback.

## Phase 1: Foundation (Week 1)

**Goal**: Add new infrastructure without breaking existing functionality. All changes are additive.

### Task 1.1: Add Type Definitions

**File**: `src/types.ts`

**Changes**:
```typescript
// Add new types
export type UserTier = 'owner' | 'family' | 'friend' | 'stranger';
export type ContextTier = 'owner' | 'family' | 'friend';

// Enhance existing interface
export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  contextTier?: ContextTier;  // NEW
  containerConfig?: ContainerConfig;
}

// Add new interfaces
export interface UserInfo {
  jid: string;
  name: string;
  addedAt: string;
  addedBy?: string;
}

export interface UserRegistry {
  owner: UserInfo;
  family: UserInfo[];
  friends: UserInfo[];
}

export interface VaultSettings {
  path: string;
  enabled: boolean;
}

export interface VaultConfig {
  mainVault?: VaultSettings;
  privateVault?: VaultSettings;
}

export interface EmailUser {
  tier: UserTier;
  name: string;
}

export interface EmailRegistry {
  users: Record<string, EmailUser>;
  settings: {
    allowUnknownSenders: boolean;
  };
}

export interface EmailConfig {
  provider: string;
  email: string;
  imap: {
    host: string;
    port: number;
    tls: boolean;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
  };
}

export interface AuthorizationResult {
  tier: UserTier;
  canInvoke: boolean;
  reason?: string;
}

export interface GroupParticipant {
  jid: string;
  tier: UserTier;
}
```

**Verification**:
- TypeScript compiles without errors
- No breaking changes to existing code
- All new types properly exported

**PR**: `feat: add type definitions for jarvis transformation`

---

### Task 1.2: Create User Registry System

**File**: `src/user-registry.ts` (NEW)

**Functions**:
- `loadUserRegistry()` - Load from `data/users.json`
- `saveUserRegistry(registry)` - Save to disk
- `getUserTier(jid)` - Get tier for user (returns 'stranger' if not found)
- `initializeOwner(jid, name)` - Set owner during first setup
- `addUser(jid, name, tier, addedBy)` - Add family/friend user
- `removeUser(jid)` - Remove user (cannot remove owner)
- `getUsersByTier(tier)` - Get all users in specific tier
- `getUserInfo(jid)` - Get user details

**File**: `data/users.json` (NEW)

```json
{
  "owner": {
    "jid": "",
    "name": "",
    "addedAt": ""
  },
  "family": [],
  "friends": []
}
```

**Implementation Notes**:
- JID normalization (handle `:lid` suffix)
- Proper error handling and logging
- Owner cannot be removed
- Atomic file operations

**Verification**:
- Can load/save user registry
- `getUserTier()` returns correct tier
- Owner initialization works
- Cannot remove owner

**PR**: `feat: add user registry system`

---

### Task 1.3: Create Authorization Module

**File**: `src/authorization.ts` (NEW)

**Functions**:

1. `canInvoke(senderJid, isGroupChat): AuthorizationResult`
   - Owner/Family → can invoke
   - Friend → cannot invoke (passive only)
   - Stranger → cannot invoke

2. `hasStrangers(groupJid, participants, forceRefresh): boolean`
   - Check all participants against user registry
   - In-memory cache with 5-minute TTL
   - Return true if any participant is stranger

3. `determineAgentContext(senderTier, groupContextTier): ContextTier`
   - Route to owner/family/friend context
   - Use group's explicit tier if configured
   - Otherwise infer from sender tier

4. `getParticipantTiers(participants): GroupParticipant[]`
   - Get tier for each participant

5. `clearStrangerCache(groupJid?): void`
   - Clear cache for specific group or all

**Implementation Notes**:
- Use Map for in-memory cache
- Cache key: group JID
- Cache value: `{ hasStrangers, lastChecked, participants }`
- TTL: 5 minutes (300000ms)
- Log all authorization decisions

**Verification**:
- Owner/Family can invoke
- Friends cannot invoke
- Strangers detected correctly
- Cache works and expires

**PR**: `feat: add authorization module with stranger detection`

---

### Task 1.4: Database Migrations

**File**: `src/db.ts`

**Changes to `initDatabase()`**:

```typescript
// Add sender_tier column (migration)
try {
  db.exec(`ALTER TABLE messages ADD COLUMN sender_tier TEXT`);
} catch {
  /* column already exists */
}

// Create group_participants table
db.exec(`
  CREATE TABLE IF NOT EXISTS group_participants (
    group_jid TEXT NOT NULL,
    user_jid TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    PRIMARY KEY (group_jid, user_jid)
  );
  CREATE INDEX IF NOT EXISTS idx_group_participants_group
    ON group_participants(group_jid);
  CREATE INDEX IF NOT EXISTS idx_group_participants_user
    ON group_participants(user_jid);
`);

// Create stranger_detection_cache table
db.exec(`
  CREATE TABLE IF NOT EXISTS stranger_detection_cache (
    group_jid TEXT PRIMARY KEY,
    has_strangers INTEGER NOT NULL,
    last_checked TEXT NOT NULL,
    participant_snapshot TEXT NOT NULL
  );
`);

// Create email tables
db.exec(`
  CREATE TABLE IF NOT EXISTS email_messages (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    user_tier TEXT,
    session_key TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_email_thread
    ON email_messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_email_received
    ON email_messages(received_at);

  CREATE TABLE IF NOT EXISTS email_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    in_reply_to TEXT,
    thread_id TEXT,
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    smtp_message_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_email_sent_thread
    ON email_sent(thread_id);
`);
```

**New Functions** (add at end of file):

```typescript
export function updateGroupParticipants(
  groupJid: string,
  participants: string[],
): void

export function getGroupParticipants(groupJid: string): string[]

export function getStrangerCache(groupJid: string): {
  has_strangers: number;
  last_checked: string;
  participant_snapshot: string;
} | null

export function setStrangerCache(
  groupJid: string,
  hasStrangers: boolean,
  participants: string[],
): void

export function clearStrangerCacheForGroup(groupJid: string): void
```

**Verification**:
- Database migrations run successfully
- All tables created with proper indexes
- Helper functions work correctly
- Existing data preserved

**PR**: `feat: add database schema for jarvis authorization`

---

### Task 1.5: Vault Configuration

**File**: `src/config.ts`

**Changes**:

```typescript
import { VaultConfig } from './types.js';
import { loadJson } from './utils.js';

// Add constants
export const VAULT_CONFIG_PATH = path.join(DATA_DIR, 'vault-config.json');

// Add functions
export function loadVaultConfig(): VaultConfig {
  return loadJson<VaultConfig>(VAULT_CONFIG_PATH, {});
}

export function expandPath(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return path.join(HOME_DIR, filepath.slice(2));
  }
  return filepath;
}
```

**File**: `data/vault-config.json` (NEW)

```json
{
  "mainVault": {
    "path": "~/Documents/Obsidian/Main",
    "enabled": false
  },
  "privateVault": {
    "path": "~/Documents/Obsidian/Private",
    "enabled": false
  }
}
```

**Verification**:
- Can load vault config
- Path expansion works (~ → home directory)
- Vaults disabled by default

**PR**: `feat: add vault configuration system`

---

### Task 1.6: Install Email Dependencies

**File**: `package.json`

**Dependencies to add**:
```json
"dependencies": {
  "nodemailer": "^6.9.16",
  "imap": "^0.8.19",
  "mailparser": "^3.7.1",
  "html-to-text": "^9.0.5"
}
```

**DevDependencies to add**:
```json
"devDependencies": {
  "@types/nodemailer": "^6.4.16",
  "@types/imap": "^0.8.40",
  "@types/mailparser": "^3.4.4",
  "@types/html-to-text": "^9.0.4"
}
```

**File**: `data/email_users.json` (NEW)

```json
{
  "users": {},
  "settings": {
    "allowUnknownSenders": false
  }
}
```

**Steps**:
1. Edit package.json
2. Run `npm install`
3. Create email_users.json
4. Commit package.json AND package-lock.json

**Verification**:
- All packages install successfully
- TypeScript recognizes new types
- No version conflicts

**PR**: `feat: add email dependencies for jarvis`

---

### Phase 1 Verification

**Integration Test**:
```bash
npm run typecheck  # Must pass
npm run build      # Must succeed
```

**Manual Verification**:
- [ ] All new files created
- [ ] No breaking changes to existing code
- [ ] Database migrations run successfully
- [ ] All PRs have Copilot reviews completed
- [ ] All status checks pass

---

## Phase 2: Authorization Integration (Week 2)

See full details in JARVIS_DESIGN.md and the original plan.

---

## Phase 3: Context & Vault Integration (Week 3)

See full details in JARVIS_DESIGN.md and the original plan.

---

## Phase 4: Email Integration (Week 4)

See full details in JARVIS_DESIGN.MD and the original plan.

---

## Phase 5: Testing & Cutover (Week 5)

See full details in JARVIS_DESIGN.md and the original plan.

---

**Document Version**: 1.0
**Last Updated**: 2026-02-05
**Status**: Plan finalized, ready for implementation
