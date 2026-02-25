# Solana Kit Packages Reference

Complete reference for all packages in the `@solana/kit` ecosystem.

## Installation Strategy

### Full Kit (Recommended for most projects)
```bash
npm install @solana/kit
```

### Individual Packages (For minimal bundle size)
```bash
npm install @solana/rpc @solana/signers @solana/transactions
```

### Program Packages
```bash
npm install @solana-program/system @solana-program/token
```

---

## Core Packages

### @solana/kit
The main entry point that re-exports all core functionality.

```typescript
import {
  // RPC
  createSolanaRpc,
  createSolanaRpcSubscriptions,

  // Signers
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,

  // Transactions
  createTransactionMessage,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,

  // Addresses
  address,
  getAddressFromPublicKey,

  // Utilities
  lamports,
  pipe,
} from "@solana/kit";
```

---

### @solana/rpc
HTTP RPC client for Solana nodes.

```typescript
import { createSolanaRpc } from "@solana/rpc";

const rpc = createSolanaRpc("https://api.devnet.solana.com");

// All RPC methods available
await rpc.getSlot().send();
await rpc.getBalance(address).send();
await rpc.getLatestBlockhash().send();
await rpc.getAccountInfo(address).send();
await rpc.getMultipleAccounts([addr1, addr2]).send();
await rpc.getTransaction(signature).send();
await rpc.getSignaturesForAddress(address).send();
await rpc.simulateTransaction(encodedTx).send();
await rpc.sendTransaction(encodedTx).send();
```

**Key Methods:**
| Method | Description |
|--------|-------------|
| `getSlot()` | Current slot |
| `getBalance(address)` | SOL balance |
| `getLatestBlockhash()` | Recent blockhash |
| `getAccountInfo(address)` | Account data |
| `getMultipleAccounts([...])` | Multiple accounts |
| `getTransaction(sig)` | Transaction details |
| `getSignaturesForAddress(addr)` | Recent signatures |
| `simulateTransaction(tx)` | Simulate without sending |
| `sendTransaction(tx)` | Submit transaction |
| `getTokenAccountsByOwner(owner, filter)` | Token accounts |

---

### @solana/rpc-subscriptions
WebSocket subscriptions for real-time updates.

```typescript
import { createSolanaRpcSubscriptions } from "@solana/rpc-subscriptions";

const rpcSubscriptions = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");

// Account changes
const accountSub = await rpcSubscriptions
  .accountNotifications(address, { commitment: "confirmed" })
  .subscribe({ abortSignal: controller.signal });

for await (const notification of accountSub) {
  console.log("Account changed:", notification);
}

// Slot updates
const slotSub = await rpcSubscriptions.slotNotifications().subscribe();

// Signature status
const sigSub = await rpcSubscriptions
  .signatureNotifications(signature, { commitment: "confirmed" })
  .subscribe();
```

**Subscription Types:**
| Subscription | Event |
|--------------|-------|
| `accountNotifications` | Account data changes |
| `slotNotifications` | Slot updates |
| `signatureNotifications` | Transaction confirmation |
| `programNotifications` | Program account changes |
| `logsNotifications` | Transaction logs |
| `rootNotifications` | Root changes |

---

### @solana/signers
Signing interfaces and implementations.

```typescript
import {
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  createSignerFromKeyPair,
  isKeyPairSigner,
  assertIsKeyPairSigner,
} from "@solana/signers";

// Generate new keypair signer
const signer = await generateKeyPairSigner();

// From existing bytes
const existing = await createKeyPairSignerFromBytes(secretKeyBytes);

// Properties
console.log(signer.address);  // Address string

// Type guards
if (isKeyPairSigner(signer)) {
  // Can sign
}
```

**Signer Types:**
| Type | Description |
|------|-------------|
| `KeyPairSigner` | Full keypair, can sign anything |
| `TransactionSigner` | Can sign transactions |
| `MessageSigner` | Can sign messages |
| `TransactionModifyingSigner` | Can modify then sign |
| `TransactionPartialSigner` | Partial signatures |

---

### @solana/addresses
Address creation and validation.

```typescript
import {
  address,
  getAddressFromPublicKey,
  isAddress,
  assertIsAddress,
  getAddressEncoder,
  getAddressDecoder,
} from "@solana/addresses";

// Create address from string
const addr = address("11111111111111111111111111111111");

// From public key bytes
const fromKey = await getAddressFromPublicKey(publicKeyBytes);

// Validation
if (isAddress(maybeAddress)) {
  // Valid address
}

// Assert valid (throws if not)
assertIsAddress(maybeAddress);

// Encoding
const encoder = getAddressEncoder();
const decoder = getAddressDecoder();
```

---

### @solana/keys
Key generation and cryptographic operations.

```typescript
import {
  generateKeyPair,
  createKeyPairFromBytes,
  getPublicKeyFromPrivateKey,
  isSignature,
  signature,
} from "@solana/keys";

// Generate new keypair
const keyPair = await generateKeyPair();

// From existing secret
const existing = await createKeyPairFromBytes(secretKeyBytes);

// Get public key
const publicKey = await getPublicKeyFromPrivateKey(privateKey);

// Signature utilities
const sig = signature("...");
if (isSignature(maybeSig)) {
  // Valid signature
}
```

---

### @solana/transactions
Transaction compilation and wire format.

```typescript
import {
  compileTransaction,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
} from "@solana/transactions";

// Compile transaction message to wire format
const compiledTx = compileTransaction(signedTransactionMessage);

// Encode for RPC
const encoded = getBase64EncodedWireTransaction(compiledTx);

// Decode transaction
const decoder = getTransactionDecoder();
const decoded = decoder.decode(encodedBytes);
```

---

### @solana/transaction-messages
Transaction message building.

```typescript
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  prependTransactionMessageInstruction,
  prependTransactionMessageInstructions,
} from "@solana/transaction-messages";

// Create message
const msg = createTransactionMessage({ version: 0 });

// Set fee payer
const withPayer = setTransactionMessageFeePayer(payerAddress, msg);

// Set lifetime (choose one)
const withBlockhash = setTransactionMessageLifetimeUsingBlockhash(
  { blockhash, lastValidBlockHeight },
  withPayer
);
// OR
const withNonce = setTransactionMessageLifetimeUsingDurableNonce(
  { nonce, nonceAccountAddress, nonceAuthorityAddress },
  withPayer
);

// Add instructions
const withInstructions = appendTransactionMessageInstruction(instruction, withBlockhash);
```

---

### @solana/accounts
Account fetching and type utilities.

```typescript
import {
  fetchEncodedAccount,
  fetchEncodedAccounts,
  assertAccountExists,
  assertAccountsExist,
  decodeAccount,
} from "@solana/accounts";

// Fetch single account
const account = await fetchEncodedAccount(rpc, address);
if (account.exists) {
  console.log(account.lamports);
  console.log(account.data);  // Uint8Array
  console.log(account.programAddress);
}

// Fetch multiple
const accounts = await fetchEncodedAccounts(rpc, [addr1, addr2]);

// Assert exists (throws if not)
assertAccountExists(account);

// Decode with custom decoder
const decoded = decodeAccount(account, myDecoder);
```

---

### @solana/codecs
Data serialization and deserialization.

```typescript
import {
  getStructCodec,
  getU8Codec,
  getU16Codec,
  getU32Codec,
  getU64Codec,
  getI64Codec,
  getBooleanCodec,
  getStringCodec,
  getBytesCodec,
  getArrayCodec,
  getOptionCodec,
  getTupleCodec,
  getEnumCodec,
} from "@solana/codecs";

// Define struct codec
const myAccountCodec = getStructCodec([
  ["discriminator", getU8Codec()],
  ["owner", getBytesCodec({ size: 32 })],
  ["balance", getU64Codec()],
  ["isInitialized", getBooleanCodec()],
  ["name", getStringCodec({ size: getU32Codec() })],
]);

// Encode
const encoded = myAccountCodec.encode({
  discriminator: 1,
  owner: ownerBytes,
  balance: 1000n,
  isInitialized: true,
  name: "My Account",
});

// Decode
const decoded = myAccountCodec.decode(accountData);
```

**Codec Types:**
| Codec | Type |
|-------|------|
| `getU8Codec()` | `number` (0-255) |
| `getU16Codec()` | `number` (0-65535) |
| `getU32Codec()` | `number` |
| `getU64Codec()` | `bigint` |
| `getI64Codec()` | `bigint` (signed) |
| `getBooleanCodec()` | `boolean` |
| `getStringCodec()` | `string` |
| `getBytesCodec()` | `Uint8Array` |
| `getArrayCodec()` | `T[]` |
| `getOptionCodec()` | `T \| null` |

---

### @solana/errors
Error identification and handling.

```typescript
import {
  isSolanaError,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SOLANA_ERROR__RPC__SERVER_ERROR,
} from "@solana/errors";

try {
  await sendAndConfirm(tx);
} catch (error) {
  if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS)) {
    console.error("Not enough SOL");
  } else if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)) {
    console.error("Blockhash expired, retry");
  } else if (isSolanaError(error)) {
    console.error("Solana error:", error.context);
  }
}
```

---

## Program Packages

### @solana-program/system
System Program instructions.

```typescript
import {
  getTransferSolInstruction,
  getCreateAccountInstruction,
  getAssignInstruction,
  getAllocateInstruction,
  getCreateAccountWithSeedInstruction,
} from "@solana-program/system";

// Transfer SOL
const transfer = getTransferSolInstruction({
  source: senderSigner,
  destination: recipientAddress,
  amount: lamports(1_000_000_000n),
});

// Create account
const create = getCreateAccountInstruction({
  payer: payerSigner,
  newAccount: newAccountSigner,
  lamports: rentLamports,
  space: accountSpace,
  programAddress: ownerProgram,
});
```

---

### @solana-program/token
SPL Token Program instructions.

```typescript
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getInitializeMintInstruction,
  getMintToInstruction,
  getTransferInstruction,
  getBurnInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintSize,
  getTokenSize,
} from "@solana-program/token";

// Find ATA
const [ata] = await findAssociatedTokenPda({
  mint: mintAddress,
  owner: ownerAddress,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});

// Initialize mint
const initMint = getInitializeMintInstruction({
  mint: mintAddress,
  decimals: 9,
  mintAuthority: authorityAddress,
  freezeAuthority: null,
});

// Mint tokens
const mintTo = getMintToInstruction({
  mint: mintAddress,
  token: ataAddress,
  mintAuthority: authoritySigner,
  amount: 1000n * 10n ** 9n,
});

// Transfer tokens
const transfer = getTransferInstruction({
  source: sourceAta,
  destination: destAta,
  authority: ownerSigner,
  amount: 100n * 10n ** 9n,
});
```

---

### @solana-program/compute-budget
Compute budget instructions.

```typescript
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

// Set compute units
const setLimit = getSetComputeUnitLimitInstruction({
  units: 200_000,
});

// Set priority fee
const setPrice = getSetComputeUnitPriceInstruction({
  microLamports: 1000n,
});

// Always prepend to transaction
const tx = pipe(
  createTransactionMessage({ version: 0 }),
  // ... fee payer and blockhash
  (tx) => prependTransactionMessageInstructions([setLimit, setPrice], tx),
  (tx) => appendTransactionMessageInstruction(mainInstruction, tx),
);
```

---

### @solana-program/memo
Memo Program instructions.

```typescript
import { getMemoInstruction } from "@solana-program/memo";

const memo = getMemoInstruction({
  memo: "Hello, Solana!",
  signers: [signer],
});
```

---

## Compatibility

### @solana/compat
Bridge between Kit and legacy web3.js 1.x.

```typescript
import {
  fromLegacyKeypair,
  toLegacyKeypair,
  fromLegacyPublicKey,
  toLegacyPublicKey,
  fromLegacyTransaction,
  toLegacyTransaction,
} from "@solana/compat";

// Legacy Keypair → Kit Signer
const kitSigner = fromLegacyKeypair(legacyKeypair);

// Kit Signer → Legacy Keypair
const legacyKp = await toLegacyKeypair(kitSigner);

// Legacy PublicKey → Kit Address
const kitAddress = fromLegacyPublicKey(legacyPublicKey);

// Kit Address → Legacy PublicKey
const legacyPk = toLegacyPublicKey(kitAddress);
```
