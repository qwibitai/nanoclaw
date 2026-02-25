# Hybrid Example: Using Anchor with Kit

When you have an Anchor-based project but want to leverage Kit's performance benefits for non-Anchor operations.

## The Problem

Anchor currently requires `@solana/web3.js` v1 and doesn't support Kit. However, you may want Kit's benefits for:
- RPC operations (faster confirmation)
- Non-Anchor transactions (SOL transfers, token ops)
- Better bundle size for parts of your app

## Solution: Hybrid Approach with @solana/compat

Use `@solana/compat` to bridge between v1 types (required by Anchor) and Kit types.

## Setup

```bash
npm install @solana/web3.js @coral-xyz/anchor @solana/kit @solana/compat
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Application                         │
├─────────────────────────┬───────────────────────────────────┤
│    Anchor Operations    │     Non-Anchor Operations         │
│                         │                                   │
│  @solana/web3.js (v1)   │        @solana/kit               │
│  @coral-xyz/anchor      │                                   │
│                         │                                   │
└──────────┬──────────────┴───────────────┬───────────────────┘
           │                               │
           └───────────┬───────────────────┘
                       │
              @solana/compat
              (Bridge Layer)
```

## Implementation

### 1. Shared Configuration

```typescript
// config/solana.ts
import { Connection, Keypair } from '@solana/web3.js';
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
} from '@solana/kit';
import { fromLegacyKeypair } from '@solana/compat';

// RPC URLs
export const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
export const WS_URL = process.env.WS_URL || 'wss://api.mainnet-beta.solana.com';

// v1 Connection (for Anchor)
export const connection = new Connection(RPC_URL, 'confirmed');

// Kit RPC (for non-Anchor operations)
export const rpc = createSolanaRpc(RPC_URL);
export const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);

// Wallet setup - keep both formats
export async function loadWallet(secretKey: Uint8Array) {
  // v1 Keypair for Anchor
  const v1Keypair = Keypair.fromSecretKey(secretKey);

  // Kit Signer for Kit operations
  const kitSigner = await fromLegacyKeypair(v1Keypair);

  return { v1Keypair, kitSigner };
}
```

### 2. Anchor Program Interactions (Using v1)

```typescript
// services/anchor-program.ts
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { connection } from '../config/solana';
import { IDL, MyProgram } from '../idl/my_program';

const PROGRAM_ID = new PublicKey('YourProgramId...');

export function createProgram(wallet: Keypair): Program<MyProgram> {
  const provider = new AnchorProvider(
    connection,
    new Wallet(wallet),
    { commitment: 'confirmed' }
  );

  return new Program(IDL, PROGRAM_ID, provider);
}

// Anchor instruction - uses v1 types
export async function initializeAccount(
  program: Program<MyProgram>,
  payer: Keypair,
  accountKeypair: Keypair
) {
  const tx = await program.methods
    .initialize()
    .accounts({
      myAccount: accountKeypair.publicKey,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer, accountKeypair])
    .rpc();

  return tx;
}
```

### 3. Non-Anchor Operations (Using Kit)

```typescript
// services/kit-operations.ts
import {
  address,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  pipe,
  lamports,
  KeyPairSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { rpc, rpcSubscriptions } from '../config/solana';

// SOL transfer - uses Kit for better performance
export async function transferSol(
  sender: KeyPairSigner,
  recipient: string,
  amount: bigint
): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(sender.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        getTransferSolInstruction({
          source: sender,
          destination: address(recipient),
          amount: lamports(amount),
        }),
        m
      )
  );

  const signedTx = await signTransactionMessageWithSigners(tx);

  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  await sendAndConfirm(signedTx, { commitment: 'confirmed' });

  return getSignatureFromTransaction(signedTx);
}

// Watch account with Kit's faster subscriptions
export async function watchAccount(
  accountAddress: string,
  onUpdate: (data: any) => void,
  abortSignal: AbortSignal
) {
  const notifications = await rpcSubscriptions
    .accountNotifications(address(accountAddress), {
      commitment: 'confirmed',
      encoding: 'base64',
    })
    .subscribe({ abortSignal });

  for await (const notification of notifications) {
    onUpdate(notification.value);
  }
}
```

### 4. Bridging When Needed

```typescript
// utils/compat.ts
import { PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import { Address, KeyPairSigner } from '@solana/kit';
import {
  fromLegacyPublicKey,
  toLegacyPublicKey,
  fromLegacyKeypair,
  fromVersionedTransaction,
} from '@solana/compat';

// Convert v1 PublicKey to Kit Address
export function toKitAddress(pubkey: PublicKey): Address {
  return fromLegacyPublicKey(pubkey);
}

// Convert Kit Address to v1 PublicKey
export function toV1PublicKey(address: Address): PublicKey {
  return toLegacyPublicKey(address);
}

// Convert v1 Keypair to Kit Signer
export async function toKitSigner(keypair: Keypair): Promise<KeyPairSigner> {
  return fromLegacyKeypair(keypair);
}

// Example: Convert Anchor program account to Kit-compatible
export function convertAnchorAccount(
  anchorAccount: { publicKey: PublicKey; account: any }
) {
  return {
    address: fromLegacyPublicKey(anchorAccount.publicKey),
    data: anchorAccount.account,
  };
}
```

### 5. Combined Usage Example

```typescript
// app.ts
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadWallet, connection } from './config/solana';
import { createProgram, initializeAccount } from './services/anchor-program';
import { transferSol, watchAccount } from './services/kit-operations';
import { toKitAddress } from './utils/compat';

async function main() {
  // Load wallet - get both v1 and Kit formats
  const secretKey = bs58.decode(process.env.PRIVATE_KEY!);
  const { v1Keypair, kitSigner } = await loadWallet(secretKey);

  // Create Anchor program with v1 keypair
  const program = createProgram(v1Keypair);

  // === ANCHOR OPERATION ===
  // Initialize an account using Anchor (requires v1)
  const newAccount = Keypair.generate();
  console.log('Initializing Anchor account...');
  const anchorTx = await initializeAccount(program, v1Keypair, newAccount);
  console.log('Anchor TX:', anchorTx);

  // === KIT OPERATION ===
  // Send SOL using Kit (faster confirmation)
  console.log('Sending SOL with Kit...');
  const kitTx = await transferSol(
    kitSigner,
    'RecipientAddress...',
    1_000_000n // 0.001 SOL
  );
  console.log('Kit TX:', kitTx);

  // === HYBRID: Watch Anchor account with Kit subscriptions ===
  const abortController = new AbortController();

  // Convert Anchor account address to Kit format
  const accountToWatch = toKitAddress(newAccount.publicKey);

  console.log('Watching account with Kit subscriptions...');
  watchAccount(
    accountToWatch,
    (data) => {
      console.log('Account updated:', data);
    },
    abortController.signal
  );

  // Cleanup after 60 seconds
  setTimeout(() => {
    abortController.abort();
    console.log('Done');
  }, 60000);
}

main().catch(console.error);
```

## When to Use Which

| Operation | Use |
|-----------|-----|
| Anchor program calls | v1 (required) |
| SOL transfers | Kit (faster) |
| Token operations (with Anchor) | v1 |
| Token operations (standalone) | Kit |
| RPC subscriptions | Kit (better pattern) |
| Reading accounts | Either (Kit has better types) |
| Transaction confirmation | Kit (~200ms faster) |

## Performance Comparison

```
Operation                  | v1      | Kit     | Difference
---------------------------+---------+---------+------------
SOL Transfer (confirmation)| ~2.5s   | ~2.3s   | ~200ms faster
Keypair generation        | ~10ms   | ~1ms    | 10x faster
Transaction signing       | ~5ms    | ~0.5ms  | 10x faster
Bundle size (tree-shaken) | 311KB   | 226KB   | 26% smaller
```

## Common Issues

### 1. Type Mismatches

```typescript
// ERROR: Anchor expects v1 PublicKey
program.methods.doSomething().accounts({
  user: kitAddress, // Won't work!
});

// SOLUTION: Convert Kit address to v1
import { toLegacyPublicKey } from '@solana/compat';
program.methods.doSomething().accounts({
  user: toLegacyPublicKey(kitAddress),
});
```

### 2. Transaction Mixing

Don't mix v1 and Kit transactions:

```typescript
// BAD: Trying to add Kit instruction to v1 Transaction
const v1Tx = new Transaction();
v1Tx.add(kitInstruction); // Won't work!

// GOOD: Keep them separate
// Use v1 for Anchor, Kit for non-Anchor
```

### 3. Signer Confusion

```typescript
// Anchor needs v1 Keypair
await program.methods.init().signers([v1Keypair]).rpc();

// Kit needs KeyPairSigner
const signed = await signTransactionMessageWithSigners(tx); // Uses kitSigner embedded in tx
```

## Best Practices

1. **Separate concerns**: Keep Anchor operations in dedicated modules using v1
2. **Convert at boundaries**: Use compat only when crossing v1/Kit boundaries
3. **Prefer Kit for new code**: If not Anchor-related, use Kit
4. **Watch for Anchor updates**: Anchor may support Kit in future versions
5. **Test both paths**: Ensure both v1 and Kit operations work correctly
