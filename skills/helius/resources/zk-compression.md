# ZK Compression API Reference

Complete reference for Helius ZK Compression API - work with compressed accounts and tokens on Solana.

## Overview

ZK Compression (Light Protocol) enables highly efficient state storage on Solana:
- **1000x cheaper** state storage
- Compressed accounts stored in merkle trees
- Validity proofs for state verification
- Compatible with standard Solana programs

## Core Concepts

### Compressed Accounts

State stored off-chain with on-chain merkle root verification:
- Data stored in merkle tree leaves
- Proofs verify state validity
- State transitions validated via ZK proofs

### Compressed Tokens

SPL tokens using compression:
- Same functionality as standard SPL tokens
- Fraction of the storage cost
- Ideal for airdrops, rewards, loyalty programs

## API Methods

### getCompressedAccount

Get data for a single compressed account.

```typescript
const account = await helius.zk.getCompressedAccount({
  address: "compressed_account_address",
  // OR
  hash: "account_hash",
});
```

**Response:**

```typescript
interface CompressedAccount {
  address: string;
  hash: string;
  data: {
    data: string; // Base64 encoded
    dataHash: string;
    discriminator: number;
  };
  owner: string;
  lamports: number;
  tree: string;
  leafIndex: number;
  seq: number;
  slotCreated: number;
}
```

### getMultipleCompressedAccounts

Batch fetch multiple compressed accounts.

```typescript
const accounts = await helius.zk.getMultipleCompressedAccounts({
  addresses: ["address1", "address2"],
  // OR
  hashes: ["hash1", "hash2"],
});
```

### getCompressedAccountsByOwner

Get all compressed accounts for an owner.

```typescript
const accounts = await helius.zk.getCompressedAccountsByOwner({
  owner: "wallet_address",
  cursor: null,
  limit: 100,
});

// Paginated response
interface Response {
  items: CompressedAccount[];
  cursor: string | null;
}
```

### getCompressedBalance

Get compressed SOL balance for an address.

```typescript
const balance = await helius.zk.getCompressedBalance({
  address: "compressed_account_address",
});

// Response: { value: number } // lamports
```

### getCompressedBalanceByOwner

Get total compressed balance for owner across all accounts.

```typescript
const balance = await helius.zk.getCompressedBalanceByOwner({
  owner: "wallet_address",
});
```

### getCompressedAccountProof

Get merkle proof for a compressed account.

```typescript
const proof = await helius.zk.getCompressedAccountProof({
  address: "compressed_account_address",
  // OR
  hash: "account_hash",
});
```

**Response:**

```typescript
interface CompressedAccountProof {
  hash: string;
  root: string;
  proof: string[]; // Merkle path
  leafIndex: number;
  rootSeq: number;
  tree: string;
}
```

### getMultipleCompressedAccountProofs

Batch fetch proofs for multiple accounts.

```typescript
const proofs = await helius.zk.getMultipleCompressedAccountProofs({
  addresses: ["address1", "address2"],
  // OR
  hashes: ["hash1", "hash2"],
});
```

### getCompressedTokenAccountsByOwner

Get compressed token accounts for a wallet.

```typescript
const tokenAccounts = await helius.zk.getCompressedTokenAccountsByOwner({
  owner: "wallet_address",
  mint: "token_mint", // Optional filter
  cursor: null,
  limit: 100,
});
```

**Response:**

```typescript
interface CompressedTokenAccount {
  account: {
    address: string;
    hash: string;
    owner: string;
    lamports: number;
    tree: string;
    leafIndex: number;
    seq: number;
    data: {
      data: string;
      dataHash: string;
      discriminator: number;
    };
  };
  tokenData: {
    mint: string;
    owner: string;
    amount: string; // BigInt as string
    delegate: string | null;
    state: "initialized" | "frozen";
    tlv: string | null;
  };
}
```

### getCompressedTokenAccountsByDelegate

Get token accounts for a delegate.

```typescript
const accounts = await helius.zk.getCompressedTokenAccountsByDelegate({
  delegate: "delegate_address",
  mint: "token_mint", // Optional
  cursor: null,
  limit: 100,
});
```

### getCompressedTokenAccountBalance

Get balance for a specific compressed token account.

```typescript
const balance = await helius.zk.getCompressedTokenAccountBalance({
  address: "compressed_token_account_address",
  // OR
  hash: "account_hash",
});

// Response: { amount: string } // BigInt as string
```

### getCompressedTokenBalancesByOwner

Get all token balances for an owner.

```typescript
const balances = await helius.zk.getCompressedTokenBalancesByOwner({
  owner: "wallet_address",
  cursor: null,
  limit: 100,
});
```

**Response:**

```typescript
interface TokenBalanceResponse {
  items: Array<{
    mint: string;
    balance: string; // BigInt as string
  }>;
  cursor: string | null;
}
```

### getCompressedTokenBalancesByOwnerV2

Enhanced version with additional metadata.

```typescript
const balances = await helius.zk.getCompressedTokenBalancesByOwnerV2({
  owner: "wallet_address",
  mint: "specific_mint", // Optional filter
  cursor: null,
  limit: 100,
});
```

### getCompressedMintTokenHolders

Get all holders of a compressed token.

```typescript
const holders = await helius.zk.getCompressedMintTokenHolders({
  mint: "token_mint_address",
  cursor: null,
  limit: 100,
});
```

### getValidityProof

Get validity proof for compressed account hashes.

```typescript
const proof = await helius.zk.getValidityProof({
  hashes: ["hash1", "hash2", "hash3"],
  newAddresses: ["newAddr1"], // Optional
  newAddressesWithTrees: [{ address: "addr", tree: "tree" }], // Optional
});
```

**Response:**

```typescript
interface ValidityProof {
  compressedProof: {
    a: string[];
    b: string[][];
    c: string[];
  };
  roots: string[];
  rootIndices: number[];
  leafIndices: number[];
  leaves: string[];
  merkleTrees: string[];
  nullifierQueues: string[];
  newAddressesRoots: string[];
  addressQueues: string[];
}
```

### getMultipleNewAddressProofs

Get proofs for creating new compressed addresses.

```typescript
const proofs = await helius.zk.getMultipleNewAddressProofs({
  addresses: ["new_address1", "new_address2"],
});
```

### getMultipleNewAddressProofsV2

Enhanced version with tree specification.

```typescript
const proofs = await helius.zk.getMultipleNewAddressProofsV2({
  addresses: [
    { address: "new_address1", tree: "merkle_tree1" },
    { address: "new_address2", tree: "merkle_tree2" },
  ],
});
```

### getCompressionSignaturesForAccount

Get compression-related transactions for an account.

```typescript
const signatures = await helius.zk.getCompressionSignaturesForAccount({
  address: "compressed_account_address",
  // OR
  hash: "account_hash",
  cursor: null,
  limit: 100,
});
```

### getCompressionSignaturesForAddress

Get all compression signatures for an address.

```typescript
const signatures = await helius.zk.getCompressionSignaturesForAddress({
  address: "address",
  cursor: null,
  limit: 100,
});
```

### getCompressionSignaturesForOwner

Get compression signatures for all accounts owned by address.

```typescript
const signatures = await helius.zk.getCompressionSignaturesForOwner({
  owner: "wallet_address",
  cursor: null,
  limit: 100,
});
```

### getCompressionSignaturesForTokenOwner

Get signatures for compressed token operations.

```typescript
const signatures = await helius.zk.getCompressionSignaturesForTokenOwner({
  owner: "wallet_address",
  cursor: null,
  limit: 100,
});
```

### getLatestCompressionSignatures

Get most recent compression signatures.

```typescript
const signatures = await helius.zk.getLatestCompressionSignatures({
  cursor: null,
  limit: 100,
});
```

### getLatestNonVotingSignatures

Get recent non-voting signatures (excludes validator votes).

```typescript
const signatures = await helius.zk.getLatestNonVotingSignatures({
  cursor: null,
  limit: 100,
});
```

### getTransactionWithCompressionInfo

Get transaction with decoded compression data.

```typescript
const tx = await helius.zk.getTransactionWithCompressionInfo({
  signature: "transaction_signature",
});
```

### getIndexerHealth

Check ZK compression indexer status.

```typescript
const health = await helius.zk.getIndexerHealth();
// Returns "ok" if healthy
```

### getIndexerSlot

Get current indexed slot.

```typescript
const slot = await helius.zk.getIndexerSlot();
// Returns current slot number
```

## Common Patterns

### Check Compressed Token Balance

```typescript
async function getCompressedTokenBalance(
  helius: Helius,
  owner: string,
  mint: string
): Promise<bigint> {
  const balances = await helius.zk.getCompressedTokenBalancesByOwner({
    owner,
  });

  const tokenBalance = balances.items.find(b => b.mint === mint);
  return tokenBalance ? BigInt(tokenBalance.balance) : 0n;
}
```

### List All Compressed Assets

```typescript
async function getAllCompressedAssets(
  helius: Helius,
  owner: string
) {
  const results = {
    accounts: [] as CompressedAccount[],
    tokens: [] as CompressedTokenAccount[],
  };

  // Get compressed accounts
  let cursor = null;
  do {
    const response = await helius.zk.getCompressedAccountsByOwner({
      owner,
      cursor,
      limit: 1000,
    });
    results.accounts.push(...response.items);
    cursor = response.cursor;
  } while (cursor);

  // Get compressed tokens
  cursor = null;
  do {
    const response = await helius.zk.getCompressedTokenAccountsByOwner({
      owner,
      cursor,
      limit: 1000,
    });
    results.tokens.push(...response.items);
    cursor = response.cursor;
  } while (cursor);

  return results;
}
```

### Verify Compressed Account

```typescript
async function verifyCompressedAccount(
  helius: Helius,
  address: string
) {
  const [account, proof] = await Promise.all([
    helius.zk.getCompressedAccount({ address }),
    helius.zk.getCompressedAccountProof({ address }),
  ]);

  // Verify proof matches account
  if (account.hash !== proof.hash) {
    throw new Error("Hash mismatch");
  }

  return { account, proof, verified: true };
}
```

### Paginate Through All Holders

```typescript
async function getAllTokenHolders(
  helius: Helius,
  mint: string
) {
  const holders: Array<{ owner: string; balance: string }> = [];
  let cursor = null;

  do {
    const response = await helius.zk.getCompressedMintTokenHolders({
      mint,
      cursor,
      limit: 1000,
    });

    for (const item of response.items) {
      holders.push({
        owner: item.tokenData.owner,
        balance: item.tokenData.amount,
      });
    }

    cursor = response.cursor;
  } while (cursor);

  return holders;
}
```

## Direct RPC Calls

All ZK Compression methods are available via JSON-RPC:

```typescript
const response = await fetch(RPC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getCompressedAccount",
    params: {
      address: "compressed_account_address",
    },
  }),
});

const { result } = await response.json();
```

## Credit Costs

| Method | Credits |
|--------|---------|
| `getCompressedAccount` | 1 |
| `getMultipleCompressedAccounts` | 1 per account |
| `getCompressedAccountsByOwner` | 1 |
| `getCompressedBalance` | 1 |
| `getCompressedAccountProof` | 1 |
| `getCompressedTokenAccountsByOwner` | 1 |
| `getCompressedTokenBalancesByOwner` | 1 |
| `getValidityProof` | 1 |
| `getCompressionSignaturesForOwner` | 1 |
| `getIndexerHealth` | 1 |
| `getIndexerSlot` | 1 |

## Best Practices

1. **Batch requests** - Use batch methods for multiple accounts/proofs
2. **Cache proofs** - Proofs are valid until state changes
3. **Check indexer health** - Verify indexer is synced before critical operations
4. **Handle pagination** - Use cursor-based pagination for large datasets
5. **Validate proofs** - Always verify proof matches account hash
