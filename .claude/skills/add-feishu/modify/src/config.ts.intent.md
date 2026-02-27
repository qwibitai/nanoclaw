# Intent: src/config.ts modifications for Feishu support

## What Changed

Added Feishu (Lark) configuration options to enable the Feishu channel:

1. **Environment variables**: Added `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ONLY` to `readEnvFile` call
2. **Config exports**: Added three new exports for Feishu configuration

## Key Sections

### readEnvFile Call
Added three new environment variable names to the array:
```typescript
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_ONLY',
]);
```

### New Exports
```typescript
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID || envConfig.FEISHU_APP_ID;
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || envConfig.FEISHU_APP_SECRET;
export const FEISHU_ONLY =
  (process.env.FEISHU_ONLY || envConfig.FEISHU_ONLY) === 'true';
```

## Invariants (Must NOT Change)

1. **readEnvFile pattern**: Must continue to use `readEnvFile()` helper with array of env var names
2. **Fallback behavior**: All Feishu config should be optional (undefined when not set)
3. **Boolean parsing**: `FEISHU_ONLY` must use `=== 'true'` pattern for proper boolean conversion
4. **Existing exports**: All existing config exports must remain unchanged

## Must Keep

- Existing `ASSISTANT_NAME`, `ASSISTANT_HAS_OWN_NUMBER` handling
- All existing path, timeout, and pattern configurations
- The `escapeRegex` helper function
- `TRIGGER_PATTERN` construction logic
