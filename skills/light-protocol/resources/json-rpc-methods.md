# Light Protocol JSON RPC Methods

Light Protocol provides 21 specialized JSON RPC methods for interacting with compressed accounts. These methods are available through ZK Compression-enabled RPC endpoints (e.g., Helius).

## Account Methods

### getCompressedAccount

Retrieve compressed account information by address or hash.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| address | string | No* | Base58 encoded address |
| hash | string | No* | Base58 encoded account hash |

*One of `address` or `hash` is required.

**Returns:** `CompressedAccount | null`

```typescript
const account = await rpc.getCompressedAccount(address);
// or
const account = await rpc.getCompressedAccount(undefined, hash);
```

---

### getCompressedAccountsByOwner

Retrieve all compressed accounts owned by a specific address.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| owner | string | Yes | Base58 encoded owner public key |
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results (default: 1000) |

**Returns:** `{ items: CompressedAccount[], cursor: string | null }`

```typescript
const accounts = await rpc.getCompressedAccountsByOwner(ownerPubkey);
console.log("Accounts found:", accounts.items.length);
```

---

### getMultipleCompressedAccounts

Retrieve multiple compressed accounts by addresses or hashes in a single request.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| addresses | string[] | No* | Array of Base58 encoded addresses |
| hashes | string[] | No* | Array of Base58 encoded hashes |

**Returns:** `{ items: (CompressedAccount | null)[] }`

```typescript
const accounts = await rpc.getMultipleCompressedAccounts(addresses);
```

---

## Token Account Methods

### getCompressedTokenAccountsByOwner

Retrieve compressed token accounts owned by a specific address.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| owner | string | Yes | Base58 encoded owner public key |
| mint | string | No | Filter by specific mint |
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: CompressedTokenAccount[], cursor: string | null }`

```typescript
// Get all token accounts
const allAccounts = await rpc.getCompressedTokenAccountsByOwner(owner);

// Get accounts for specific mint
const mintAccounts = await rpc.getCompressedTokenAccountsByOwner(owner, { mint });
```

---

### getCompressedTokenAccountsByDelegate

Retrieve compressed token accounts delegated to a specific address.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| delegate | string | Yes | Base58 encoded delegate public key |
| mint | string | No | Filter by specific mint |
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: CompressedTokenAccount[], cursor: string | null }`

```typescript
const delegatedAccounts = await rpc.getCompressedTokenAccountsByDelegate(
  delegatePubkey,
  { mint }
);
```

---

### getCompressedTokenAccountBalance

Retrieve the balance for a specific compressed token account.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| hash | string | Yes | Base58 encoded account hash |

**Returns:** `{ amount: string }`

```typescript
const balance = await rpc.getCompressedTokenAccountBalance(accountHash);
console.log("Balance:", balance.amount);
```

---

## Balance Methods

### getCompressedBalance

Retrieve the lamport balance for a specific compressed account.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| address | string | No* | Base58 encoded address |
| hash | string | No* | Base58 encoded account hash |

**Returns:** `{ lamports: string }`

```typescript
const balance = await rpc.getCompressedBalance(address);
```

---

### getCompressedBalanceByOwner

Query total compressed token balance for an account owner.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| owner | string | Yes | Base58 encoded owner public key |

**Returns:** `{ lamports: string }`

```typescript
const totalBalance = await rpc.getCompressedBalanceByOwner(owner);
```

---

### getCompressedTokenBalancesByOwner

Retrieve all token balances for compressed accounts owned by an address.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| owner | string | Yes | Base58 encoded owner public key |
| mint | string | No | Filter by specific mint |
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: TokenBalance[], cursor: string | null }`

```typescript
const balances = await rpc.getCompressedTokenBalancesByOwner(owner);

for (const balance of balances.items) {
  console.log(`Mint: ${balance.mint}, Amount: ${balance.amount}`);
}
```

---

### getCompressedMintTokenHolders

Retrieve owner balances for a given mint in descending order.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| mint | string | Yes | Base58 encoded mint address |
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: TokenHolder[], cursor: string | null }`

```typescript
const holders = await rpc.getCompressedMintTokenHolders(mint);

for (const holder of holders.items) {
  console.log(`Owner: ${holder.owner}, Balance: ${holder.balance}`);
}
```

---

## Proof Methods

### getValidityProof

Retrieve ZK validity proof for compressed accounts. Required for building transactions that modify compressed state.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| hashes | string[] | Yes | Array of compressed account hashes |
| newAddresses | string[] | No | New addresses to prove non-existence |
| newAddressesWithTrees | object[] | No | New addresses with specific tree assignments |

**Returns:** `ValidityProof`

```typescript
const proof = await rpc.getValidityProof(
  compressedAccountHashes,
  newAddresses
);

// Use proof in transaction
const tx = buildTransaction(proof);
```

---

### getMultipleNewAddressProofs

Retrieve proofs that new addresses are not already taken.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| addresses | string[] | Yes | Array of new addresses to verify |

**Returns:** `{ items: NewAddressProof[] }`

```typescript
const proofs = await rpc.getMultipleNewAddressProofs(newAddresses);
```

---

## Transaction Signature Methods

### getCompressionSignaturesForAccount

Retrieve transaction signatures that closed or opened a compressed account.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| hash | string | Yes | Compressed account hash |
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: SignatureInfo[], cursor: string | null }`

```typescript
const signatures = await rpc.getCompressionSignaturesForAccount(accountHash);
```

---

### getCompressionSignaturesForAddress

Retrieve signatures for accounts with given address.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| address | string | Yes | Account address |
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: SignatureInfo[], cursor: string | null }`

```typescript
const signatures = await rpc.getCompressionSignaturesForAddress(address);
```

---

### getCompressionSignaturesForOwner

Retrieve signatures of transactions that modified an owner's compressed accounts.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| owner | string | Yes | Owner public key |
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: SignatureInfo[], cursor: string | null }`

```typescript
const signatures = await rpc.getCompressionSignaturesForOwner(owner);
```

---

### getCompressionSignaturesForTokenOwner

Retrieve signatures modifying owner's token accounts.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| owner | string | Yes | Owner public key |
| mint | string | No | Filter by mint |
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: SignatureInfo[], cursor: string | null }`

```typescript
const signatures = await rpc.getCompressionSignaturesForTokenOwner(owner, { mint });
```

---

### getLatestCompressionSignatures

Retrieve signatures of the latest transactions using the compression program.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: SignatureInfo[], cursor: string | null }`

```typescript
const latest = await rpc.getLatestCompressionSignatures();
```

---

### getLatestNonVotingSignatures

Retrieve latest non-voting transaction signatures.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| cursor | string | No | Pagination cursor |
| limit | number | No | Maximum results |

**Returns:** `{ items: SignatureInfo[], cursor: string | null }`

```typescript
const signatures = await rpc.getLatestNonVotingSignatures();
```

---

## Transaction Methods

### getTransactionWithCompressionInfo

Retrieve transaction data with parsed compression information.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| signature | string | Yes | Transaction signature |

**Returns:** `TransactionWithCompressionInfo | null`

```typescript
const txInfo = await rpc.getTransactionWithCompressionInfo(signature);

if (txInfo) {
  console.log("Compressed accounts opened:", txInfo.compressionInfo.openedAccounts);
  console.log("Compressed accounts closed:", txInfo.compressionInfo.closedAccounts);
}
```

---

## Indexer Health Methods

### getIndexerHealth

Retrieve an error if the indexer is stale by more than a configurable number of blocks.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| maxStaleSlots | number | No | Maximum acceptable stale slots |

**Returns:** `{ status: "ok" } | Error`

```typescript
try {
  const health = await rpc.getIndexerHealth();
  console.log("Indexer status:", health.status);
} catch (error) {
  console.error("Indexer is stale:", error.message);
}
```

---

### getIndexerSlot

Retrieve the slot of the last block indexed by the indexer.

**Parameters:** None

**Returns:** `{ slot: number }`

```typescript
const indexerSlot = await rpc.getIndexerSlot();
console.log("Last indexed slot:", indexerSlot.slot);
```

---

## Types Reference

### CompressedAccount

```typescript
interface CompressedAccount {
  hash: string;
  address: string | null;
  owner: string;
  lamports: string;
  data: {
    discriminator: number[];
    data: number[];
    dataHash: string;
  } | null;
  tree: string;
  leafIndex: number;
  seq: number;
  slotCreated: number;
}
```

### CompressedTokenAccount

```typescript
interface CompressedTokenAccount {
  hash: string;
  owner: string;
  mint: string;
  amount: string;
  delegate: string | null;
  state: "initialized" | "frozen";
  tree: string;
  leafIndex: number;
  slotCreated: number;
}
```

### SignatureInfo

```typescript
interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
}
```

### ValidityProof

```typescript
interface ValidityProof {
  compressedProof: {
    a: number[];
    b: number[];
    c: number[];
  };
  rootIndices: number[];
  leafIndices: number[];
  leaves: string[];
  merkleTrees: string[];
  nullifierQueues: string[];
}
```
