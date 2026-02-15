# Effect.ts POC - Message Queue

This directory contains a proof-of-concept implementation of Effect.ts for NanoClaw's message queue system.

## What This Demonstrates

This POC shows how Effect.ts can improve reliability and maintainability for message handling:

### 1. **Automatic Retries**
```typescript
// Before (manual retry logic in group-queue.ts)
if (!success) {
  state.retryCount++;
  const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
  setTimeout(() => { /* retry */ }, delayMs);
}

// After (declarative retry policy)
Effect.retry(
  Schedule.exponential(baseRetryDelayMs)
    .pipe(Schedule.compose(Schedule.recurs(maxRetries)))
)
```

### 2. **Timeout Protection**
```typescript
// Automatically timeout long-running operations
sendMessageCore(groupJid, text, backend, groupFolder).pipe(
  Effect.timeout(sendTimeoutMs)
)
```

### 3. **Type-Safe Errors**
```typescript
// Explicit error types instead of try/catch
type MessageResult = Effect.Effect<
  void,
  MessageSendError | ConcurrencyLimitError
>;

// Exhaustive error handling
Effect.match(result, {
  onSuccess: () => console.log('Message sent'),
  onFailure: (error) => {
    switch (error._tag) {
      case 'MessageSendError':
        // Handle send error
      case 'ConcurrencyLimitError':
        // Handle concurrency error
    }
  }
});
```

### 4. **Dependency Injection**
```typescript
// Easy to test with mock backends
const testLayer = MessageQueueLive({
  maxConcurrent: 1,
  maxRetries: 2,
});

const program = queue.sendMessage('group1', 'test')
  .pipe(Effect.provide(testLayer));
```

### 5. **Structured Concurrency**
```typescript
// Guaranteed cleanup and resource management
Effect.ensuring(
  Ref.update(activeCount, (n) => n - 1)
)
```

## Files

- `message-queue.ts` - Effect-based message queue implementation
- `message-queue.test.ts` - Comprehensive test suite (7 tests, all passing)
- `README.md` - This file

## Running Tests

```bash
bun test src/effect/message-queue.test.ts
```

All 7 tests pass, demonstrating:
- Successful message sending
- Automatic retry on transient failures
- Failure after max retries exhausted
- Concurrency limit enforcement
- Stats tracking
- Backend override capability

## Next Steps

If this POC is approved, we can:

1. **Integrate with existing code** - Add Effect runtime to `group-queue.ts`
2. **Extend to other modules** - Apply to file operations, API clients
3. **Add more Effect patterns** - Queues, Fibers, resource management
4. **Improve observability** - Effect's built-in tracing and metrics

## Performance

Effect adds minimal overhead:
- Retry logic is lazy and only executes when needed
- Ref updates are atomic and fast
- Schedule compositions are efficient

The tradeoff is better reliability, testability, and maintainability.

## Resources

- [Effect Documentation](https://effect.website/docs/introduction)
- [Effect Retrying Guide](https://effect.website/docs/guides/error-management/retrying)
- [Effect Schema](https://effect.website/docs/schema/introduction)
