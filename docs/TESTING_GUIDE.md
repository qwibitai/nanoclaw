# Jarvis Testing Guide

## Overview

This guide provides a comprehensive testing plan for the Jarvis transformation (Phases 1-3). We'll verify all core features work correctly before proceeding to Phase 4 (Email Integration).

## What We're Testing

**Phase 1 - Foundation:**
- User registry system
- Authorization module
- Database migrations
- Vault configuration

**Phase 2 - Authorization Integration:**
- Stranger detection
- Message routing with tier checks
- IPC privilege system

**Phase 3 - Context & Vault Integration:**
- Tier-based sessions
- Vault mounting by tier
- Context isolation

## Pre-Testing Setup

### 1. Initialize Owner User

First, we need to register you as the owner in the user registry.

**Get your WhatsApp JID:**
```bash
cd /Users/jarvis/workspace/nanoclaw
# Start the app in dev mode
npm run dev

# Look for a log line like:
# "Connected to WhatsApp" with your JID
# It will look like: 1234567890@s.whatsapp.net
```

**Initialize owner in users.json:**
```bash
# Edit data/users.json
cat > data/users.json <<EOF
{
  "owner": {
    "jid": "YOUR_JID_HERE@s.whatsapp.net",
    "name": "You",
    "addedAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  },
  "family": [],
  "friends": []
}
EOF
```

### 2. Configure Main Group as Owner Context

**Update registered_groups.json:**
```bash
# Edit data/registered_groups.json
# Find your main group and add:
{
  "your-main-group-jid@g.us": {
    "name": "Main Group",
    "folder": "main",
    "trigger": "@Jarvis",
    "added_at": "...",
    "contextTier": "owner"  // <-- Add this line
  }
}
```

### 3. Optional: Configure Vaults

If you want to test vault mounting:

**Create vault directories:**
```bash
mkdir -p ~/Documents/Obsidian/Main
mkdir -p ~/Documents/Obsidian/Private

# Create some test files
echo "# Main Vault Test" > ~/Documents/Obsidian/Main/test.md
echo "# Private Vault Test" > ~/Documents/Obsidian/Private/test.md
```

**Enable vaults in configuration:**
```bash
# Edit data/vault-config.json
cat > data/vault-config.json <<EOF
{
  "mainVault": {
    "path": "~/Documents/Obsidian/Main",
    "enabled": true
  },
  "privateVault": {
    "path": "~/Documents/Obsidian/Private",
    "enabled": true
  }
}
EOF
```

**Add to mount allowlist:**
```bash
mkdir -p ~/.config/nanoclaw

cat > ~/.config/nanoclaw/mount-allowlist.json <<EOF
{
  "allowedRoots": [
    {
      "path": "~/Documents/Obsidian/Main",
      "allowReadWrite": true,
      "description": "Main Obsidian vault (family)"
    },
    {
      "path": "~/Documents/Obsidian/Private",
      "allowReadWrite": true,
      "description": "Private Obsidian vault (owner)"
    }
  ],
  "blockedPatterns": [
    ".ssh",
    ".gnupg",
    ".aws",
    ".env",
    "credentials",
    ".secret",
    "id_rsa",
    "private_key"
  ],
  "nonMainReadOnly": false
}
EOF
```

### 4. Rebuild Container

After configuration changes, rebuild the agent container:
```bash
cd /Users/jarvis/workspace/nanoclaw
./container/build.sh
```

## Testing Checklist

### Test 1: Owner Direct Message (No Trigger)

**What to Test:**
- Owner can send DM without @Jarvis trigger
- Message is processed
- Agent responds

**Steps:**
1. Send a DM to Jarvis: "Hello, what's my user tier?"
2. Verify agent responds
3. Check logs for authorization decision

**Expected Behavior:**
```
Logger output:
- "Processing message" with senderTier: "owner"
- "Message from owner, processing without trigger required"
- Agent spawns in owner context
- Response sent
```

**Success Criteria:**
- ✅ Message processed without trigger
- ✅ Agent knows it's in owner context
- ✅ Response received

---

### Test 2: Owner in Group (With @Jarvis Trigger)

**What to Test:**
- Owner can invoke in main group with @Jarvis
- Context tier is "owner"
- Agent has access to both vaults (if enabled)

**Steps:**
1. In main group, send: "@Jarvis what context am I in?"
2. If vaults enabled, ask: "@Jarvis check if /workspace/vaults/private exists"
3. Check logs for context tier

**Expected Behavior:**
```
Logger output:
- "Processing message" with senderTier: "owner", contextTier: "owner"
- Agent spawned with owner context
- Vaults mounted (if enabled)
```

**Success Criteria:**
- ✅ Trigger required in group
- ✅ Context is "owner"
- ✅ Private vault accessible (if enabled)
- ✅ Main vault accessible (if enabled)

---

### Test 3: Add Family Member

**What to Test:**
- Owner can add family member via IPC
- Family member's tier is stored correctly

**Steps:**
1. Get family member's JID from WhatsApp
2. Send to Jarvis: "@Jarvis add user [JID] as family named Mom"
   - Note: This requires implementing the `add_user` IPC command handler
   - For now, manually edit `data/users.json`:

```json
{
  "owner": { ... },
  "family": [
    {
      "jid": "FAMILY_MEMBER_JID@s.whatsapp.net",
      "name": "Mom",
      "addedAt": "2026-02-05T...",
      "addedBy": "YOUR_JID@s.whatsapp.net"
    }
  ],
  "friends": []
}
```

3. Verify tier: Check logs when family member sends message

**Expected Behavior:**
- Family member's tier recognized as "family"
- Can invoke with @Jarvis in groups
- Cannot invoke in DMs without trigger (current implementation)

**Success Criteria:**
- ✅ Family member added to registry
- ✅ Tier correctly identified
- ✅ Authorization works

---

### Test 4: Family Member in Family Group

**What to Test:**
- Family member can invoke with @Jarvis
- Gets family context (not owner)
- Has access to main vault only (if enabled)

**Setup:**
1. Create a family group or configure existing group:
```json
{
  "family-group-jid@g.us": {
    "name": "Family Group",
    "folder": "family",
    "trigger": "@Jarvis",
    "added_at": "...",
    "contextTier": "family"
  }
}
```

**Steps:**
1. Family member sends: "@Jarvis what context am I in?"
2. If vaults enabled: "@Jarvis check if /workspace/vaults/private exists"
3. Check: "@Jarvis check if /workspace/vaults/main exists"

**Expected Behavior:**
```
Logger output:
- senderTier: "family"
- contextTier: "family"
- Main vault mounted: yes (if enabled)
- Private vault mounted: no
```

**Success Criteria:**
- ✅ Family member can invoke
- ✅ Context is "family" (NOT owner)
- ✅ Main vault accessible (if enabled)
- ✅ Private vault NOT accessible

---

### Test 5: Add Friend (Passive Context)

**What to Test:**
- Friend tier recognized
- Friend CANNOT invoke Jarvis
- Friend messages stored as passive context

**Setup:**
```json
{
  "owner": { ... },
  "family": [ ... ],
  "friends": [
    {
      "jid": "FRIEND_JID@s.whatsapp.net",
      "name": "John",
      "addedAt": "2026-02-05T...",
      "addedBy": "YOUR_JID@s.whatsapp.net"
    }
  ]
}
```

**Steps:**
1. Create friend group:
```json
{
  "friend-group-jid@g.us": {
    "name": "Friend Group",
    "folder": "friend-group",
    "trigger": "@Jarvis",
    "added_at": "...",
    "contextTier": "friend"
  }
}
```

2. Friend sends: "@Jarvis hello" (should be ignored)
3. Friend sends: "Just chatting" (should be stored as context)
4. Owner sends: "@Jarvis summarize what John said"

**Expected Behavior:**
```
Logger output (for friend's @Jarvis message):
- senderTier: "friend"
- canInvoke: false
- "User cannot invoke Jarvis" warning
- Message NOT processed

Logger output (for friend's normal message):
- "Storing friend message as passive context"
- Message stored in database with sender_tier: "friend"
```

**Success Criteria:**
- ✅ Friend cannot invoke Jarvis
- ✅ Friend messages stored as context
- ✅ Owner can reference friend messages

---

### Test 6: Stranger Danger

**What to Test:**
- Stranger in group blocks ALL messages
- Owner notified via DM
- Cache prevents repeated notifications

**Setup:**
1. Create test group with known participants
2. Add yourself (owner) and a friend
3. Do NOT add the third person to users.json (they're a stranger)

**Steps:**
1. Owner sends: "@Jarvis hello" in group with stranger
2. Check for owner DM notification
3. Send another message (should still be blocked)
4. Check logs for cache usage

**Expected Behavior:**
```
Logger output:
- "Strangers detected in group"
- Stranger JIDs logged
- Owner receives DM:
  "⚠️ Stranger detected in group [name]
   Unknown participants:
   - stranger-jid@s.whatsapp.net

   Messages from this group are being ignored."

- Subsequent messages use cache
```

**Success Criteria:**
- ✅ Messages from group ignored
- ✅ Owner notified once
- ✅ Cache prevents spam
- ✅ All participants logged

---

### Test 7: Session Isolation

**What to Test:**
- Owner session isolated from family
- Family session shared across family members
- Friend sessions per-group isolated

**Verification Method:**
Check session directories:
```bash
ls -la data/sessions/owner/.claude/
ls -la data/sessions/family/.claude/
ls -la data/sessions/friends/*/
```

**Steps:**
1. Send messages as owner in main group
2. Send messages as family in family group
3. Check that session files are in correct locations

**Expected Behavior:**
- Owner messages → `data/sessions/owner/.claude/`
- Family messages → `data/sessions/family/.claude/`
- Friend groups → `data/sessions/friends/{group}/.claude/`

**Success Criteria:**
- ✅ Sessions created in correct locations
- ✅ Owner session separate from family
- ✅ Family session shared
- ✅ Friend sessions isolated per group

---

### Test 8: Vault Mounting (If Enabled)

**What to Test:**
- Owner sees both vaults
- Family sees main vault only
- Friends see no vaults

**Steps:**
1. As owner: "@Jarvis ls /workspace/vaults/"
   - Should see: `main/` and `private/`
2. As owner: "@Jarvis cat /workspace/vaults/private/test.md"
   - Should see content
3. As family: "@Jarvis ls /workspace/vaults/"
   - Should see: `main/` only
4. As family: "@Jarvis cat /workspace/vaults/private/test.md"
   - Should fail (directory doesn't exist)
5. As friend: "@Jarvis ls /workspace/vaults/"
   - Cannot invoke (passive only)

**Expected Behavior:**
- Owner container has both vault mounts
- Family container has main vault mount only
- Friend container has no vault mounts

**Success Criteria:**
- ✅ Owner accesses both vaults
- ✅ Family accesses main vault
- ✅ Family CANNOT access private vault
- ✅ Friends have no vault access

---

### Test 9: IPC Privilege Checks

**What to Test:**
- Owner can use all IPC commands
- Family has limited IPC access
- Friends cannot use IPC

**Commands to Test:**
- `list_users` - Owner/Family can use
- `add_user` - Owner only
- `remove_user` - Owner only
- `register_group` - Owner only
- `schedule_task` - Owner/Family can use

**Note:** Many IPC commands may not have full implementations yet. Focus on verifying privilege checks work.

**Expected Behavior:**
```
Owner → list_users: SUCCESS
Family → list_users: SUCCESS
Friend → list_users: BLOCKED

Owner → add_user: SUCCESS
Family → add_user: BLOCKED
```

**Success Criteria:**
- ✅ Privilege checks enforced
- ✅ Owner has full access
- ✅ Family limited access
- ✅ Friends blocked

---

### Test 10: Database Migrations

**What to Test:**
- All new tables created
- sender_tier column exists
- Data stored correctly

**Verification:**
```bash
sqlite3 store/messages.db

# Check tables exist
.tables
# Should show: group_participants, stranger_detection_cache, email_messages, email_sent

# Check sender_tier column
.schema messages
# Should show: sender_tier TEXT column

# Check data
SELECT sender, sender_tier FROM messages WHERE sender_tier IS NOT NULL LIMIT 5;
```

**Success Criteria:**
- ✅ All tables exist
- ✅ sender_tier column present
- ✅ Data being stored with tiers

---

## Common Issues & Troubleshooting

### Issue: "Permission denied" errors

**Cause:** Mount allowlist not configured or paths not readable

**Fix:**
1. Check `~/.config/nanoclaw/mount-allowlist.json` exists
2. Verify vault paths exist and are readable
3. Check container logs for mount errors

### Issue: Messages not processed

**Possible Causes:**
1. User not in registry → Check `data/users.json`
2. Group not registered → Check `data/registered_groups.json`
3. Stranger in group → Check logs for stranger detection
4. Missing trigger in group → Add @Jarvis prefix

**Debug:**
```bash
# Check logs
tail -f logs/nanoclaw.log

# Look for authorization decisions
grep "canInvoke" logs/nanoclaw.log
grep "senderTier" logs/nanoclaw.log
```

### Issue: Vault not accessible

**Possible Causes:**
1. Vault not enabled in `data/vault-config.json`
2. Path not in mount allowlist
3. Path doesn't exist
4. Wrong context tier (family accessing private vault)

**Debug:**
```bash
# Check vault config
cat data/vault-config.json

# Check mount allowlist
cat ~/.config/nanoclaw/mount-allowlist.json

# Check if paths exist
ls ~/Documents/Obsidian/Main
ls ~/Documents/Obsidian/Private
```

### Issue: Session in wrong directory

**Cause:** contextTier not set in registered_groups.json

**Fix:**
Add `"contextTier": "owner"` or `"contextTier": "family"` to group config

### Issue: Stranger detection not working

**Possible Causes:**
1. Cache using stale data
2. JID normalization issues
3. Group metadata fetch failing

**Debug:**
```bash
# Check stranger cache
sqlite3 store/messages.db "SELECT * FROM stranger_detection_cache;"

# Clear cache
sqlite3 store/messages.db "DELETE FROM stranger_detection_cache;"
```

---

## Logging & Debugging

### Enable Debug Logging

Jarvis uses `pino` logger. Logs are in `logs/nanoclaw.log`.

**Watch logs in real-time:**
```bash
tail -f logs/nanoclaw.log | pino-pretty
```

**Useful log searches:**
```bash
# Authorization decisions
grep "canInvoke" logs/nanoclaw.log

# Stranger detection
grep "Strangers detected" logs/nanoclaw.log

# Context tier routing
grep "contextTier" logs/nanoclaw.log

# Vault mounting
grep "vault" logs/nanoclaw.log

# Session paths
grep "session" logs/nanoclaw.log
```

---

## Test Results Template

Use this template to document your test results:

```markdown
# Jarvis Testing Results

**Date:** 2026-02-05
**Tester:** [Your Name]
**Build:** [git commit hash]

## Test 1: Owner Direct Message
- Status: ✅ PASS / ❌ FAIL
- Notes: [Any observations]

## Test 2: Owner in Group
- Status: ✅ PASS / ❌ FAIL
- Notes: [Any observations]

## Test 3: Add Family Member
- Status: ✅ PASS / ❌ FAIL
- Notes: [Any observations]

[Continue for all tests...]

## Issues Found
1. [Description of issue]
   - Severity: High/Medium/Low
   - Steps to reproduce
   - Expected vs Actual behavior

## Overall Assessment
- Core functionality: [Working/Broken]
- Security: [Concerns/Good]
- Ready for production: [Yes/No]
```

---

## Next Steps After Testing

Once testing is complete:

1. **Document Issues**: Create GitHub issues for any bugs found
2. **Fix Critical Bugs**: Address any security or data-loss issues
3. **Update Documentation**: Reflect actual behavior in docs
4. **Decision Point**:
   - Continue to Phase 4 (Email Integration)
   - OR address technical debt and optimize
   - OR deploy to production for real-world usage

---

**Happy Testing!** 🧪
