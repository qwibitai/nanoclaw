# API Mappings: @solana/web3.js (v1) → @solana/kit

Complete reference for migrating from legacy web3.js to Kit.

## Package Imports

### v1 (Legacy)
```typescript
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
```

### Kit
```typescript
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  pipe,
  lamports,
} from '@solana/kit';

import { getTransferSolInstruction } from '@solana-program/system';
```

---

## Type Mappings

| v1 Type | Kit Type | Notes |
|---------|----------|-------|
| `PublicKey` | `Address` | String-based, not a class |
| `Keypair` | `KeyPairSigner` | Async creation, uses WebCrypto |
| `Connection` | `Rpc` / `RpcSubscriptions` | Split into separate concerns |
| `Transaction` | `TransactionMessage` | Functional builders |
| `VersionedTransaction` | `Transaction` (compiled) | Versioned by default |
| `TransactionInstruction` | `IInstruction` | Interface-based |
| `Finality` | `Commitment` | Same values |
| `number` (lamports) | `Lamports` (bigint) | Use `lamports()` helper |

---

## Connection / RPC

### Creating a Connection

```typescript
// v1
const connection = new Connection('https://api.mainnet-beta.solana.com', {
  commitment: 'confirmed',
  wsEndpoint: 'wss://api.mainnet-beta.solana.com',
});

// Kit
const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
const rpcSubscriptions = createSolanaRpcSubscriptions('wss://api.mainnet-beta.solana.com');
```

### RPC Method Calls

```typescript
// v1
const balance = await connection.getBalance(publicKey);
const accountInfo = await connection.getAccountInfo(publicKey);
const slot = await connection.getSlot();
const blockHeight = await connection.getBlockHeight();

// Kit - note the .send() suffix!
const { value: balance } = await rpc.getBalance(address).send();
const { value: accountInfo } = await rpc.getAccountInfo(address, { encoding: 'base64' }).send();
const slot = await rpc.getSlot().send();
const blockHeight = await rpc.getBlockHeight().send();
```

### Get Latest Blockhash

```typescript
// v1
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

// Kit
const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
// latestBlockhash.blockhash
// latestBlockhash.lastValidBlockHeight
```

### Get Token Accounts

```typescript
// v1
const tokenAccounts = await connection.getTokenAccountsByOwner(
  ownerPublicKey,
  { programId: TOKEN_PROGRAM_ID }
);

// Kit
const { value: tokenAccounts } = await rpc.getTokenAccountsByOwner(
  ownerAddress,
  { programId: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
  { encoding: 'jsonParsed' }
).send();
```

### Get Multiple Accounts

```typescript
// v1
const accounts = await connection.getMultipleAccountsInfo(publicKeys);

// Kit
const { value: accounts } = await rpc.getMultipleAccounts(addresses, {
  encoding: 'base64'
}).send();
```

---

## Keypairs / Signers

### Generate New Keypair

```typescript
// v1 (synchronous)
const keypair = Keypair.generate();
console.log(keypair.publicKey.toBase58());
console.log(keypair.secretKey);

// Kit (async - uses WebCrypto)
const keypairSigner = await generateKeyPairSigner();
console.log(keypairSigner.address);
// Note: private key is protected from accidental logging
```

### From Secret Key

```typescript
// v1
import bs58 from 'bs58';
const keypair = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
// or from Uint8Array
const keypair = Keypair.fromSecretKey(secretKeyBytes);

// Kit
import { getBase58Encoder } from '@solana/kit';
const keypairSigner = await createKeyPairSignerFromBytes(
  getBase58Encoder().encode(secretKeyBase58)
);
// or from Uint8Array
const keypairSigner = await createKeyPairSignerFromBytes(secretKeyBytes);
```

### From Seed

```typescript
// v1
const keypair = Keypair.fromSeed(seed);

// Kit
import { createKeyPairFromBytes } from '@solana/keys';
const keyPair = await createKeyPairFromBytes(seed);
const signer = await createSignerFromKeyPair(keyPair);
```

---

## Public Keys / Addresses

### Creating

```typescript
// v1
const pubkey = new PublicKey('So11111111111111111111111111111111111111112');
const pubkeyFromBuffer = new PublicKey(buffer);

// Kit
const addr = address('So11111111111111111111111111111111111111112');
// From bytes, use base58 encoding
import { getBase58Encoder } from '@solana/kit';
const addr = address(getBase58Encoder().encode(buffer));
```

### Program Derived Addresses (PDAs)

```typescript
// v1
const [pda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('seed'), userPubkey.toBuffer()],
  programId
);

// Kit
import { getProgramDerivedAddress } from '@solana/addresses';
const [pda, bump] = await getProgramDerivedAddress({
  programAddress: address(programIdString),
  seeds: [
    new TextEncoder().encode('seed'),
    getAddressEncoder().encode(userAddress),
  ],
});
```

### Associated Token Address

```typescript
// v1
import { getAssociatedTokenAddress } from '@solana/spl-token';
const ata = await getAssociatedTokenAddress(mint, owner);

// Kit
import { findAssociatedTokenPda } from '@solana-program/token';
const [ata] = await findAssociatedTokenPda({
  mint: mintAddress,
  owner: ownerAddress,
  tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
});
```

---

## Transactions

### Building a Transaction

```typescript
// v1
const transaction = new Transaction();
transaction.add(
  SystemProgram.transfer({
    fromPubkey: sender.publicKey,
    toPubkey: recipient,
    lamports: 1_000_000,
  })
);
transaction.recentBlockhash = blockhash;
transaction.feePayer = sender.publicKey;

// Kit (functional composition)
import { getTransferSolInstruction } from '@solana-program/system';

const transactionMessage = pipe(
  createTransactionMessage({ version: 0 }),
  tx => setTransactionMessageFeePayer(sender.address, tx),
  tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
  tx => appendTransactionMessageInstruction(
    getTransferSolInstruction({
      source: sender,
      destination: address(recipientString),
      amount: lamports(1_000_000n),
    }),
    tx
  ),
);
```

### Multiple Instructions

```typescript
// v1
transaction.add(instruction1, instruction2, instruction3);

// Kit
import { appendTransactionMessageInstructions } from '@solana/kit';

const tx = pipe(
  createTransactionMessage({ version: 0 }),
  tx => setTransactionMessageFeePayer(payer.address, tx),
  tx => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  tx => appendTransactionMessageInstructions([
    instruction1,
    instruction2,
    instruction3,
  ], tx),
);
```

### Setting Compute Budget

```typescript
// v1
import { ComputeBudgetProgram } from '@solana/web3.js';

transaction.add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })
);

// Kit
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';

const tx = pipe(
  createTransactionMessage({ version: 0 }),
  tx => setTransactionMessageFeePayer(payer.address, tx),
  tx => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  tx => appendTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units: 200_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
    // ... other instructions
  ], tx),
);
```

---

## Signing & Sending

### Sign Transaction

```typescript
// v1
transaction.sign(keypair);
// or partial sign
transaction.partialSign(keypair);

// Kit
const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
```

### Send Transaction

```typescript
// v1
const signature = await connection.sendTransaction(transaction, [keypair]);
// or with confirmation
const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);

// Kit
const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions,
});

const signedTx = await signTransactionMessageWithSigners(transactionMessage);
await sendAndConfirmTransaction(signedTx, { commitment: 'confirmed' });

// Get signature
import { getSignatureFromTransaction } from '@solana/kit';
const signature = getSignatureFromTransaction(signedTx);
```

### Raw Transaction

```typescript
// v1
const rawTx = transaction.serialize();
const signature = await connection.sendRawTransaction(rawTx);

// Kit
import { getBase64EncodedWireTransaction } from '@solana/kit';
const wireTransaction = getBase64EncodedWireTransaction(signedTx);
const signature = await rpc.sendTransaction(wireTransaction, {
  encoding: 'base64',
}).send();
```

---

## Subscriptions

### Account Change

```typescript
// v1
const subscriptionId = connection.onAccountChange(
  publicKey,
  (accountInfo, context) => {
    console.log('Account changed:', accountInfo);
  },
  'confirmed'
);
// Later: connection.removeAccountChangeListener(subscriptionId);

// Kit (uses AsyncIterator pattern)
const abortController = new AbortController();

async function subscribeToAccount() {
  const notifications = await rpcSubscriptions
    .accountNotifications(addr, { commitment: 'confirmed' })
    .subscribe({ abortSignal: abortController.signal });

  for await (const notification of notifications) {
    console.log('Account changed:', notification);
  }
}

subscribeToAccount();
// Later: abortController.abort();
```

### Signature Confirmation

```typescript
// v1
const subscriptionId = connection.onSignature(
  signature,
  (result, context) => {
    console.log('Confirmed:', result);
  },
  'confirmed'
);

// Kit
const notifications = await rpcSubscriptions
  .signatureNotifications(signature, { commitment: 'confirmed' })
  .subscribe({ abortSignal: abortController.signal });

for await (const notification of notifications) {
  console.log('Signature status:', notification);
  break; // Usually only need one confirmation
}
```

---

## Common Helpers

### Lamports Conversion

```typescript
// v1
const lamports = amount * LAMPORTS_PER_SOL;

// Kit
import { lamports as toLamports } from '@solana/kit';
const amount = toLamports(1_000_000_000n); // Type-safe lamports
// or for SOL conversion
const solToLamports = (sol: number) => lamports(BigInt(sol * 1_000_000_000));
```

### Address Validation

```typescript
// v1
try {
  new PublicKey(addressString);
  console.log('Valid');
} catch {
  console.log('Invalid');
}

// Kit
import { isAddress } from '@solana/addresses';
if (isAddress(addressString)) {
  console.log('Valid');
} else {
  console.log('Invalid');
}
```

---

## Interoperability with @solana/compat

When you need to use both v1 and Kit:

```typescript
import {
  fromLegacyPublicKey,
  toLegacyPublicKey,
  fromLegacyKeypair,
  fromVersionedTransaction,
} from '@solana/compat';

// PublicKey ↔ Address
const kitAddress = fromLegacyPublicKey(legacyPublicKey);
const legacyPubkey = toLegacyPublicKey(kitAddress);

// Keypair → KeyPairSigner
const kitSigner = await fromLegacyKeypair(legacyKeypair);

// VersionedTransaction → Kit Transaction
const kitTransaction = fromVersionedTransaction(legacyVersionedTx);
```
