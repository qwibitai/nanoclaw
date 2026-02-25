# Real-Time Streaming Examples

Examples demonstrating Helius WebSocket subscriptions for real-time data.

## Setup

```typescript
const API_KEY = process.env.HELIUS_API_KEY!;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
```

## Basic WebSocket Connection

```typescript
function createWebSocket(): WebSocket {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("WebSocket connected");
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
  };

  ws.onclose = (event) => {
    console.log("WebSocket closed:", event.code, event.reason);
  };

  return ws;
}
```

## Account Subscription

```typescript
async function subscribeToAccount(accountAddress: string) {
  const ws = createWebSocket();

  ws.onopen = () => {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "accountSubscribe",
      params: [
        accountAddress,
        {
          encoding: "jsonParsed",
          commitment: "confirmed",
        },
      ],
    }));
    console.log("Subscribed to account:", accountAddress);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.method === "accountNotification") {
      const { slot, value } = data.params.result;
      console.log("=== Account Update ===");
      console.log("Slot:", slot);
      console.log("Lamports:", value.lamports);
      console.log("Owner:", value.owner);
      console.log("Data:", value.data);
    } else if (data.result !== undefined) {
      console.log("Subscription ID:", data.result);
    }
  };

  return ws;
}
```

## Program Logs Subscription

```typescript
async function subscribeToLogs(programIdOrFilter: string | "all") {
  const ws = createWebSocket();

  ws.onopen = () => {
    const filter = programIdOrFilter === "all"
      ? "all"
      : { mentions: [programIdOrFilter] };

    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        filter,
        { commitment: "confirmed" },
      ],
    }));
    console.log("Subscribed to logs:", programIdOrFilter);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.method === "logsNotification") {
      const { signature, logs, err } = data.params.result.value;
      console.log("=== Log Update ===");
      console.log("Signature:", signature);
      console.log("Error:", err);
      console.log("Logs:");
      logs.forEach((log: string, i: number) => {
        console.log(`  ${i}: ${log}`);
      });
    }
  };

  return ws;
}

// Subscribe to Jupiter program logs
subscribeToLogs("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");

// Subscribe to all logs
subscribeToLogs("all");
```

## Signature Subscription

```typescript
async function waitForConfirmation(signature: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const ws = createWebSocket();
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Confirmation timeout"));
    }, 60000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "signatureSubscribe",
        params: [
          signature,
          { commitment: "confirmed" },
        ],
      }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.method === "signatureNotification") {
        clearTimeout(timeout);
        ws.close();

        const { err } = data.params.result.value;
        if (err) {
          reject(new Error(`Transaction failed: ${JSON.stringify(err)}`));
        } else {
          resolve(true);
        }
      }
    };
  });
}

// Usage
try {
  await waitForConfirmation("5xyz...");
  console.log("Transaction confirmed!");
} catch (error) {
  console.error("Transaction failed:", error);
}
```

## Slot Subscription

```typescript
async function subscribeToSlots() {
  const ws = createWebSocket();
  let lastSlot = 0;

  ws.onopen = () => {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "slotSubscribe",
      params: [],
    }));
    console.log("Subscribed to slots");
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.method === "slotNotification") {
      const { slot, parent, root } = data.params.result;

      // Check for skipped slots
      if (lastSlot > 0 && slot - lastSlot > 1) {
        console.log(`Skipped ${slot - lastSlot - 1} slots`);
      }
      lastSlot = slot;

      console.log(`Slot: ${slot} | Parent: ${parent} | Root: ${root}`);
    }
  };

  return ws;
}
```

## Block Subscription

```typescript
async function subscribeToBlocks(filter?: string) {
  const ws = createWebSocket();

  ws.onopen = () => {
    const filterParam = filter
      ? { mentionsAccountOrProgram: filter }
      : "all";

    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "blockSubscribe",
      params: [
        filterParam,
        {
          commitment: "confirmed",
          encoding: "json",
          transactionDetails: "signatures",
          showRewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    }));
    console.log("Subscribed to blocks");
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.method === "blockNotification") {
      const { slot, block } = data.params.result.value;
      console.log("=== New Block ===");
      console.log("Slot:", slot);
      console.log("Blockhash:", block.blockhash);
      console.log("Transactions:", block.signatures?.length || 0);
      console.log("Parent Slot:", block.parentSlot);
    }
  };

  return ws;
}
```

## Root Subscription

```typescript
async function subscribeToRoot() {
  const ws = createWebSocket();

  ws.onopen = () => {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "rootSubscribe",
      params: [],
    }));
    console.log("Subscribed to root");
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.method === "rootNotification") {
      console.log("New root slot:", data.params.result);
    }
  };

  return ws;
}
```

## Multiple Subscriptions Manager

```typescript
class SubscriptionManager {
  private ws: WebSocket;
  private subscriptions: Map<number, {
    type: string;
    callback: (data: any) => void;
  }> = new Map();
  private requestId = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(private wsUrl: string) {
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      console.log("WebSocket connected");
      this.reconnectAttempts = 0;
      // Resubscribe to all subscriptions
      this.resubscribeAll();
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleMessage(data);
    };

    this.ws.onclose = () => {
      console.log("WebSocket closed");
      this.reconnect();
    };

    this.ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };
  }

  private reconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.pow(2, this.reconnectAttempts) * 1000;
      console.log(`Reconnecting in ${delay}ms...`);
      setTimeout(() => this.connect(), delay);
    } else {
      console.error("Max reconnect attempts reached");
    }
  }

  private handleMessage(data: any) {
    // Handle subscription confirmation
    if (data.id && data.result !== undefined) {
      const pending = this.subscriptions.get(data.id);
      if (pending) {
        console.log(`Subscription ${data.id} confirmed: ${data.result}`);
      }
      return;
    }

    // Handle notifications
    if (data.method) {
      for (const [, sub] of this.subscriptions) {
        if (data.method.includes(sub.type)) {
          sub.callback(data.params.result);
        }
      }
    }
  }

  private resubscribeAll() {
    // Re-create all subscriptions after reconnect
    for (const [id, sub] of this.subscriptions) {
      // Subscriptions need to be recreated
      console.log(`Resubscribing to ${sub.type}...`);
    }
  }

  subscribeAccount(address: string, callback: (data: any) => void): number {
    const id = ++this.requestId;

    this.subscriptions.set(id, {
      type: "account",
      callback,
    });

    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "accountSubscribe",
      params: [
        address,
        { encoding: "jsonParsed", commitment: "confirmed" },
      ],
    }));

    return id;
  }

  subscribeLogs(
    filter: string | "all",
    callback: (data: any) => void
  ): number {
    const id = ++this.requestId;

    this.subscriptions.set(id, {
      type: "logs",
      callback,
    });

    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "logsSubscribe",
      params: [
        filter === "all" ? "all" : { mentions: [filter] },
        { commitment: "confirmed" },
      ],
    }));

    return id;
  }

  subscribeSlot(callback: (data: any) => void): number {
    const id = ++this.requestId;

    this.subscriptions.set(id, {
      type: "slot",
      callback,
    });

    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "slotSubscribe",
      params: [],
    }));

    return id;
  }

  unsubscribe(id: number, type: string) {
    const method = `${type}Unsubscribe`;
    this.subscriptions.delete(id);

    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      params: [id],
    }));
  }

  close() {
    this.subscriptions.clear();
    this.ws.close();
  }
}

// Usage
const manager = new SubscriptionManager(WS_URL);

// Subscribe to account
const accountSubId = manager.subscribeAccount(
  "wallet_address",
  (data) => {
    console.log("Account update:", data);
  }
);

// Subscribe to program logs
const logsSubId = manager.subscribeLogs(
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  (data) => {
    console.log("Jupiter log:", data);
  }
);

// Subscribe to slots
const slotSubId = manager.subscribeSlot(
  (data) => {
    console.log("New slot:", data);
  }
);

// Later: unsubscribe
manager.unsubscribe(accountSubId, "account");
```

## Token Balance Monitor

```typescript
class TokenBalanceMonitor {
  private ws: WebSocket;
  private tokenAccounts: Map<string, {
    mint: string;
    lastBalance: number;
    callback: (change: number, newBalance: number) => void;
  }> = new Map();

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.setupHandlers();
  }

  private setupHandlers() {
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.method === "accountNotification") {
        this.handleAccountUpdate(data.params);
      }
    };
  }

  private handleAccountUpdate(params: any) {
    const { subscription, result } = params;

    for (const [address, info] of this.tokenAccounts) {
      if (result.value?.data?.parsed?.info) {
        const tokenInfo = result.value.data.parsed.info;
        const newBalance = parseInt(tokenInfo.tokenAmount.amount);
        const change = newBalance - info.lastBalance;

        if (change !== 0) {
          info.callback(change, newBalance);
          info.lastBalance = newBalance;
        }
      }
    }
  }

  monitorTokenAccount(
    tokenAccountAddress: string,
    mint: string,
    callback: (change: number, newBalance: number) => void
  ) {
    this.tokenAccounts.set(tokenAccountAddress, {
      mint,
      lastBalance: 0,
      callback,
    });

    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "accountSubscribe",
      params: [
        tokenAccountAddress,
        { encoding: "jsonParsed", commitment: "confirmed" },
      ],
    }));
  }

  close() {
    this.ws.close();
  }
}

// Usage
const monitor = new TokenBalanceMonitor(WS_URL);

monitor.monitorTokenAccount(
  "token_account_address",
  "token_mint",
  (change, newBalance) => {
    if (change > 0) {
      console.log(`Received ${change} tokens! New balance: ${newBalance}`);
    } else {
      console.log(`Sent ${Math.abs(change)} tokens! New balance: ${newBalance}`);
    }
  }
);
```

## Complete Example

```typescript
import WebSocket from "ws";

const API_KEY = process.env.HELIUS_API_KEY!;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

async function main() {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("Connected to Helius WebSocket");

    // Subscribe to Jupiter program logs
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"] },
        { commitment: "confirmed" },
      ],
    }));

    // Subscribe to slots
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "slotSubscribe",
      params: [],
    }));
  });

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());

    if (message.method === "logsNotification") {
      const { signature, logs } = message.params.result.value;
      console.log("\n=== Jupiter Activity ===");
      console.log("Signature:", signature);

      // Check for swap
      const swapLog = logs.find((l: string) => l.includes("Instruction: Route"));
      if (swapLog) {
        console.log("Swap detected!");
      }
    }

    if (message.method === "slotNotification") {
      const { slot } = message.params.result;
      process.stdout.write(`\rSlot: ${slot}`);
    }
  });

  ws.on("close", () => {
    console.log("\nWebSocket closed");
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });

  // Keep alive
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
}

main().catch(console.error);
```
