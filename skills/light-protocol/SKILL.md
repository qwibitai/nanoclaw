---
name: light-protocol
creator: raunit-dev
description: Complete guide for Light Protocol on Solana - includes ZK Compression for rent-free compressed tokens and PDAs using zero-knowledge proofs, and the Light Token Program for high-performance token standard (200x cheaper than SPL). Covers TypeScript SDK, JSON RPC methods, and complete integration patterns.
---

# Light Protocol Development Guide

Build scalable, cost-efficient applications on Solana with Light Protocol - the infrastructure platform enabling rent-free tokens and accounts with L1 performance and security.

## Overview

Light Protocol provides two complementary technologies:

- **ZK Compression**: Create rent-free compressed tokens and PDAs using zero-knowledge proofs. Uses Merkle trees and validity proofs to store state efficiently.
- **Light Token Program**: A high-performance token standard that reduces mint and token account costs by 200x compared to SPL tokens.

### Key Benefits

| Benefit | Description |
|---------|-------------|
| **200x Cost Reduction** | Compressed token accounts cost ~5,000 lamports vs ~2,000,000 for SPL |
| **Rent-Free Accounts** | No upfront rent-exemption required for tokens or PDAs |
| **L1 Security** | All execution and state remains on Solana mainnet |
| **Full Composability** | Works with existing Solana programs and wallets (Phantom, Backpack) |

## Program IDs

| Program | Address | Description |
|---------|---------|-------------|
| Light System Program | `SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7` | Core system program |
| Light Token Program | `cTokenmWW8bLPjZEBAUgYy3zKxQZW6VKi7bqNFEVv3m` | Compressed token operations |
| Account Compression | `compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq` | Account compression program |

## Quick Start

### Installation

```bash
# Install TypeScript SDKs
npm install @lightprotocol/stateless.js @lightprotocol/compressed-token

# Install CLI for local development
npm install -g @lightprotocol/zk-compression-cli
```

### RPC Setup

Light Protocol requires a ZK Compression-enabled RPC. Use Helius:

```typescript
import { Rpc, createRpc } from "@lightprotocol/stateless.js";

// Mainnet
const rpc = createRpc(
  "https://mainnet.helius-rpc.com?api-key=<YOUR_API_KEY>",
  "https://mainnet.helius-rpc.com?api-key=<YOUR_API_KEY>"
);

// Devnet
const devnetRpc = createRpc(
  "https://devnet.helius-rpc.com?api-key=<YOUR_API_KEY>",
  "https://devnet.helius-rpc.com?api-key=<YOUR_API_KEY>"
);
```

### Basic Setup

```typescript
import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import {
  createMint,
  mintTo,
  transfer,
} from "@lightprotocol/compressed-token";
import { Keypair, PublicKey } from "@solana/web3.js";

// Initialize RPC connection
const rpc = createRpc(process.env.RPC_ENDPOINT!, process.env.RPC_ENDPOINT!);

// Load wallet
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY!))
);

console.log("Connected to Light Protocol");
console.log("Wallet:", payer.publicKey.toBase58());
```

---

## ZK Compression

ZK Compression enables rent-free compressed tokens using zero-knowledge proofs. Compressed accounts are stored in Merkle trees and verified using validity proofs.

### Create Compressed Token Mint

```typescript
import { createMint } from "@lightprotocol/compressed-token";
import { Keypair } from "@solana/web3.js";

const payer = Keypair.generate();
const mintAuthority = payer;

// Create mint with token pool for compression
const { mint, transactionSignature } = await createMint(
  rpc,
  payer,           // Fee payer
  mintAuthority.publicKey,  // Mint authority
  9,               // Decimals
);

console.log("Mint created:", mint.toBase58());
console.log("Transaction:", transactionSignature);
```

### Mint Compressed Tokens

```typescript
import { mintTo } from "@lightprotocol/compressed-token";

const recipient = new PublicKey("...");
const amount = 1_000_000_000; // 1 token with 9 decimals

const transactionSignature = await mintTo(
  rpc,
  payer,           // Fee payer
  mint,            // Mint with token pool
  recipient,       // Recipient address
  mintAuthority,   // Mint authority (signer)
  amount,          // Amount to mint
);

console.log("Minted:", transactionSignature);
```

#### Mint to Multiple Recipients

```typescript
const recipients = [
  new PublicKey("recipient1..."),
  new PublicKey("recipient2..."),
  new PublicKey("recipient3..."),
];

const amounts = [
  1_000_000_000,
  2_000_000_000,
  3_000_000_000,
];

const transactionSignature = await mintTo(
  rpc,
  payer,
  mint,
  recipients,      // Array of recipients
  mintAuthority,
  amounts,         // Array of amounts (must match recipients length)
);
```

### Transfer Compressed Tokens

```typescript
import { transfer } from "@lightprotocol/compressed-token";

const recipient = new PublicKey("...");
const amount = 500_000_000; // 0.5 tokens

const transactionSignature = await transfer(
  rpc,
  payer,           // Fee payer
  mint,            // Mint with token pool
  amount,          // Amount to transfer
  sender,          // Token owner (signer)
  recipient,       // Destination address
);

console.log("Transferred:", transactionSignature);
```

> **Note**: Compressed token transfers use a consume-and-create model. Input accounts are consumed and new output accounts are created with updated balances.

### Compress SPL Tokens

Convert existing SPL tokens to compressed format:

```typescript
import { compress, compressSplTokenAccount } from "@lightprotocol/compressed-token";

// Compress specific amount to a recipient
const transactionSignature = await compress(
  rpc,
  payer,
  mint,
  amount,
  owner,           // SPL token owner
  recipient,       // Compressed token recipient
  tokenAccount,    // Source SPL token account
);

// Compress entire SPL token account (reclaim rent)
const tx = await compressSplTokenAccount(
  rpc,
  payer,
  mint,
  owner,
  tokenAccount,
  // Optional: amount to keep in SPL format
);
```

### Decompress to SPL Tokens

Convert compressed tokens back to SPL format:

```typescript
import { decompress } from "@lightprotocol/compressed-token";

const transactionSignature = await decompress(
  rpc,
  payer,
  mint,
  amount,
  owner,           // Compressed token owner (signer)
  recipient,       // SPL token recipient
);
```

### Query Compressed Accounts

```typescript
// Get all compressed token accounts for an owner
const tokenAccounts = await rpc.getCompressedTokenAccountsByOwner(
  owner.publicKey,
  { mint }
);

console.log("Token accounts:", tokenAccounts.items.length);

// Calculate total balance
const totalBalance = tokenAccounts.items.reduce(
  (sum, account) => sum + BigInt(account.parsed.amount),
  BigInt(0)
);
console.log("Total balance:", totalBalance.toString());

// Get compressed account balance
const balance = await rpc.getCompressedTokenAccountBalance(accountHash);

// Get validity proof for transaction
const proof = await rpc.getValidityProof(compressedAccountHashes);
```

### Create Token Pool for Existing Mint

Add compression support to an existing SPL mint:

```typescript
import { createTokenPool } from "@lightprotocol/compressed-token";

// Add token pool to existing SPL mint
// Note: Does NOT require mint authority
const transactionSignature = await createTokenPool(
  rpc,
  payer,           // Fee payer
  existingMint,    // Existing SPL mint
);
```

---

## Light Token Program

The Light Token Program is a separate high-performance token standard that reduces costs without ZK proofs. It's optimized for hot paths and provides wrap/unwrap interoperability with SPL tokens.

### Key Differences from ZK Compression

| Feature | ZK Compression | Light Token Program |
|---------|---------------|---------------------|
| Technology | Zero-knowledge proofs | Optimized token standard |
| Use Case | Compressed tokens/PDAs | High-performance tokens |
| Compute Units | Higher (proof verification) | Lower (optimized hot paths) |
| Interop | Compress/decompress SPL | Wrap/unwrap SPL & Token-2022 |

### Create Light Token Mint

```typescript
import { createLightMint } from "@lightprotocol/light-token";

const { mint, transactionSignature } = await createLightMint(
  rpc,
  payer,
  mintAuthority.publicKey,
  9,  // decimals
);

console.log("Light mint created:", mint.toBase58());
```

### Mint to Light-ATA

```typescript
import { mintToLightAta } from "@lightprotocol/light-token";

const transactionSignature = await mintToLightAta(
  rpc,
  payer,
  mint,
  recipient,
  mintAuthority,
  amount,
);
```

### Wrap SPL to Light Token

```typescript
import { wrapSpl } from "@lightprotocol/light-token";

// Wrap SPL tokens to Light tokens
const transactionSignature = await wrapSpl(
  rpc,
  payer,
  mint,
  amount,
  owner,
  splTokenAccount,
);
```

### Unwrap Light Token to SPL

```typescript
import { unwrapToSpl } from "@lightprotocol/light-token";

// Unwrap Light tokens back to SPL
const transactionSignature = await unwrapToSpl(
  rpc,
  payer,
  mint,
  amount,
  owner,
  recipient,  // SPL token account
);
```

---

## JSON RPC Methods

Light Protocol provides 21 specialized RPC methods for compressed accounts. Key methods:

| Method | Description |
|--------|-------------|
| `getCompressedAccount` | Get compressed account by address or hash |
| `getCompressedAccountsByOwner` | Get all compressed accounts for an owner |
| `getCompressedTokenAccountsByOwner` | Get compressed token accounts for an owner |
| `getCompressedTokenAccountBalance` | Get balance for a token account |
| `getCompressedTokenBalancesByOwner` | Get all token balances for an owner |
| `getCompressedMintTokenHolders` | Get all holders of a compressed mint |
| `getValidityProof` | Get ZK proof for compressed accounts |
| `getMultipleCompressedAccounts` | Batch fetch compressed accounts |
| `getTransactionWithCompressionInfo` | Get transaction with parsed compression data |
| `getIndexerHealth` | Check indexer status |

See [resources/json-rpc-methods.md](resources/json-rpc-methods.md) for complete documentation.

---

## Best Practices

### Transaction Limits

- **4 compressed accounts per transaction**: Split large operations into multiple transactions
- **Compute unit budget**: Add extra compute units for proof verification

```typescript
import { ComputeBudgetProgram } from "@solana/web3.js";

// Add compute budget for complex transactions
const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: 300_000,
});
```

### Batch Operations

```typescript
// Process multiple recipients in batches
async function batchMint(
  recipients: PublicKey[],
  amounts: number[],
  batchSize = 4
) {
  const results = [];

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batchRecipients = recipients.slice(i, i + batchSize);
    const batchAmounts = amounts.slice(i, i + batchSize);

    const sig = await mintTo(
      rpc,
      payer,
      mint,
      batchRecipients,
      mintAuthority,
      batchAmounts,
    );

    results.push(sig);
  }

  return results;
}
```

### Error Handling

```typescript
try {
  const signature = await transfer(rpc, payer, mint, amount, sender, recipient);
  console.log("Success:", signature);
} catch (error) {
  if (error.message.includes("TokenPool not found")) {
    // Create token pool first
    await createTokenPool(rpc, payer, mint);
  } else if (error.message.includes("Insufficient balance")) {
    // Check balance before transfer
    const accounts = await rpc.getCompressedTokenAccountsByOwner(sender.publicKey, { mint });
    console.log("Available balance:", accounts.items);
  } else {
    throw error;
  }
}
```

### Delegation

```typescript
import { approve, transferDelegated } from "@lightprotocol/compressed-token";

// Approve delegate
const approveSig = await approve(
  rpc,
  payer,
  mint,
  amount,
  owner,           // Token owner
  delegate,        // Delegate public key
);

// Transfer as delegate
const transferSig = await transferDelegated(
  rpc,
  payer,
  mint,
  amount,
  delegate,        // Delegate (signer)
  recipient,
);
```

---

## Resources

### Official Documentation
- [ZK Compression Docs](https://www.zkcompression.com)
- [Light Protocol Whitepaper](https://github.com/Lightprotocol/light-protocol/blob/main/light-paper-v0.1.0.pdf)

### GitHub Repositories
- [Light Protocol](https://github.com/Lightprotocol/light-protocol) - Main repository
- [Example Node.js Client](https://github.com/Lightprotocol/example-nodejs-client)
- [Example Web Client](https://github.com/Lightprotocol/example-web-client)

### Community
- [Discord](https://discord.gg/lightprotocol) - Light Protocol Discord
- [Helius Discord](https://discord.gg/helius) - RPC provider support

### Wallet Support
- Phantom - Native compressed token support
- Backpack - Native compressed token support

---

## Skill Structure

```
light-protocol/
├── SKILL.md                    # This file
├── resources/
│   ├── program-addresses.md    # Program IDs, state trees, RPC endpoints
│   ├── json-rpc-methods.md     # All 21 RPC methods documented
│   ├── sdk-reference.md        # TypeScript SDK reference
│   └── github-repos.md         # Official repositories
├── examples/
│   ├── setup/
│   │   └── example.ts          # Basic setup
│   ├── zk-compression/
│   │   ├── create-mint.ts      # Create compressed mint
│   │   ├── mint-tokens.ts      # Mint compressed tokens
│   │   ├── transfer-tokens.ts  # Transfer compressed tokens
│   │   ├── compress-spl.ts     # Compress SPL tokens
│   │   └── decompress.ts       # Decompress to SPL
│   ├── light-token-program/
│   │   ├── create-light-mint.ts
│   │   ├── mint-light-tokens.ts
│   │   └── wrap-unwrap.ts
│   ├── querying/
│   │   └── fetch-accounts.ts   # Query compressed accounts
│   └── advanced/
│       ├── batch-operations.ts # Multi-recipient operations
│       └── delegation.ts       # Approve and delegate transfers
├── templates/
│   └── setup.ts                # Complete starter template
└── docs/
    └── troubleshooting.md      # Common issues and solutions
```
