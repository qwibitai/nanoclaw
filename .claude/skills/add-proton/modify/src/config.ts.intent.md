# Intent: src/config.ts modifications

## What changed
Added optional environment variables for Proton Bridge connection settings. These allow users to configure Bridge credentials via env vars instead of (or in addition to) the `~/.proton-mcp/bridge.json` file.

## Key sections

### readEnvFile keys array
- Added: `PROTON_BRIDGE_USERNAME`, `PROTON_BRIDGE_PASSWORD` to the keys read from `.env`

### New exports
```typescript
export const PROTON_BRIDGE_IMAP_HOST = process.env.PROTON_BRIDGE_IMAP_HOST || '127.0.0.1';
export const PROTON_BRIDGE_IMAP_PORT = parseInt(process.env.PROTON_BRIDGE_IMAP_PORT || '1143', 10);
export const PROTON_BRIDGE_SMTP_HOST = process.env.PROTON_BRIDGE_SMTP_HOST || '127.0.0.1';
export const PROTON_BRIDGE_SMTP_PORT = parseInt(process.env.PROTON_BRIDGE_SMTP_PORT || '1025', 10);
export const PROTON_BRIDGE_USERNAME = process.env.PROTON_BRIDGE_USERNAME || envConfig.PROTON_BRIDGE_USERNAME || '';
export const PROTON_BRIDGE_PASSWORD = process.env.PROTON_BRIDGE_PASSWORD || envConfig.PROTON_BRIDGE_PASSWORD || '';
```

## Invariants
- All existing config exports are unchanged
- The `readEnvFile` call pattern is preserved
- No secrets are added to the container environment — these are host-side only
