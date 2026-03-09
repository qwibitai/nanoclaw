# Intent: Add Feishu Channel Import

## What changes

Add `import './feishu.js'` to the channel barrel file.

## Where

At the end of `src/channels/index.ts`, after other channel imports.

## Invariants

- Import order doesn't matter (channels self-register)
- Must use `.js` extension for ESM compatibility
- No other changes to this file

## Example

Before:
```typescript
import './whatsapp.js';
import './telegram.js';
import './slack.js';
```

After:
```typescript
import './whatsapp.js';
import './telegram.js';
import './slack.js';
import './feishu.js';
```
