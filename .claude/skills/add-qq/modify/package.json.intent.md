# Intent: Add ws Dependencies to package.json

## What Changed

Added WebSocket client library (`ws`) and its TypeScript definitions.

## Changes Required

### 1. Add to dependencies

In the `dependencies` section, add:

```json
"ws": "^8.18.0"
```

### 2. Add to devDependencies

In the `devDependencies` section, add:

```json
"@types/ws": "^8.5.0"
```

## Full Example

```json
{
  "dependencies": {
    "@whiskeysockets/baileys": "^7.0.0-rc.9",
    "better-sqlite3": "^11.8.1",
    "cron-parser": "^5.5.0",
    "googleapis": "^171.4.0",
    "grammy": "^1.39.3",
    "https-proxy-agent": "^7.0.6",
    "pino": "^9.6.0",
    "pino-pretty": "^13.0.0",
    "qrcode": "^1.5.4",
    "qrcode-terminal": "^0.12.0",
    "undici": "^7.22.0",
    "ws": "^8.18.0",
    "yaml": "^2.8.2",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.0",
    "@types/qrcode-terminal": "^0.12.2",
    "@types/ws": "^8.5.0",
    "@vitest/coverage-v8": "^4.0.18",
    "prettier": "^3.8.1",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.18"
  }
}
```

## Invariants

- `ws` is a production dependency (used at runtime)
- `@types/ws` is a dev dependency (only for TypeScript compilation)
- Version `^8.18.0` is compatible with Node.js 18+
- No conflicts with existing dependencies

## After Applying

Run:
```bash
npm install
```

This will install both packages and update `package-lock.json`.

## Testing

After applying:

1. `npm install` should succeed
2. `npm run build` should succeed (TypeScript can find ws types)
3. Import should work: `import WebSocket from 'ws';`
