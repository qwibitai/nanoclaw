# Migration Example: Subscription Handling

Migrating WebSocket subscriptions from v1's callback pattern to Kit's AsyncIterator pattern.

## 1. Account Change Subscription

### v1 Implementation (Callback Pattern)

```typescript
import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';

const connection = new Connection(
  'https://api.mainnet-beta.solana.com',
  {
    wsEndpoint: 'wss://api.mainnet-beta.solana.com',
    commitment: 'confirmed',
  }
);

const accountToWatch = new PublicKey('AccountAddress...');

// Subscribe
const subscriptionId = connection.onAccountChange(
  accountToWatch,
  (accountInfo: AccountInfo<Buffer>, context) => {
    console.log('Account changed!');
    console.log('Slot:', context.slot);
    console.log('Data length:', accountInfo.data.length);
    console.log('Lamports:', accountInfo.lamports);
  },
  'confirmed'
);

console.log('Subscription ID:', subscriptionId);

// Later: Unsubscribe
setTimeout(() => {
  connection.removeAccountChangeListener(subscriptionId);
  console.log('Unsubscribed');
}, 60000);
```

### Kit Implementation (AsyncIterator Pattern)

```typescript
import {
  createSolanaRpcSubscriptions,
  address,
} from '@solana/kit';

const rpcSubscriptions = createSolanaRpcSubscriptions(
  'wss://api.mainnet-beta.solana.com'
);

const accountToWatch = address('AccountAddress...');

// Create AbortController for cleanup
const abortController = new AbortController();

async function watchAccount() {
  try {
    const notifications = await rpcSubscriptions
      .accountNotifications(accountToWatch, {
        commitment: 'confirmed',
        encoding: 'base64',
      })
      .subscribe({ abortSignal: abortController.signal });

    console.log('Subscription started');

    // Process notifications with for-await-of
    for await (const notification of notifications) {
      console.log('Account changed!');
      console.log('Slot:', notification.context.slot);
      console.log('Data:', notification.value.data);
      console.log('Lamports:', notification.value.lamports);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('Subscription cancelled');
    } else {
      throw error;
    }
  }
}

// Start watching
watchAccount();

// Later: Unsubscribe
setTimeout(() => {
  abortController.abort();
  console.log('Unsubscribed');
}, 60000);
```

---

## 2. Signature Confirmation

### v1 Implementation

```typescript
import { Connection } from '@solana/web3.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', {
  wsEndpoint: 'wss://api.mainnet-beta.solana.com',
});

async function waitForConfirmation(signature: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const subscriptionId = connection.onSignature(
      signature,
      (result, context) => {
        if (result.err) {
          reject(new Error(`Transaction failed: ${JSON.stringify(result.err)}`));
        } else {
          console.log('Confirmed at slot:', context.slot);
          resolve();
        }
      },
      'confirmed'
    );

    // Timeout after 30 seconds
    setTimeout(() => {
      connection.removeSignatureListener(subscriptionId);
      reject(new Error('Confirmation timeout'));
    }, 30000);
  });
}

// Usage
await waitForConfirmation('5wHu1qwD...');
```

### Kit Implementation

```typescript
import {
  createSolanaRpcSubscriptions,
} from '@solana/kit';

const rpcSubscriptions = createSolanaRpcSubscriptions(
  'wss://api.mainnet-beta.solana.com'
);

async function waitForConfirmation(signature: string): Promise<void> {
  const abortController = new AbortController();

  // Set timeout
  const timeout = setTimeout(() => {
    abortController.abort();
  }, 30000);

  try {
    const notifications = await rpcSubscriptions
      .signatureNotifications(signature, { commitment: 'confirmed' })
      .subscribe({ abortSignal: abortController.signal });

    for await (const notification of notifications) {
      clearTimeout(timeout);

      if (notification.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(notification.value.err)}`);
      }

      console.log('Confirmed at slot:', notification.context.slot);
      return; // Only need first confirmation
    }
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('Confirmation timeout');
    }
    throw error;
  }
}

// Usage
await waitForConfirmation('5wHu1qwD...');
```

---

## 3. Program Account Subscription

### v1 Implementation

```typescript
import { Connection, PublicKey } from '@solana/web3.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', {
  wsEndpoint: 'wss://api.mainnet-beta.solana.com',
});

const programId = new PublicKey('ProgramId...');

const subscriptionId = connection.onProgramAccountChange(
  programId,
  (keyedAccountInfo, context) => {
    console.log('Program account changed:');
    console.log('Account:', keyedAccountInfo.accountId.toBase58());
    console.log('Slot:', context.slot);
    console.log('Data:', keyedAccountInfo.accountInfo.data);
  },
  'confirmed',
  [
    // Optional filters
    { dataSize: 165 }, // Filter by account size
    {
      memcmp: {
        offset: 0,
        bytes: 'base58EncodedBytes...',
      },
    },
  ]
);

// Unsubscribe
connection.removeProgramAccountChangeListener(subscriptionId);
```

### Kit Implementation

```typescript
import {
  createSolanaRpcSubscriptions,
  address,
} from '@solana/kit';

const rpcSubscriptions = createSolanaRpcSubscriptions(
  'wss://api.mainnet-beta.solana.com'
);

const programId = address('ProgramId...');
const abortController = new AbortController();

async function watchProgramAccounts() {
  const notifications = await rpcSubscriptions
    .programNotifications(programId, {
      commitment: 'confirmed',
      encoding: 'base64',
      filters: [
        { dataSize: 165n }, // Note: bigint in Kit
        {
          memcmp: {
            offset: 0n,
            bytes: 'base58EncodedBytes...',
            encoding: 'base58',
          },
        },
      ],
    })
    .subscribe({ abortSignal: abortController.signal });

  for await (const notification of notifications) {
    console.log('Program account changed:');
    console.log('Account:', notification.value.pubkey);
    console.log('Slot:', notification.context.slot);
    console.log('Data:', notification.value.account.data);
  }
}

watchProgramAccounts();

// Unsubscribe
abortController.abort();
```

---

## 4. Slot Subscription

### v1 Implementation

```typescript
const subscriptionId = connection.onSlotChange((slotInfo) => {
  console.log('Slot:', slotInfo.slot);
  console.log('Parent:', slotInfo.parent);
  console.log('Root:', slotInfo.root);
});

// Unsubscribe
connection.removeSlotChangeListener(subscriptionId);
```

### Kit Implementation

```typescript
const abortController = new AbortController();

async function watchSlots() {
  const notifications = await rpcSubscriptions
    .slotNotifications()
    .subscribe({ abortSignal: abortController.signal });

  for await (const slot of notifications) {
    console.log('Slot:', slot.slot);
    console.log('Parent:', slot.parent);
    console.log('Root:', slot.root);
  }
}

watchSlots();

// Unsubscribe
abortController.abort();
```

---

## 5. Multiple Subscriptions Management

### v1 Implementation

```typescript
class SubscriptionManager {
  private connection: Connection;
  private subscriptions: number[] = [];

  constructor(connection: Connection) {
    this.connection = connection;
  }

  watchAccount(pubkey: PublicKey, callback: Function): number {
    const id = this.connection.onAccountChange(pubkey, callback as any, 'confirmed');
    this.subscriptions.push(id);
    return id;
  }

  unsubscribeAll(): void {
    for (const id of this.subscriptions) {
      this.connection.removeAccountChangeListener(id);
    }
    this.subscriptions = [];
  }
}
```

### Kit Implementation

```typescript
import { Address } from '@solana/kit';

class SubscriptionManager {
  private rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>;
  private controllers: AbortController[] = [];

  constructor(rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>) {
    this.rpcSubscriptions = rpcSubscriptions;
  }

  async watchAccount(
    address: Address,
    handler: (notification: any) => void
  ): Promise<AbortController> {
    const controller = new AbortController();
    this.controllers.push(controller);

    const notifications = await this.rpcSubscriptions
      .accountNotifications(address, { commitment: 'confirmed' })
      .subscribe({ abortSignal: controller.signal });

    // Process in background
    (async () => {
      try {
        for await (const notification of notifications) {
          handler(notification);
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('Subscription error:', error);
        }
      }
    })();

    return controller;
  }

  unsubscribeAll(): void {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers = [];
  }
}
```

---

## Key Differences Summary

| Aspect | v1 (Callbacks) | Kit (AsyncIterator) |
|--------|----------------|---------------------|
| **Pattern** | Callback functions | `for await...of` loop |
| **Cleanup** | Subscription ID + `removeListener()` | `AbortController.abort()` |
| **Error Handling** | Callback error param | try/catch around loop |
| **Multiple Values** | Multiple callback invocations | Loop iterations |
| **Cancellation** | Manual ID tracking | Built-in with AbortSignal |
| **Memory** | Manual cleanup required | Automatic with abort |

## Migration Tips

1. **Replace callbacks with async iteration**: Each callback becomes a loop iteration
2. **Use AbortController**: Standard web API for cancellation
3. **Handle AbortError**: Check `error.name === 'AbortError'` for clean cancellation
4. **Wrap in try/catch**: Errors are thrown, not passed to callbacks
5. **Process in background**: Use IIFE pattern for non-blocking subscription processing
6. **Timeout handling**: Use `setTimeout` with `abort()` instead of Promise racing

## Common Gotchas

1. **Forgetting to abort**: Always call `abort()` to clean up subscriptions
2. **Not awaiting subscribe**: The `subscribe()` call must be awaited
3. **Breaking out of loop**: Use `return` or `break` to stop processing
4. **Error propagation**: Errors in the loop will stop iteration
5. **Multiple subscribers**: Each `subscribe()` creates a new subscription
