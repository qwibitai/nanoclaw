# Migration Example: SPL Token Operations

Complete before/after examples for common SPL Token operations.

## 1. Get Token Balance

### v1 Implementation

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';

async function getTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  const ata = await getAssociatedTokenAddress(mint, owner);
  const account = await getAccount(connection, ata);
  return account.amount;
}

// Usage
const connection = new Connection('https://api.mainnet-beta.solana.com');
const owner = new PublicKey('OwnerAddress...');
const mint = new PublicKey('MintAddress...');
const balance = await getTokenBalance(connection, owner, mint);
console.log('Balance:', balance.toString());
```

### Kit Implementation

```typescript
import {
  createSolanaRpc,
  address,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  fetchToken,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

async function getTokenBalance(
  rpc: ReturnType<typeof createSolanaRpc>,
  owner: string,
  mint: string
): Promise<bigint> {
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const account = await fetchToken(rpc, ata);
  return account.data.amount;
}

// Usage
const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
const balance = await getTokenBalance(rpc, 'OwnerAddress...', 'MintAddress...');
console.log('Balance:', balance.toString());
```

---

## 2. Transfer Tokens

### v1 Implementation

```typescript
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

async function transferTokens(
  connection: Connection,
  sender: Keypair,
  recipient: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<string> {
  const senderAta = await getAssociatedTokenAddress(mint, sender.publicKey);
  const recipientAta = await getAssociatedTokenAddress(mint, recipient);

  const transaction = new Transaction().add(
    createTransferInstruction(
      senderAta,
      recipientAta,
      sender.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = sender.publicKey;

  return await sendAndConfirmTransaction(connection, transaction, [sender]);
}
```

### Kit Implementation

```typescript
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  address,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  pipe,
  KeyPairSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

async function transferTokens(
  rpc: ReturnType<typeof createSolanaRpc>,
  rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>,
  sender: KeyPairSigner,
  recipient: string,
  mint: string,
  amount: bigint
): Promise<string> {
  const mintAddress = address(mint);
  const recipientAddress = address(recipient);

  const [senderAta] = await findAssociatedTokenPda({
    owner: sender.address,
    mint: mintAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const [recipientAta] = await findAssociatedTokenPda({
    owner: recipientAddress,
    mint: mintAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) =>
      appendTransactionMessageInstruction(
        getTransferInstruction({
          source: senderAta,
          destination: recipientAta,
          authority: sender,
          amount,
        }),
        tx
      )
  );

  const signedTransaction = await signTransactionMessageWithSigners(
    transactionMessage
  );

  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  await sendAndConfirmTransaction(signedTransaction, {
    commitment: 'confirmed',
  });

  return getSignatureFromTransaction(signedTransaction);
}
```

---

## 3. Create Associated Token Account

### v1 Implementation

```typescript
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

async function createAta(
  connection: Connection,
  payer: Keypair,
  owner: PublicKey,
  mint: PublicKey
): Promise<{ ata: PublicKey; signature: string }> {
  const ata = await getAssociatedTokenAddress(mint, owner);

  const transaction = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = payer.publicKey;

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [payer]
  );

  return { ata, signature };
}
```

### Kit Implementation

```typescript
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  address,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  pipe,
  KeyPairSigner,
  Address,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

async function createAta(
  rpc: ReturnType<typeof createSolanaRpc>,
  rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>,
  payer: KeyPairSigner,
  owner: string,
  mint: string
): Promise<{ ata: Address; signature: string }> {
  const ownerAddress = address(owner);
  const mintAddress = address(mint);

  const [ata] = await findAssociatedTokenPda({
    owner: ownerAddress,
    mint: mintAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(payer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) =>
      appendTransactionMessageInstruction(
        getCreateAssociatedTokenInstruction({
          payer,
          owner: ownerAddress,
          mint: mintAddress,
          ata,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        }),
        tx
      )
  );

  const signedTransaction = await signTransactionMessageWithSigners(
    transactionMessage
  );

  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  await sendAndConfirmTransaction(signedTransaction, {
    commitment: 'confirmed',
  });

  const signature = getSignatureFromTransaction(signedTransaction);

  return { ata, signature };
}
```

---

## 4. Get All Token Accounts

### v1 Implementation

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

async function getAllTokenAccounts(
  connection: Connection,
  owner: PublicKey
) {
  const accounts = await connection.getTokenAccountsByOwner(owner, {
    programId: TOKEN_PROGRAM_ID,
  });

  return accounts.value.map((account) => ({
    pubkey: account.pubkey.toBase58(),
    data: account.account.data,
  }));
}
```

### Kit Implementation

```typescript
import {
  createSolanaRpc,
  address,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

async function getAllTokenAccounts(
  rpc: ReturnType<typeof createSolanaRpc>,
  owner: string
) {
  const { value: accounts } = await rpc
    .getTokenAccountsByOwner(
      address(owner),
      { programId: TOKEN_PROGRAM_ADDRESS },
      { encoding: 'jsonParsed' }
    )
    .send();

  return accounts.map((account) => ({
    pubkey: account.pubkey,
    data: account.account.data,
  }));
}
```

---

## Package Mapping Summary

| v1 (@solana/spl-token) | Kit (@solana-program/token) |
|------------------------|----------------------------|
| `getAssociatedTokenAddress` | `findAssociatedTokenPda` |
| `getAccount` | `fetchToken` |
| `createTransferInstruction` | `getTransferInstruction` |
| `createAssociatedTokenAccountInstruction` | `getCreateAssociatedTokenInstruction` |
| `TOKEN_PROGRAM_ID` | `TOKEN_PROGRAM_ADDRESS` |
| `ASSOCIATED_TOKEN_PROGRAM_ID` | `ASSOCIATED_TOKEN_PROGRAM_ADDRESS` |
| `getMint` | `fetchMint` |
| `createMint` | `getCreateMintInstruction` |

## Key Migration Notes

1. **Install the right package**: Use `@solana-program/token` instead of `@solana/spl-token`
2. **PDAs return arrays**: Kit PDA functions return `[address, bump]`, destructure the address
3. **Async all the way**: Most Kit operations are async
4. **Authority vs Signer**: Kit instructions take `KeyPairSigner` for authority fields
5. **BigInt amounts**: Token amounts are always `bigint` in Kit
