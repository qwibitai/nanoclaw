# Real-Time Subscriptions with Solana Kit

Complete examples for WebSocket subscriptions to monitor blockchain events.

## Setup

```bash
npm install @solana/kit
```

## Basic Connection

```typescript
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  address,
} from "@solana/kit";

const rpc = createSolanaRpc("https://api.devnet.solana.com");
const rpcSubscriptions = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");
```

## Account Change Subscription

Monitor changes to any account:

```typescript
async function watchAccount(accountAddress: string) {
  const controller = new AbortController();

  const subscription = await rpcSubscriptions
    .accountNotifications(address(accountAddress), {
      commitment: "confirmed",
      encoding: "base64",
    })
    .subscribe({ abortSignal: controller.signal });

  console.log(`Watching account: ${accountAddress}`);

  try {
    for await (const notification of subscription) {
      console.log("Account changed!");
      console.log("  Slot:", notification.context.slot);
      console.log("  Lamports:", notification.value.lamports);
      console.log("  Owner:", notification.value.owner);
      console.log("  Data length:", notification.value.data.length);

      // Process the update...
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("Subscription error:", error);
    }
  }

  // Call to stop watching
  return () => controller.abort();
}

// Usage
const stopWatching = await watchAccount("AccountAddress...");

// Later, to stop:
// stopWatching();
```

## Signature Confirmation

Wait for transaction confirmation:

```typescript
async function waitForConfirmation(signature: string): Promise<boolean> {
  const controller = new AbortController();

  // Set timeout
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const subscription = await rpcSubscriptions
      .signatureNotifications(signature, {
        commitment: "confirmed",
      })
      .subscribe({ abortSignal: controller.signal });

    for await (const notification of subscription) {
      clearTimeout(timeout);

      if (notification.value.err) {
        console.error("Transaction failed:", notification.value.err);
        return false;
      }

      console.log("Transaction confirmed at slot:", notification.context.slot);
      return true;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("Confirmation timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return false;
}
```

## Slot Updates

Monitor slot progression:

```typescript
async function watchSlots() {
  const controller = new AbortController();

  const subscription = await rpcSubscriptions
    .slotNotifications()
    .subscribe({ abortSignal: controller.signal });

  for await (const slotInfo of subscription) {
    console.log("Slot update:");
    console.log("  Slot:", slotInfo.slot);
    console.log("  Parent:", slotInfo.parent);
    console.log("  Root:", slotInfo.root);
  }

  return () => controller.abort();
}
```

## Program Account Changes

Monitor all accounts owned by a program:

```typescript
async function watchProgram(programId: string, filters?: any[]) {
  const controller = new AbortController();

  const subscription = await rpcSubscriptions
    .programNotifications(address(programId), {
      commitment: "confirmed",
      encoding: "base64",
      filters: filters,
    })
    .subscribe({ abortSignal: controller.signal });

  console.log(`Watching program: ${programId}`);

  for await (const notification of subscription) {
    console.log("Program account changed!");
    console.log("  Account:", notification.value.pubkey);
    console.log("  Slot:", notification.context.slot);
    console.log("  Lamports:", notification.value.account.lamports);
  }

  return () => controller.abort();
}

// Watch all token accounts
const stopWatching = await watchProgram(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  [{ dataSize: 165n }]  // Filter for token accounts only
);
```

## Transaction Logs

Monitor logs from transactions:

```typescript
async function watchLogs(options?: { mentions?: string[] }) {
  const controller = new AbortController();

  const subscription = await rpcSubscriptions
    .logsNotifications(
      options?.mentions
        ? { mentions: options.mentions.map((m) => address(m)) }
        : "all",
      { commitment: "confirmed" }
    )
    .subscribe({ abortSignal: controller.signal });

  for await (const notification of subscription) {
    console.log("Transaction logs:");
    console.log("  Signature:", notification.value.signature);
    console.log("  Error:", notification.value.err);
    console.log("  Logs:");
    for (const log of notification.value.logs) {
      console.log("    ", log);
    }
  }

  return () => controller.abort();
}

// Watch logs mentioning specific accounts
await watchLogs({
  mentions: ["ProgramIdOrAccountAddress..."],
});
```

## Root Updates

Monitor finalized roots:

```typescript
async function watchRoot() {
  const controller = new AbortController();

  const subscription = await rpcSubscriptions
    .rootNotifications()
    .subscribe({ abortSignal: controller.signal });

  for await (const root of subscription) {
    console.log("New root:", root);
  }

  return () => controller.abort();
}
```

## Token Balance Watcher

Practical example - watch a wallet's token balance:

```typescript
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

async function watchTokenBalance(
  wallet: string,
  mint: string,
  onChange: (balance: bigint) => void
) {
  // Find the ATA
  const [ata] = await findAssociatedTokenPda({
    mint: address(mint),
    owner: address(wallet),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const controller = new AbortController();

  const subscription = await rpcSubscriptions
    .accountNotifications(ata, {
      commitment: "confirmed",
      encoding: "base64",
    })
    .subscribe({ abortSignal: controller.signal });

  for await (const notification of subscription) {
    // Token account data: amount is at offset 64, 8 bytes (u64)
    const data = notification.value.data;
    const dataBuffer = Buffer.from(data[0], "base64");
    const balance = dataBuffer.readBigUInt64LE(64);

    onChange(balance);
  }

  return () => controller.abort();
}

// Usage
const stop = await watchTokenBalance(
  "WalletAddress...",
  "MintAddress...",
  (balance) => {
    console.log("New balance:", balance.toString());
  }
);
```

## Event Emitter Pattern

Wrap subscriptions in an event-driven pattern:

```typescript
import { EventEmitter } from "events";

class SolanaWatcher extends EventEmitter {
  private controllers: AbortController[] = [];

  constructor(
    private rpc: Rpc,
    private rpcSubscriptions: RpcSubscriptions
  ) {
    super();
  }

  async watchAccount(accountAddress: string) {
    const controller = new AbortController();
    this.controllers.push(controller);

    const subscription = await this.rpcSubscriptions
      .accountNotifications(address(accountAddress), { commitment: "confirmed" })
      .subscribe({ abortSignal: controller.signal });

    (async () => {
      try {
        for await (const notification of subscription) {
          this.emit("accountChange", {
            address: accountAddress,
            lamports: notification.value.lamports,
            slot: notification.context.slot,
          });
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          this.emit("error", error);
        }
      }
    })();
  }

  async watchSignature(signature: string) {
    const controller = new AbortController();
    this.controllers.push(controller);

    const subscription = await this.rpcSubscriptions
      .signatureNotifications(signature, { commitment: "confirmed" })
      .subscribe({ abortSignal: controller.signal });

    (async () => {
      try {
        for await (const notification of subscription) {
          this.emit("signatureConfirmed", {
            signature,
            err: notification.value.err,
            slot: notification.context.slot,
          });
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          this.emit("error", error);
        }
      }
    })();
  }

  stopAll() {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers = [];
  }
}

// Usage
const watcher = new SolanaWatcher(rpc, rpcSubscriptions);

watcher.on("accountChange", (data) => {
  console.log("Account changed:", data);
});

watcher.on("signatureConfirmed", (data) => {
  console.log("Transaction confirmed:", data);
});

watcher.on("error", (error) => {
  console.error("Watcher error:", error);
});

await watcher.watchAccount("AccountAddress...");

// Later:
// watcher.stopAll();
```

## Reconnection Handler

Handle WebSocket disconnections:

```typescript
async function watchWithReconnect(
  accountAddress: string,
  onUpdate: (data: any) => void,
  maxRetries = 5
) {
  let retries = 0;
  let controller: AbortController;

  const connect = async () => {
    controller = new AbortController();

    try {
      const subscription = await rpcSubscriptions
        .accountNotifications(address(accountAddress), {
          commitment: "confirmed",
        })
        .subscribe({ abortSignal: controller.signal });

      retries = 0;  // Reset on successful connection
      console.log("Connected to WebSocket");

      for await (const notification of subscription) {
        onUpdate(notification);
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;  // Intentionally stopped
      }

      console.error("WebSocket error:", error);

      if (retries < maxRetries) {
        retries++;
        const delay = Math.min(1000 * Math.pow(2, retries), 30000);
        console.log(`Reconnecting in ${delay}ms (attempt ${retries}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        connect();
      } else {
        console.error("Max retries exceeded");
        throw error;
      }
    }
  };

  await connect();

  return () => controller.abort();
}
```

## Multiple Subscription Manager

Manage multiple subscriptions efficiently:

```typescript
class SubscriptionManager {
  private subscriptions = new Map<string, AbortController>();

  constructor(private rpcSubscriptions: RpcSubscriptions) {}

  async subscribe(
    id: string,
    type: "account" | "program" | "logs",
    target: string,
    callback: (data: any) => void
  ) {
    // Cancel existing subscription with same ID
    this.unsubscribe(id);

    const controller = new AbortController();
    this.subscriptions.set(id, controller);

    let subscription;
    switch (type) {
      case "account":
        subscription = await this.rpcSubscriptions
          .accountNotifications(address(target), { commitment: "confirmed" })
          .subscribe({ abortSignal: controller.signal });
        break;
      case "program":
        subscription = await this.rpcSubscriptions
          .programNotifications(address(target), { commitment: "confirmed" })
          .subscribe({ abortSignal: controller.signal });
        break;
      case "logs":
        subscription = await this.rpcSubscriptions
          .logsNotifications({ mentions: [address(target)] }, { commitment: "confirmed" })
          .subscribe({ abortSignal: controller.signal });
        break;
    }

    (async () => {
      try {
        for await (const notification of subscription) {
          callback(notification);
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error(`Subscription ${id} error:`, error);
        }
      } finally {
        this.subscriptions.delete(id);
      }
    })();
  }

  unsubscribe(id: string) {
    const controller = this.subscriptions.get(id);
    if (controller) {
      controller.abort();
      this.subscriptions.delete(id);
    }
  }

  unsubscribeAll() {
    for (const [id, controller] of this.subscriptions) {
      controller.abort();
    }
    this.subscriptions.clear();
  }

  getActiveCount() {
    return this.subscriptions.size;
  }
}

// Usage
const manager = new SubscriptionManager(rpcSubscriptions);

await manager.subscribe("wallet-1", "account", "WalletAddress...", (data) => {
  console.log("Wallet updated:", data);
});

await manager.subscribe("token-program", "program", "TokenkegQfe...", (data) => {
  console.log("Token account changed:", data);
});

console.log("Active subscriptions:", manager.getActiveCount());

// Cleanup
manager.unsubscribeAll();
```
