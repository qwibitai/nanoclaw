# Fix for Issue #221: Unhandled Promise Rejections

**Status:** ✅ Complete  
**Commit:** `c81c9e0`  
**Branch:** `main` on `pottertech/nanoclaw`

## Changes Made

### 1. Global Error Handlers (src/index.ts)

Added at the top of the file, after imports:

```typescript
// Global error handlers to prevent crashes from unhandled rejections/exceptions
// See: https://github.com/qwibitai/nanoclaw/issues/221
process.on('unhandledRejection', (reason, promise) => {
  logger.error(
    { reason: reason instanceof Error ? reason.message : String(reason) },
    'Unhandled promise rejection - application will continue',
  );
  // Log the promise that was rejected for debugging
  if (promise && typeof promise.catch === 'function') {
    promise.catch((err) => {
      logger.error({ err }, 'Promise rejection details');
    });
  }
});

process.on('uncaughtException', (err) => {
  logger.error(
    { err: err.message, stack: err.stack },
    'Uncaught exception - attempting graceful shutdown',
  );
  // Attempt graceful shutdown before exiting
  shutdown().finally(() => {
    process.exit(1);
  });
});

// Top-level shutdown function for global error handlers
let shutdownFn: (() => Promise<void>) | null = null;
async function shutdown(): Promise<void> {
  if (shutdownFn) {
    await shutdownFn();
  } else {
    logger.warn('Shutdown called before initialization, forcing exit');
    process.exit(1);
  }
}
```

### 2. Shutdown Registration

In `main()` function, after setting up shutdown handlers:

```typescript
// Register shutdown function for global error handlers
shutdownFn = () => shutdown('SHUTDOWN_SIGNAL');
```

### 3. Streaming Callback Error Handling

Wrapped the streaming output callback in try/catch:

```typescript
const output = await runAgent(group, prompt, chatJid, async (result) => {
  // Streaming output callback — called for each agent result
  // Wrap in try/catch to prevent unhandled rejections
  try {
    if (result.result) {
      // ... existing logic ...
    }
    if (result.status === 'error') {
      hadError = true;
    }
  } catch (err) {
    logger.error({ group: group.name, err }, 'Error in streaming output callback');
    hadError = true;
  }
});
```

## Behavior

**Before:**
- Unhandled promise rejections crashed the entire message loop
- Container/agent errors would terminate the application
- No graceful shutdown on fatal errors

**After:**
1. Unhandled rejections are logged and the application continues
2. Uncaught exceptions trigger graceful shutdown (queue drains, connections close)
3. Streaming callback errors are caught and marked as errors (triggering retry)
4. Errors don't cause duplicate message processing due to cursor rollback

## Testing

Build passes:
```bash
npm install
npm run build
# compiles successfully
```

## Ready for PR

This fix is ready to be submitted as a PR to `qwibitai/nanoclaw`:

```bash
gh pr create --repo qwibitai/nanoclaw --title "Fix: Prevent crashes from unhandled promise rejections (#221)" --body-file FIX_DESCRIPTION.md
```

---

*Fixed by: Brodie Foxworth (brodie.foxworth@pottersquill.com)*  
*Date: February 15, 2026*
