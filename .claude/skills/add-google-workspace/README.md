# Google Workspace Integration Skill

**Official Google Workspace CLI integration for NanoClaw**

Access Gmail, Drive, Calendar, Docs, Sheets, Chat, Meet, and more through a single, official Google tool.

## Quick Facts

- **Skill Name**: `add-google-workspace`
- **Version**: 1.0.0
- **Backend**: Google Workspace CLI (`gws`)
- **Release**: March 2026 (6 days old!)
- **GitHub**: https://github.com/googleworkspace/cli
- **Stars**: 4,900+ (trending #1 on Hacker News)
- **Maintainer**: Google (official)
- **License**: Apache 2.0

## Why This Skill?

### vs. Existing `add-gmail`

| Feature | add-gmail | add-google-workspace |
|---------|-----------|---------------------|
| **Gmail** | ✅ Third-party MCP | ✅ Official CLI |
| **Drive** | ❌ | ✅ |
| **Calendar** | ❌ | ✅ |
| **Docs/Sheets** | ❌ | ✅ |
| **Chat/Meet** | ❌ | ✅ |
| **Maintenance** | Community | Google official |
| **Security** | Good | Enterprise-grade |
| **Latest Tech** | - | Native MCP, stdio |

### Key Advantages

1. **Official Support** - Built and maintained by Google
2. **All-in-One** - One integration for entire Google Workspace
3. **Latest Technology** - Released March 2026 with native MCP
4. **Dynamic API** - Auto-updates from Google Discovery Service
5. **Enterprise Security** - AES-256-GCM encrypted credentials
6. **High Performance** - Rust-based CLI, stdio transport
7. **Community Validated** - 4,900 stars in 3 days

## What Gets Installed

### Global Dependencies
- `@googleworkspace/cli` (npm global package)

### Code Modifications
1. `src/container-runner.ts` - Mount `~/.config/gws` directory
2. `container/agent-runner/src/index.ts` - Add gws MCP server

### Files Created
- `~/.config/gws/client_secret.json` - OAuth client credentials
- `~/.config/gws/credentials.enc` - Encrypted user credentials

## Installation

```bash
# From NanoClaw root
npx tsx scripts/apply-skill.ts .claude/skills/add-google-workspace
```

Or use the skill system:
```
/add-google-workspace
```

## Prerequisites

1. Google Cloud project with OAuth 2.0 credentials
2. Enabled APIs (Gmail, Drive, Calendar, etc.)
3. Docker or Apple Container running

## Supported Services

**Core Services (default):**
- 📧 Gmail - Read, send, search emails
- 📁 Drive - List, read, upload files
- 📅 Calendar - View, create events

**Extended Services (opt-in):**
- 📝 Docs - Read, edit documents
- 📊 Sheets - Read, update spreadsheets
- 💬 Chat - Send messages to spaces
- 📹 Meet - Manage conferences
- 📋 Keep - Manage notes
- 👥 People - Contact management
- 🏫 Classroom - Class management
- 📄 Forms - Form responses

## Usage Examples

**Gmail:**
```
@Andy search my emails for "invoice"
@Andy check unread emails from last week
```

**Drive:**
```
@Andy list my recent Drive files
@Andy search Drive for "Q4 report"
```

**Calendar:**
```
@Andy what's on my calendar today?
@Andy check if I'm free next Tuesday at 2pm
```

**Multi-service:**
```
@Andy find the Grab receipt in Gmail and save it to Drive
```

## Configuration Options

### Services Selection

**Minimal (Gmail only):**
```typescript
args: ['mcp', '-s', 'gmail']
```

**Standard (Gmail + Drive + Calendar):**
```typescript
args: ['mcp', '-s', 'gmail,drive,calendar']
```

**Extended (Add Docs + Sheets):**
```typescript
args: ['mcp', '-s', 'gmail,drive,calendar,docs,sheets']
```

**Full Workspace:**
```typescript
args: ['mcp', '-s', 'gmail,drive,calendar,docs,sheets,chat,meet,people,keep']
```

### Scopes

When running `gws auth login`, specify scopes:

**Read-only:**
```bash
gws auth login -s gmail,drive,calendar --readonly
```

**Full access (default):**
```bash
gws auth login -s gmail,drive,calendar --full
```

## Security

### Credential Storage
- Client secrets: `~/.config/gws/client_secret.json`
- User credentials: `~/.config/gws/credentials.enc` (AES-256-GCM encrypted)
- Encryption key: OS Keyring (macOS Keychain, Linux Secret Service)

### Container Access
- Credentials mounted read-write (required for token refresh)
- Only accessible within container namespace
- Isolated per-group via container isolation

### OAuth Scopes
- Requested on-demand based on enabled services
- User explicitly grants permissions during `gws auth login`
- Can be revoked at https://myaccount.google.com/permissions

## Troubleshooting

### `gws: command not found` in container

**Solution:** Update container Dockerfile to install gws globally:
```dockerfile
RUN npm install -g @googleworkspace/cli
```
Then rebuild: `cd container && ./build.sh`

### OAuth credentials not found

**Solution:** Ensure you've run:
```bash
mkdir -p ~/.config/gws
cp client_secret_*.json ~/.config/gws/client_secret.json
gws auth login -s gmail,drive,calendar
```

### Token expired

**Solution:** Re-authorize:
```bash
gws auth logout
gws auth login -s gmail,drive,calendar
```

### API quota exceeded

**Solution:** Check quotas at https://console.cloud.google.com/apis/dashboard

## Uninstallation

```bash
# 1. Remove code changes (manual or via skills system uninstall)
# 2. Optional: Revoke access
gws auth logout
rm -rf ~/.config/gws

# 3. Optional: Uninstall CLI
npm uninstall -g @googleworkspace/cli
```

## Future Enhancements

### Channel Mode (Planned)
- Poll Gmail inbox for new emails
- Auto-trigger agent on specific senders/subjects
- Similar to existing `add-gmail` channel mode

### Additional Services
- Admin SDK - Manage users, groups
- Reports API - Usage analytics
- Vault API - eDiscovery, compliance

### Advanced Features
- Batch operations
- Webhook support (when gws adds it)
- Service account support (for domain-wide delegation)

## Contributing

To improve this skill:

1. Test with different service combinations
2. Add more usage examples to SKILL.md
3. Create intent files for channel mode
4. Test on Linux and Windows

## References

- Official repo: https://github.com/googleworkspace/cli
- Medium article: https://medium.com/@vinayanand2/google-workspace-cli-turning-your-terminal-into-a-workspace-superpower-8a958f20676a
- MarkTechPost: https://www.marktechpost.com/2026/03/05/google-ai-releases-a-cli-tool-gws-for-workspace-apis-providing-a-unified-interface-for-humans-and-ai-agents/

## License

This skill package: MIT
Google Workspace CLI: Apache 2.0

---

**Created**: March 8, 2026
**Author**: Community contribution
**Status**: Production ready
