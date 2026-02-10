#!/bin/bash
set -e

echo "🧪 Jarvis Testing Setup"
echo "======================"
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Run this script from the nanoclaw root directory"
    exit 1
fi

echo "📋 Pre-Testing Checklist"
echo ""

# 1. Check WhatsApp authentication
echo "Step 1: WhatsApp Authentication"
echo "--------------------------------"
if [ ! -d "store/baileys_store_multi" ]; then
    echo "⚠️  No WhatsApp session found. You need to authenticate first."
    echo "   Run: npm run auth"
    echo ""
    read -p "Press Enter after authenticating, or Ctrl+C to exit..."
else
    echo "✅ WhatsApp session exists"
fi
echo ""

# 2. Get owner JID
echo "Step 2: Register Owner"
echo "----------------------"
OWNER_JID=$(cat data/users.json | grep '"jid"' | head -1 | cut -d'"' -f4)
if [ -z "$OWNER_JID" ]; then
    echo "⚠️  Owner JID not configured in data/users.json"
    echo ""
    echo "To find your JID:"
    echo "  1. Run: npm run dev"
    echo "  2. Look for log line: 'Connected to WhatsApp' with your JID"
    echo "  3. It looks like: 1234567890@s.whatsapp.net"
    echo ""
    read -p "Enter your WhatsApp JID: " USER_JID

    if [ -z "$USER_JID" ]; then
        echo "❌ JID required. Exiting."
        exit 1
    fi

    # Update users.json
    cat > data/users.json <<EOF
{
  "owner": {
    "jid": "$USER_JID",
    "name": "Owner",
    "addedAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  },
  "family": [],
  "friends": []
}
EOF
    echo "✅ Owner registered: $USER_JID"
else
    echo "✅ Owner already registered: $OWNER_JID"
fi
echo ""

# 3. Check for registered groups
echo "Step 3: Group Registration"
echo "--------------------------"
GROUP_COUNT=$(cat data/registered_groups.json | grep -c '"name"' || echo "0")
if [ "$GROUP_COUNT" -eq "0" ]; then
    echo "⚠️  No groups registered yet"
    echo "   Groups are registered when you first interact with Jarvis in them"
    echo "   Or manually add to data/registered_groups.json"
else
    echo "✅ $GROUP_COUNT group(s) registered"
fi
echo ""

# 4. Vault setup (optional)
echo "Step 4: Vault Configuration (Optional)"
echo "--------------------------------------"
read -p "Do you want to enable vault testing? (y/N): " ENABLE_VAULTS

if [[ "$ENABLE_VAULTS" =~ ^[Yy]$ ]]; then
    # Create vault directories
    MAIN_VAULT="$HOME/Documents/Obsidian/Main"
    PRIVATE_VAULT="$HOME/Documents/Obsidian/Private"

    mkdir -p "$MAIN_VAULT"
    mkdir -p "$PRIVATE_VAULT"

    # Create test files
    echo "# Main Vault Test" > "$MAIN_VAULT/test.md"
    echo "Created: $(date)" >> "$MAIN_VAULT/test.md"

    echo "# Private Vault Test" > "$PRIVATE_VAULT/test.md"
    echo "Created: $(date)" >> "$PRIVATE_VAULT/test.md"

    # Update vault config
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

    # Create mount allowlist
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

    echo "✅ Vaults created and configured:"
    echo "   Main: $MAIN_VAULT"
    echo "   Private: $PRIVATE_VAULT"
    echo "   Mount allowlist: ~/.config/nanoclaw/mount-allowlist.json"
else
    echo "⏭️  Skipping vault setup"
fi
echo ""

# 5. Container rebuild
echo "Step 5: Container Rebuild"
echo "-------------------------"
read -p "Rebuild agent container? (Y/n): " REBUILD

if [[ ! "$REBUILD" =~ ^[Nn]$ ]]; then
    echo "🔨 Building container..."
    ./container/build.sh
    echo "✅ Container rebuilt"
else
    echo "⏭️  Skipping container rebuild"
fi
echo ""

# 6. Database check
echo "Step 6: Database Initialization"
echo "--------------------------------"
if [ -f "store/messages.db" ]; then
    echo "✅ Database exists"

    # Check for new tables
    TABLES=$(sqlite3 store/messages.db ".tables" 2>/dev/null || echo "")
    if echo "$TABLES" | grep -q "group_participants"; then
        echo "✅ New Jarvis tables present"
    else
        echo "⚠️  Jarvis tables not found - will be created on first run"
    fi
else
    echo "⚠️  Database will be created on first run"
fi
echo ""

# Summary
echo "📊 Setup Summary"
echo "================"
echo ""
echo "Configuration Files:"
echo "  ✓ data/users.json (owner registered)"
echo "  ✓ data/registered_groups.json"
echo "  ✓ data/vault-config.json"
if [ -f ~/.config/nanoclaw/mount-allowlist.json ]; then
    echo "  ✓ ~/.config/nanoclaw/mount-allowlist.json"
fi
echo ""
echo "Next Steps:"
echo "  1. Start Jarvis: npm run dev"
echo "  2. Send a test message from WhatsApp"
echo "  3. Check logs: tail -f logs/nanoclaw.log | npx pino-pretty"
echo "  4. Follow testing guide: docs/TESTING_GUIDE.md"
echo ""
echo "🎉 Setup complete! Ready for testing."
