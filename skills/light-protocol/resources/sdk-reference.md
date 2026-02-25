# Light Protocol TypeScript SDK Reference

## Packages

### @lightprotocol/stateless.js

Core SDK for building Solana applications with ZK Compression.

```bash
npm install @lightprotocol/stateless.js
```

### @lightprotocol/compressed-token

SDK for compressed token operations (mint, transfer, compress, decompress).

```bash
npm install @lightprotocol/compressed-token
```

### @lightprotocol/zk-compression-cli

CLI tool for local development and testing.

```bash
npm install -g @lightprotocol/zk-compression-cli
```

---

## stateless.js Functions

### Connection & RPC

#### createRpc

Create an RPC connection for ZK Compression operations.

```typescript
import { createRpc, Rpc } from "@lightprotocol/stateless.js";

const rpc: Rpc = createRpc(
  rpcEndpoint: string,      // Solana RPC endpoint
  compressionEndpoint: string, // Photon API endpoint (usually same as RPC)
  proverEndpoint?: string   // Optional custom prover endpoint
);
```

**Example:**
```typescript
const rpc = createRpc(
  "https://mainnet.helius-rpc.com?api-key=YOUR_KEY",
  "https://mainnet.helius-rpc.com?api-key=YOUR_KEY"
);
```

---

### Account Operations

#### getCompressedAccount

```typescript
const account = await rpc.getCompressedAccount(
  address?: PublicKey,
  hash?: string
): Promise<CompressedAccount | null>;
```

#### getCompressedAccountsByOwner

```typescript
const accounts = await rpc.getCompressedAccountsByOwner(
  owner: PublicKey,
  options?: { cursor?: string; limit?: number }
): Promise<{ items: CompressedAccount[]; cursor: string | null }>;
```

---

## compressed-token Functions

### Mint Operations

#### createMint

Create a new compressed token mint with built-in token pool.

```typescript
import { createMint } from "@lightprotocol/compressed-token";

const result = await createMint(
  rpc: Rpc,
  payer: Signer,
  mintAuthority: PublicKey,
  decimals: number,
  keypair?: Keypair,        // Optional: use specific keypair for mint
  freezeAuthority?: PublicKey | null
): Promise<{ mint: PublicKey; transactionSignature: string }>;
```

**Example:**
```typescript
const { mint, transactionSignature } = await createMint(
  rpc,
  payer,
  payer.publicKey,
  9  // decimals
);
```

---

#### createTokenPool

Add compression support to an existing SPL mint.

```typescript
import { createTokenPool } from "@lightprotocol/compressed-token";

const transactionSignature = await createTokenPool(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  feePayer?: Signer         // Optional: different fee payer
): Promise<string>;
```

**Note:** Does NOT require mint authority. Anyone can add a token pool.

---

#### mintTo

Mint compressed tokens to one or more recipients.

```typescript
import { mintTo } from "@lightprotocol/compressed-token";

// Single recipient
const signature = await mintTo(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  destination: PublicKey,
  authority: Signer,
  amount: number | bigint
): Promise<string>;

// Multiple recipients
const signature = await mintTo(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  destinations: PublicKey[],
  authority: Signer,
  amounts: (number | bigint)[]
): Promise<string>;
```

**Example:**
```typescript
// Mint to single recipient
const sig = await mintTo(rpc, payer, mint, recipient, mintAuthority, 1_000_000_000);

// Mint to multiple recipients
const sig = await mintTo(
  rpc,
  payer,
  mint,
  [recipient1, recipient2, recipient3],
  mintAuthority,
  [1_000_000_000, 2_000_000_000, 3_000_000_000]
);
```

---

### Transfer Operations

#### transfer

Transfer compressed tokens between accounts.

```typescript
import { transfer } from "@lightprotocol/compressed-token";

const signature = await transfer(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  amount: number | bigint,
  owner: Signer,
  toAddress: PublicKey
): Promise<string>;
```

**Example:**
```typescript
const signature = await transfer(
  rpc,
  payer,
  mint,
  500_000_000,  // 0.5 tokens with 9 decimals
  sender,
  recipient
);
```

---

#### transferDelegated

Transfer tokens as a delegate.

```typescript
import { transferDelegated } from "@lightprotocol/compressed-token";

const signature = await transferDelegated(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  amount: number | bigint,
  delegate: Signer,
  toAddress: PublicKey
): Promise<string>;
```

---

### Compression Operations

#### compress

Compress SPL tokens to compressed format.

```typescript
import { compress } from "@lightprotocol/compressed-token";

const signature = await compress(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  amount: number | bigint,
  owner: Signer,
  toAddress: PublicKey,
  sourceTokenAccount: PublicKey
): Promise<string>;
```

---

#### compressSplTokenAccount

Compress an entire SPL token account (with optional amount to keep).

```typescript
import { compressSplTokenAccount } from "@lightprotocol/compressed-token";

const signature = await compressSplTokenAccount(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  owner: Signer,
  tokenAccount: PublicKey,
  remainingAmount?: number | bigint  // Amount to keep in SPL format
): Promise<string>;
```

**Example:**
```typescript
// Compress entire account
const sig = await compressSplTokenAccount(rpc, payer, mint, owner, tokenAccount);

// Keep 100 tokens in SPL format
const sig = await compressSplTokenAccount(
  rpc, payer, mint, owner, tokenAccount, 100_000_000_000
);
```

---

#### decompress

Decompress tokens back to SPL format.

```typescript
import { decompress } from "@lightprotocol/compressed-token";

const signature = await decompress(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  amount: number | bigint,
  owner: Signer,
  toAddress: PublicKey  // SPL token account recipient
): Promise<string>;
```

---

### Delegation Operations

#### approve

Approve a delegate to transfer tokens.

```typescript
import { approve } from "@lightprotocol/compressed-token";

const signature = await approve(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  amount: number | bigint,
  owner: Signer,
  delegate: PublicKey
): Promise<string>;
```

---

#### revoke

Revoke delegation from an account.

```typescript
import { revoke } from "@lightprotocol/compressed-token";

const signature = await revoke(
  rpc: Rpc,
  payer: Signer,
  mint: PublicKey,
  owner: Signer
): Promise<string>;
```

---

### Query Operations

#### getCompressedTokenAccountsByOwner

Get all compressed token accounts for an owner.

```typescript
const accounts = await rpc.getCompressedTokenAccountsByOwner(
  owner: PublicKey,
  options?: { mint?: PublicKey; cursor?: string; limit?: number }
): Promise<{ items: CompressedTokenAccount[]; cursor: string | null }>;
```

**Example:**
```typescript
// Get all token accounts
const allAccounts = await rpc.getCompressedTokenAccountsByOwner(owner.publicKey);

// Get accounts for specific mint
const mintAccounts = await rpc.getCompressedTokenAccountsByOwner(
  owner.publicKey,
  { mint }
);

// Calculate total balance
const totalBalance = mintAccounts.items.reduce(
  (sum, account) => sum + BigInt(account.parsed.amount),
  BigInt(0)
);
```

---

## CLI Commands

### Start Local Test Validator

```bash
light test-validator
```

Starts a local Solana validator with ZK Compression support.

### Common Options

```bash
light --help                    # Show all commands
light test-validator --help     # Show test-validator options
```

---

## Types

### CompressedAccount

```typescript
interface CompressedAccount {
  hash: string;
  address: string | null;
  owner: string;
  lamports: string;
  data: AccountData | null;
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
  parsed: {
    owner: PublicKey;
    mint: PublicKey;
    amount: string;
    delegate: PublicKey | null;
    state: "initialized" | "frozen";
  };
  tree: string;
  leafIndex: number;
  slotCreated: number;
}
```

### Rpc

```typescript
interface Rpc extends Connection {
  // Compression methods
  getCompressedAccount(address?: PublicKey, hash?: string): Promise<CompressedAccount | null>;
  getCompressedAccountsByOwner(owner: PublicKey, options?: QueryOptions): Promise<PaginatedResult<CompressedAccount>>;
  getCompressedTokenAccountsByOwner(owner: PublicKey, options?: TokenQueryOptions): Promise<PaginatedResult<CompressedTokenAccount>>;
  getCompressedTokenAccountsByDelegate(delegate: PublicKey, options?: TokenQueryOptions): Promise<PaginatedResult<CompressedTokenAccount>>;
  getCompressedTokenAccountBalance(hash: string): Promise<{ amount: string }>;
  getCompressedBalance(address?: PublicKey, hash?: string): Promise<{ lamports: string }>;
  getCompressedBalanceByOwner(owner: PublicKey): Promise<{ lamports: string }>;
  getCompressedTokenBalancesByOwner(owner: PublicKey, options?: TokenQueryOptions): Promise<PaginatedResult<TokenBalance>>;
  getCompressedMintTokenHolders(mint: PublicKey, options?: QueryOptions): Promise<PaginatedResult<TokenHolder>>;
  getValidityProof(hashes: string[], newAddresses?: string[]): Promise<ValidityProof>;
  getMultipleCompressedAccounts(addresses?: PublicKey[], hashes?: string[]): Promise<{ items: (CompressedAccount | null)[] }>;
  getMultipleNewAddressProofs(addresses: string[]): Promise<{ items: NewAddressProof[] }>;
  getCompressionSignaturesForAccount(hash: string, options?: QueryOptions): Promise<PaginatedResult<SignatureInfo>>;
  getCompressionSignaturesForAddress(address: string, options?: QueryOptions): Promise<PaginatedResult<SignatureInfo>>;
  getCompressionSignaturesForOwner(owner: string, options?: QueryOptions): Promise<PaginatedResult<SignatureInfo>>;
  getCompressionSignaturesForTokenOwner(owner: string, options?: TokenQueryOptions): Promise<PaginatedResult<SignatureInfo>>;
  getLatestCompressionSignatures(options?: QueryOptions): Promise<PaginatedResult<SignatureInfo>>;
  getLatestNonVotingSignatures(options?: QueryOptions): Promise<PaginatedResult<SignatureInfo>>;
  getTransactionWithCompressionInfo(signature: string): Promise<TransactionWithCompressionInfo | null>;
  getIndexerHealth(maxStaleSlots?: number): Promise<{ status: string }>;
  getIndexerSlot(): Promise<{ slot: number }>;
}
```

---

## Version Compatibility

| Package | Version | Notes |
|---------|---------|-------|
| @lightprotocol/stateless.js | 0.x (alpha) | Core SDK |
| @lightprotocol/compressed-token | 0.x (alpha) | Token operations |
| @solana/web3.js | 1.x | Required peer dependency |
| @coral-xyz/anchor | 0.29+ | For advanced program interaction |

**Note:** The SDK is currently in alpha. Install with `@alpha` tag for latest features:

```bash
npm install @lightprotocol/stateless.js@alpha @lightprotocol/compressed-token@alpha
```
