# Basic RPC Examples

Examples demonstrating Helius RPC usage with @solana/kit.

## Setup

```typescript
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { createHelius } from "helius-sdk";

const API_KEY = process.env.HELIUS_API_KEY!;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// Using @solana/kit
const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);

// Using Helius SDK
const helius = createHelius({ apiKey: API_KEY });
```

## Basic Queries

### Get Account Balance

```typescript
import { address, lamports } from "@solana/kit";

const LAMPORTS_PER_SOL = 1_000_000_000n;

async function getBalance(walletAddress: string) {
  const addr = address(walletAddress);
  const { value } = await rpc.getBalance(addr).send();

  const sol = Number(value) / Number(LAMPORTS_PER_SOL);
  console.log(`Balance: ${sol} SOL`);

  return value;
}

// Usage
await getBalance("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV");
```

### Get Account Info

```typescript
import { address, fetchEncodedAccount, assertAccountExists } from "@solana/kit";

async function getAccountInfo(accountAddress: string) {
  const addr = address(accountAddress);
  const account = await fetchEncodedAccount(rpc, addr);

  if (account.exists) {
    console.log("Owner:", account.programAddress);
    console.log("Lamports:", account.lamports);
    console.log("Data length:", account.data.length);
    return account;
  } else {
    console.log("Account does not exist");
    return null;
  }
}
```

### Get Multiple Accounts

```typescript
import { fetchEncodedAccounts } from "@solana/kit";

async function getMultipleAccounts(addresses: string[]) {
  const addrs = addresses.map(a => address(a));
  const accounts = await fetchEncodedAccounts(rpc, addrs);

  accounts.forEach((account, i) => {
    if (account.exists) {
      console.log(`${addresses[i]}: ${account.lamports} lamports`);
    } else {
      console.log(`${addresses[i]}: does not exist`);
    }
  });

  return accounts;
}
```

### Get Current Slot

```typescript
async function getCurrentSlot() {
  const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
  console.log("Current slot:", slot);
  return slot;
}
```

### Get Block Height

```typescript
async function getBlockHeight() {
  const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
  console.log("Block height:", height);
  return height;
}
```

### Get Epoch Info

```typescript
async function getEpochInfo() {
  const info = await rpc.getEpochInfo({ commitment: "confirmed" }).send();
  console.log("Epoch:", info.epoch);
  console.log("Slot index:", info.slotIndex);
  console.log("Slots in epoch:", info.slotsInEpoch);
  console.log("Progress:", ((info.slotIndex / info.slotsInEpoch) * 100).toFixed(2), "%");
  return info;
}
```

## Token Operations

### Get Token Balance

```typescript
async function getTokenBalance(tokenAccountAddress: string) {
  const addr = address(tokenAccountAddress);
  const { value } = await rpc.getTokenAccountBalance(addr).send();

  console.log("Amount:", value.amount);
  console.log("Decimals:", value.decimals);
  console.log("UI Amount:", value.uiAmountString);

  return value;
}
```

### Get Token Accounts by Owner

```typescript
async function getTokenAccountsByOwner(ownerAddress: string) {
  const owner = address(ownerAddress);
  const tokenProgram = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  const { value } = await rpc.getTokenAccountsByOwner(
    owner,
    { programId: tokenProgram },
    { encoding: "jsonParsed" }
  ).send();

  console.log(`Found ${value.length} token accounts`);

  for (const account of value) {
    const parsed = account.account.data.parsed;
    console.log(`Mint: ${parsed.info.mint}`);
    console.log(`Amount: ${parsed.info.tokenAmount.uiAmountString}`);
    console.log("---");
  }

  return value;
}
```

### Get Token Supply

```typescript
async function getTokenSupply(mintAddress: string) {
  const mint = address(mintAddress);
  const { value } = await rpc.getTokenSupply(mint).send();

  console.log("Total supply:", value.uiAmountString);
  console.log("Decimals:", value.decimals);

  return value;
}
```

## Transaction Queries

### Get Transaction

```typescript
async function getTransaction(signature: string) {
  const tx = await rpc.getTransaction(signature, {
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send();

  if (tx) {
    console.log("Slot:", tx.slot);
    console.log("Block time:", new Date(tx.blockTime! * 1000).toISOString());
    console.log("Fee:", tx.meta?.fee);
    console.log("Status:", tx.meta?.err ? "Failed" : "Success");
  }

  return tx;
}
```

### Get Signatures for Address

```typescript
async function getRecentTransactions(walletAddress: string, limit = 10) {
  const addr = address(walletAddress);
  const signatures = await rpc.getSignaturesForAddress(addr, {
    limit,
    commitment: "confirmed",
  }).send();

  console.log(`Found ${signatures.length} transactions`);

  for (const sig of signatures) {
    const time = sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : "unknown";
    const status = sig.err ? "FAILED" : "SUCCESS";
    console.log(`${sig.signature.slice(0, 20)}... | ${time} | ${status}`);
  }

  return signatures;
}
```

## Helius-Specific Methods

### Get Transactions for Address (Enhanced)

```typescript
async function getEnhancedTransactionHistory(walletAddress: string) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactionsForAddress",
      params: [
        walletAddress,
        {
          limit: 50,
          source: "JUPITER", // Filter by source
          type: "SWAP",       // Filter by type
        },
      ],
    }),
  });

  const { result } = await response.json();
  console.log(`Found ${result.length} JUPITER swaps`);

  return result;
}
```

### Get Program Accounts V2 (Cursor Pagination)

```typescript
async function getAllProgramAccounts(programId: string) {
  const allAccounts = [];
  let cursor = null;

  do {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccountsV2",
        params: [
          programId,
          {
            encoding: "base64",
            cursor,
            limit: 1000,
          },
        ],
      }),
    });

    const { result } = await response.json();
    allAccounts.push(...result.accounts);
    cursor = result.cursor;

    console.log(`Fetched ${allAccounts.length} accounts...`);
  } while (cursor);

  console.log(`Total: ${allAccounts.length} accounts`);
  return allAccounts;
}
```

## WebSocket Subscriptions

### Subscribe to Account Changes

```typescript
async function subscribeToAccount(accountAddress: string) {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "accountSubscribe",
      params: [
        accountAddress,
        { encoding: "base64", commitment: "confirmed" },
      ],
    }));
    console.log("Subscribed to account:", accountAddress);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.method === "accountNotification") {
      console.log("Account changed!");
      console.log("Lamports:", data.params.result.value.lamports);
    } else if (data.result) {
      console.log("Subscription ID:", data.result);
    }
  };

  return ws;
}
```

### Subscribe to Logs

```typescript
async function subscribeToLogs(programId: string) {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [programId] },
        { commitment: "confirmed" },
      ],
    }));
    console.log("Subscribed to logs for:", programId);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.method === "logsNotification") {
      const { signature, logs } = data.params.result.value;
      console.log("Transaction:", signature.slice(0, 20) + "...");
      console.log("Logs:", logs.slice(0, 3).join("\n"));
      console.log("---");
    }
  };

  return ws;
}
```

## Health Check

```typescript
async function checkRpcHealth() {
  const health = await rpc.getHealth().send();
  console.log("RPC Health:", health);

  const version = await rpc.getVersion().send();
  console.log("Solana version:", version["solana-core"]);

  const slot = await rpc.getSlot().send();
  console.log("Current slot:", slot);

  return { health, version, slot };
}
```

## Complete Example

```typescript
import { createSolanaRpc, address, fetchEncodedAccount } from "@solana/kit";

const API_KEY = process.env.HELIUS_API_KEY!;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

async function main() {
  const rpc = createSolanaRpc(RPC_URL);
  const wallet = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";

  // Get balance
  const { value: balance } = await rpc.getBalance(address(wallet)).send();
  console.log("Balance:", Number(balance) / 1e9, "SOL");

  // Get recent transactions
  const signatures = await rpc.getSignaturesForAddress(address(wallet), {
    limit: 5,
  }).send();
  console.log("Recent transactions:", signatures.length);

  // Get epoch info
  const epoch = await rpc.getEpochInfo().send();
  console.log("Current epoch:", epoch.epoch);
}

main().catch(console.error);
```
