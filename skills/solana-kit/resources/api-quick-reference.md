# Solana Kit API Quick Reference

A fast lookup table for common operations.

## RPC Setup

```typescript
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

const rpc = createSolanaRpc("https://api.devnet.solana.com");
const rpcSubscriptions = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");
```

## Signers

| Operation | Code |
|-----------|------|
| Generate new | `await generateKeyPairSigner()` |
| From bytes | `await createKeyPairSignerFromBytes(bytes)` |
| Get address | `signer.address` |

## Addresses

| Operation | Code |
|-----------|------|
| From string | `address("1111...")` |
| Validate | `isAddress(str)` |
| Assert valid | `assertIsAddress(str)` |

## Lamports

| Operation | Code |
|-----------|------|
| Create | `lamports(1_000_000_000n)` |
| SOL to lamports | `lamports(BigInt(sol) * 1_000_000_000n)` |
| Lamports to SOL | `Number(lamportValue) / 1e9` |

## Transaction Building

```typescript
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
} from "@solana/kit";

const tx = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(payer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  (tx) => appendTransactionMessageInstruction(instruction, tx),
);
```

## Common RPC Methods

| Method | Returns | Usage |
|--------|---------|-------|
| `getSlot()` | `bigint` | `await rpc.getSlot().send()` |
| `getBalance(addr)` | `{ value: Lamports }` | `await rpc.getBalance(addr).send()` |
| `getLatestBlockhash()` | `{ value: { blockhash, lastValidBlockHeight } }` | `await rpc.getLatestBlockhash().send()` |
| `getAccountInfo(addr)` | `{ value: Account \| null }` | `await rpc.getAccountInfo(addr).send()` |
| `getMultipleAccounts([...])` | `{ value: (Account \| null)[] }` | `await rpc.getMultipleAccounts([a,b]).send()` |
| `getTransaction(sig)` | `Transaction \| null` | `await rpc.getTransaction(sig).send()` |
| `sendTransaction(tx)` | `Signature` | `await rpc.sendTransaction(encoded).send()` |
| `simulateTransaction(tx)` | `SimulationResult` | `await rpc.simulateTransaction(tx).send()` |

## Signing

| Operation | Code |
|-----------|------|
| Sign all | `await signTransactionMessageWithSigners(tx)` |
| Partial sign | `await partiallySignTransactionMessageWithSigners(tx)` |
| Get signature | `getSignatureFromTransaction(signedTx)` |

## Sending Transactions

| Method | Use Case |
|--------|----------|
| `sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })` | Most common - waits for confirmation |
| `sendTransactionWithoutConfirmingFactory({ rpc })` | Fire and forget |
| `sendAndConfirmDurableNonceTransactionFactory()` | Durable nonce transactions |

```typescript
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
await sendAndConfirm(signedTx, { commitment: "confirmed" });
```

## Account Fetching

| Operation | Code |
|-----------|------|
| Single account | `await fetchEncodedAccount(rpc, address)` |
| Multiple accounts | `await fetchEncodedAccounts(rpc, [addr1, addr2])` |
| Assert exists | `assertAccountExists(account)` |

```typescript
const account = await fetchEncodedAccount(rpc, address);
if (account.exists) {
  console.log(account.lamports);
  console.log(account.data);       // Uint8Array
  console.log(account.programAddress);
}
```

## System Program

```typescript
import { getTransferSolInstruction, getCreateAccountInstruction } from "@solana-program/system";

// Transfer SOL
getTransferSolInstruction({
  source: signerWithLamports,
  destination: recipientAddress,
  amount: lamports(1_000_000_000n),
});

// Create account
getCreateAccountInstruction({
  payer: payerSigner,
  newAccount: newAccountSigner,
  lamports: rentLamports,
  space: BigInt(accountSize),
  programAddress: ownerProgram,
});
```

## Token Program

```typescript
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getInitializeMintInstruction,
  getMintToInstruction,
  getTransferInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintSize,
} from "@solana-program/token";

// Find ATA address
const [ata] = await findAssociatedTokenPda({
  mint: mintAddress,
  owner: ownerAddress,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});

// Get rent for mint
const mintRent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
```

## Compute Budget

```typescript
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

// Always prepend these
prependTransactionMessageInstructions([
  getSetComputeUnitLimitInstruction({ units: 200_000 }),
  getSetComputeUnitPriceInstruction({ microLamports: 1000n }),
], tx);
```

## Codecs

| Type | Codec | TypeScript Type |
|------|-------|-----------------|
| u8 | `getU8Codec()` | `number` |
| u16 | `getU16Codec()` | `number` |
| u32 | `getU32Codec()` | `number` |
| u64 | `getU64Codec()` | `bigint` |
| i64 | `getI64Codec()` | `bigint` |
| bool | `getBooleanCodec()` | `boolean` |
| string | `getStringCodec()` | `string` |
| bytes | `getBytesCodec({ size: n })` | `Uint8Array` |
| pubkey | `getBytesCodec({ size: 32 })` | `Uint8Array` |
| array | `getArrayCodec(itemCodec)` | `T[]` |
| option | `getOptionCodec(codec)` | `T \| null` |
| struct | `getStructCodec([...fields])` | `object` |

## Error Handling

```typescript
import { isSolanaError, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS } from "@solana/errors";

try {
  await sendAndConfirm(tx);
} catch (error) {
  if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS)) {
    // Handle insufficient funds
  } else if (isSolanaError(error)) {
    // Handle other Solana errors
    console.error(error.context);
  }
}
```

## Common Error Codes

| Error | Meaning |
|-------|---------|
| `SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS` | Not enough SOL |
| `SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND` | Blockhash expired |
| `SOLANA_ERROR__TRANSACTION_ERROR__SIGNATURE_VERIFICATION_FAILED` | Bad signature |
| `SOLANA_ERROR__RPC__SERVER_ERROR` | RPC node error |
| `SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND` | Account missing |

## Commitment Levels

| Level | Finality | Speed |
|-------|----------|-------|
| `processed` | Seen by node | Fastest |
| `confirmed` | Voted by supermajority | Recommended |
| `finalized` | Rooted | Slowest, most secure |

## Airdrop (Devnet/Testnet)

```typescript
import { airdropFactory } from "@solana/kit";

const airdrop = airdropFactory({ rpc, rpcSubscriptions });
await airdrop({
  commitment: "confirmed",
  lamports: lamports(2_000_000_000n), // 2 SOL
  recipientAddress: address,
});
```
