# Migration Example: Basic SOL Transfer

Complete before/after example of sending SOL from one account to another.

## v1 Implementation (@solana/web3.js)

```typescript
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';

async function sendSol() {
  // 1. Create connection
  const connection = new Connection(
    'https://api.mainnet-beta.solana.com',
    'confirmed'
  );

  // 2. Load sender keypair from secret key
  const secretKey = process.env.PRIVATE_KEY!;
  const sender = Keypair.fromSecretKey(bs58.decode(secretKey));

  // 3. Define recipient
  const recipient = new PublicKey('RecipientAddress111111111111111111111111111');

  // 4. Get latest blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  // 5. Create transaction
  const transaction = new Transaction();

  // 6. Add transfer instruction
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: recipient,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    })
  );

  // 7. Set transaction properties
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = sender.publicKey;

  // 8. Sign and send
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [sender]
  );

  console.log('Transaction signature:', signature);
  console.log('Sender:', sender.publicKey.toBase58());
}

sendSol();
```

## Kit Implementation (@solana/kit)

```typescript
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  address,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  pipe,
  lamports,
  getBase58Encoder,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';

async function sendSol() {
  // 1. Create RPC clients (separate concerns)
  const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
  const rpcSubscriptions = createSolanaRpcSubscriptions(
    'wss://api.mainnet-beta.solana.com'
  );

  // 2. Load sender keypair (async with WebCrypto)
  const secretKey = process.env.PRIVATE_KEY!;
  const sender = await createKeyPairSignerFromBytes(
    getBase58Encoder().encode(secretKey)
  );

  // 3. Define recipient (string-based address)
  const recipient = address('RecipientAddress111111111111111111111111111');

  // 4. Get latest blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  // 5-7. Create transaction with functional composition
  const transactionMessage = pipe(
    // Create versioned transaction message
    createTransactionMessage({ version: 0 }),

    // Set fee payer
    (tx) => setTransactionMessageFeePayer(sender.address, tx),

    // Set blockhash for lifetime
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),

    // Add transfer instruction
    (tx) =>
      appendTransactionMessageInstruction(
        getTransferSolInstruction({
          source: sender, // Signer included in instruction
          destination: recipient,
          amount: lamports(100_000_000n), // 0.1 SOL in lamports (bigint)
        }),
        tx
      )
  );

  // 8. Sign transaction
  const signedTransaction = await signTransactionMessageWithSigners(
    transactionMessage
  );

  // Create send function with factory
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  // Send and confirm
  await sendAndConfirmTransaction(signedTransaction, {
    commitment: 'confirmed',
  });

  // Get signature
  const signature = getSignatureFromTransaction(signedTransaction);

  console.log('Transaction signature:', signature);
  console.log('Sender:', sender.address);
}

sendSol();
```

## Key Differences Explained

| Aspect | v1 | Kit |
|--------|-----|-----|
| **Connection** | Single `Connection` class | Separate `rpc` and `rpcSubscriptions` |
| **Keypair** | `Keypair.fromSecretKey()` (sync) | `createKeyPairSignerFromBytes()` (async) |
| **PublicKey** | `new PublicKey()` class | `address()` string type |
| **Transaction** | Mutable `Transaction` class | Immutable with `pipe()` |
| **Instructions** | `transaction.add()` | `appendTransactionMessageInstruction()` |
| **Amounts** | `number` | `bigint` with `lamports()` |
| **Signing** | `sendAndConfirmTransaction()` all-in-one | Separate sign then send |
| **RPC calls** | Direct method calls | Method chaining with `.send()` |

## Step-by-Step Migration

### 1. Update Imports

```typescript
// Remove
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';

// Add
import { createSolanaRpc, address, createKeyPairSignerFromBytes, ... } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
```

### 2. Convert Connection

```typescript
// Before
const connection = new Connection(url, 'confirmed');

// After
const rpc = createSolanaRpc(url);
const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
```

### 3. Convert Keypair

```typescript
// Before
const keypair = Keypair.fromSecretKey(bs58.decode(secret));

// After
const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(secret));
```

### 4. Convert Addresses

```typescript
// Before
const pubkey = new PublicKey(addressString);

// After
const addr = address(addressString);
```

### 5. Convert Transaction Building

```typescript
// Before
const tx = new Transaction();
tx.add(instruction);
tx.recentBlockhash = blockhash;
tx.feePayer = payer;

// After
const tx = pipe(
  createTransactionMessage({ version: 0 }),
  tx => setTransactionMessageFeePayer(payer, tx),
  tx => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  tx => appendTransactionMessageInstruction(instruction, tx),
);
```

### 6. Convert Amounts

```typescript
// Before
const amount = 0.1 * LAMPORTS_PER_SOL;

// After
const amount = lamports(100_000_000n); // Use bigint
```

### 7. Convert Send/Confirm

```typescript
// Before
const signature = await sendAndConfirmTransaction(connection, tx, [keypair]);

// After
const signedTx = await signTransactionMessageWithSigners(tx);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
await sendAndConfirm(signedTx, { commitment: 'confirmed' });
const signature = getSignatureFromTransaction(signedTx);
```

## Common Gotchas

1. **Forgot `.send()`**: All RPC calls in Kit need `.send()` at the end
2. **Sync vs Async Keypair**: Kit keypair creation is always async
3. **BigInt amounts**: Use `n` suffix (e.g., `100n`) or `BigInt()` for amounts
4. **Signer in instruction**: Kit instructions often include the signer directly
5. **Type errors**: Kit's type system will catch missing blockhash/feePayer at compile time
