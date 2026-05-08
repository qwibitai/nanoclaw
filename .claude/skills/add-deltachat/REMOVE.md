# Remove DeltaChat

## 1. Disable the adapter

Comment out the import in `src/channels/index.ts`:

```typescript
// import './deltachat.js';
```

## 2. Remove credentials

Remove the `DC_*` lines from `.env`:

```bash
DC_EMAIL
DC_PASSWORD
DC_IMAP_HOST
DC_IMAP_PORT
DC_SMTP_HOST
DC_SMTP_PORT
```

## 3. Rebuild and restart

```bash
pnpm run build

# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## 4. Remove account data (optional)

To fully remove all account data including DeltaChat encryption keys:

```bash
rm -rf dc-account/
```

> **Warning:** This deletes the Autocrypt keys. Contacts who have verified your bot's key will need to re-verify if the same email address is re-used with a new account.

To keep the account for later reinstall, leave `dc-account/` intact.

## 5. Remove the package (optional)

```bash
pnpm remove @deltachat/stdio-rpc-server
```

## Verification

After removal, confirm the adapter is no longer starting:

```bash
grep "deltachat" logs/nanoclaw.log | tail -5
```

Expected: no `Channel adapter started` entry after the last restart.
