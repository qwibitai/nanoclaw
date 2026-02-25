# Surfpool Cheatcodes Reference

Complete reference for all Surfpool cheatcode RPC methods. These special methods are only available on Surfnet for advanced state manipulation during testing.

## Account & State Manipulation

### surfnet_setAccount

Modify account properties including lamports, data, owner, and executable status.

**Parameters:**
```typescript
{
  pubkey: string;          // Account public key
  lamports?: number;       // SOL balance in lamports
  data?: string;           // Base64 encoded account data
  owner?: string;          // Owner program public key
  executable?: boolean;    // Whether account is executable
}
```

**Example:**
```typescript
await connection.send("surfnet_setAccount", [
  {
    pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    lamports: 1000000000,
    executable: true,
  },
]);
```

---

### surfnet_setTokenAccount

Update token account properties like balance, delegate, state, and authorities.

**Parameters:**
```typescript
{
  owner: string;           // Token account owner
  mint: string;            // Token mint address
  tokenProgram?: string;   // Token program ID (default: Token Program)
  update: {
    amount?: string;       // Token balance
    delegate?: string;     // Delegate authority
    state?: string;        // Account state
    closeAuthority?: string;
  };
}
```

**Example:**
```typescript
await connection.send("surfnet_setTokenAccount", [
  {
    owner: "WalletPubkey...",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    update: {
      amount: "1000000000", // 1000 USDC
    },
  },
]);
```

---

### surfnet_setMintAccount

Create or modify mint accounts.

**Parameters:**
```typescript
{
  mint: string;            // Mint address
  decimals?: number;       // Token decimals
  mintAuthority?: string;  // Mint authority
  freezeAuthority?: string;
  supply?: string;         // Total supply
}
```

**Example:**
```typescript
await connection.send("surfnet_setMintAccount", [
  {
    mint: "NewMintPubkey...",
    decimals: 9,
    mintAuthority: "AuthorityPubkey...",
    supply: "1000000000000000000",
  },
]);
```

---

### surfnet_cloneProgramAccount

Duplicate a program account from source to destination.

**Parameters:**
```typescript
{
  source: string;      // Source program pubkey
  destination: string; // Destination pubkey
}
```

**Example:**
```typescript
await connection.send("surfnet_cloneProgramAccount", [
  {
    source: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    destination: "LocalJupiterPubkey...",
  },
]);
```

---

### surfnet_resetAccount

Restore an account to its original state from the remote datasource.

**Parameters:**
```typescript
{
  pubkey: string;              // Account to reset
  includeOwnedAccounts?: boolean; // Also reset owned accounts
}
```

**Example:**
```typescript
await connection.send("surfnet_resetAccount", [
  {
    pubkey: "PoolPubkey...",
    includeOwnedAccounts: true,
  },
]);
```

---

## Time Control

### surfnet_timeTravel

Advance network epoch/slot/timestamp to simulate future states.

**Parameters:**
```typescript
{
  epoch?: number;     // Target epoch
  slot?: number;      // Target slot
  timestamp?: number; // Unix timestamp
}
```

**Example:**
```typescript
// Jump to slot 1000000
await connection.send("surfnet_timeTravel", [
  { slot: 1000000 },
]);

// Jump to specific timestamp
await connection.send("surfnet_timeTravel", [
  { timestamp: 1735689600 }, // 2025-01-01
]);
```

---

### surfnet_pauseClock

Halt block production on the local network.

**Parameters:** None

**Example:**
```typescript
await connection.send("surfnet_pauseClock", []);
```

---

### surfnet_resumeClock

Resume network block production after pausing.

**Parameters:** None

**Example:**
```typescript
await connection.send("surfnet_resumeClock", []);
```

---

### surfnet_advanceClock

Move clock forward incrementally.

**Parameters:**
```typescript
{
  slots?: number;     // Number of slots to advance
  seconds?: number;   // Seconds to advance
}
```

**Example:**
```typescript
// Advance 100 slots
await connection.send("surfnet_advanceClock", [
  { slots: 100 },
]);
```

---

## Transaction & Performance Analysis

### surfnet_profileTransaction

Analyze transactions for compute units, account changes, and execution details.

**Parameters:**
```typescript
{
  transaction: string; // Base64 encoded transaction
  tag?: string;        // Tag for grouping results
}
```

**Returns:**
```typescript
{
  computeUnits: number;
  accountChanges: AccountChange[];
  logs: string[];
  success: boolean;
}
```

**Example:**
```typescript
const result = await connection.send("surfnet_profileTransaction", [
  {
    transaction: "base64EncodedTx...",
    tag: "swap-test",
  },
]);

console.log("CU used:", result.computeUnits);
```

---

### surfnet_getProfileResults

Retrieve profiling results for transactions with a specific tag.

**Parameters:**
```typescript
{
  tag: string; // Tag to filter by
}
```

**Example:**
```typescript
const results = await connection.send("surfnet_getProfileResults", [
  { tag: "swap-test" },
]);
```

---

### surfnet_getTransactionProfile

Fetch detailed profile by transaction signature or UUID.

**Parameters:**
```typescript
{
  signature?: string; // Transaction signature
  uuid?: string;      // Profile UUID
}
```

**Example:**
```typescript
const profile = await connection.send("surfnet_getTransactionProfile", [
  { signature: "txSignature..." },
]);
```

---

## Program & IDL Management

### surfnet_registerIdl

Register IDL for programs to enable account data parsing.

**Parameters:**
```typescript
{
  programId: string; // Program public key
  idl: object;       // Anchor IDL JSON
}
```

**Example:**
```typescript
import idl from "./target/idl/my_program.json";

await connection.send("surfnet_registerIdl", [
  {
    programId: "MyProgramPubkey...",
    idl: idl,
  },
]);
```

---

### surfnet_getIdl

Retrieve registered IDL for a program.

**Parameters:**
```typescript
{
  programId: string; // Program public key
  slot?: number;     // Optional: slot number
}
```

**Example:**
```typescript
const idl = await connection.send("surfnet_getIdl", [
  { programId: "MyProgramPubkey..." },
]);
```

---

### surfnet_setProgramAuthority

Set or remove upgrade authority for program.

**Parameters:**
```typescript
{
  programId: string;      // Program public key
  authority?: string;     // New authority (null to remove)
}
```

**Example:**
```typescript
// Remove upgrade authority (make immutable)
await connection.send("surfnet_setProgramAuthority", [
  {
    programId: "MyProgramPubkey...",
    authority: null,
  },
]);
```

---

### surfnet_writeProgram

Deploy large programs in chunks.

**Parameters:**
```typescript
{
  programId: string; // Program public key
  data: string;      // Base64 encoded chunk
  offset: number;    // Byte offset
}
```

**Example:**
```typescript
// Write program in chunks
const chunks = splitIntoChunks(programData, 10000);
for (let i = 0; i < chunks.length; i++) {
  await connection.send("surfnet_writeProgram", [
    {
      programId: "MyProgramPubkey...",
      data: chunks[i],
      offset: i * 10000,
    },
  ]);
}
```

---

## Network Control

### surfnet_resetNetwork

Reset entire network to initial state.

**Parameters:** None

**Example:**
```typescript
await connection.send("surfnet_resetNetwork", []);
```

---

### surfnet_resetSurfnet

Clear Surfnet state.

**Parameters:** None

**Example:**
```typescript
await connection.send("surfnet_resetSurfnet", []);
```

---

### surfnet_setSupply

Configure SOL supply amounts.

**Parameters:**
```typescript
{
  total: number;
  circulating: number;
  nonCirculating: number;
}
```

**Example:**
```typescript
await connection.send("surfnet_setSupply", [
  {
    total: 500000000000000000,
    circulating: 400000000000000000,
    nonCirculating: 100000000000000000,
  },
]);
```

---

## Information Retrieval

### surfnet_getClock

Get current epoch, slot, and timestamp.

**Returns:**
```typescript
{
  epoch: number;
  slot: number;
  timestamp: number;
  leaderScheduleEpoch: number;
}
```

**Example:**
```typescript
const clock = await connection.send("surfnet_getClock", []);
console.log(`Slot: ${clock.slot}, Epoch: ${clock.epoch}`);
```

---

### surfnet_getSurfpoolVersion

Get Surfpool version information.

**Returns:**
```typescript
{
  version: string;
  solanaCore: string;
  featureSet: number;
}
```

---

### surfnet_getSurfnetInfo

Get network metadata and runbook status.

**Returns:**
```typescript
{
  status: string;
  runbooks: RunbookStatus[];
  networkId: string;
}
```

---

### surfnet_getLocalSignatures

Get recent transaction signatures from local network.

**Parameters:**
```typescript
{
  limit?: number; // Max signatures to return
}
```

**Example:**
```typescript
const signatures = await connection.send("surfnet_getLocalSignatures", [
  { limit: 10 },
]);
```

---

## Scenarios & Snapshots

### surfnet_registerScenario

Register testing scenarios with account overrides.

**Parameters:**
```typescript
{
  name: string;
  slots: Array<{
    slot: number;
    accounts: Record<string, AccountOverride>;
  }>;
}
```

**Example:**
```typescript
await connection.send("surfnet_registerScenario", [
  {
    name: "liquidity-crisis",
    slots: [
      {
        slot: 100,
        accounts: {
          "PoolPubkey...": { lamports: 100000000 },
        },
      },
    ],
  },
]);
```

---

### surfnet_exportSnapshot

Export account snapshots with optional parsing and filtering.

**Parameters:**
```typescript
{
  accounts?: string[];  // Specific accounts to export
  parse?: boolean;      // Parse account data
  format?: "json" | "binary";
}
```

**Example:**
```typescript
const snapshot = await connection.send("surfnet_exportSnapshot", [
  {
    accounts: ["PoolPubkey...", "VaultPubkey..."],
    parse: true,
    format: "json",
  },
]);
```

---

### surfnet_streamAccount

Register accounts for live streaming from datasource.

**Parameters:**
```typescript
{
  pubkey: string;     // Account to stream
  subscribe: boolean; // true to start, false to stop
}
```

**Example:**
```typescript
// Stream live updates for an account
await connection.send("surfnet_streamAccount", [
  {
    pubkey: "OraclePubkey...",
    subscribe: true,
  },
]);
```

---

## Response Format

All cheatcode methods return a response with context:

```typescript
{
  context: {
    apiVersion: string;
    slot: number;
  };
  value: any; // Method-specific return value
}
```
