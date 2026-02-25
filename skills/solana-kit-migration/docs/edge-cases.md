# Edge Cases & Gotchas: Solana Kit Migration

Comprehensive guide to tricky migration scenarios and common pitfalls.

## Table of Contents

1. [Type System Differences](#1-type-system-differences)
2. [Async/Sync Behavior Changes](#2-asyncsync-behavior-changes)
3. [Numeric Type Migration](#3-numeric-type-migration)
4. [RPC Response Handling](#4-rpc-response-handling)
5. [Error Handling Differences](#5-error-handling-differences)
6. [Serialization & Encoding](#6-serialization--encoding)
7. [Transaction Lifetime](#7-transaction-lifetime)
8. [Signer Management](#8-signer-management)
9. [Address Lookup Tables](#9-address-lookup-tables)
10. [Testing Considerations](#10-testing-considerations)

---

## 1. Type System Differences

### PublicKey vs Address

**Edge Case**: Address is a branded string type, not a class.

```typescript
// v1: PublicKey is a class with methods
const pubkey = new PublicKey('...');
pubkey.toBase58(); // Method call
pubkey.toBuffer(); // Method call
pubkey.equals(otherPubkey); // Comparison method

// Kit: Address is just a string
const addr = address('...');
addr; // Already a string, no toBase58()
getAddressEncoder().encode(addr); // For bytes
addr === otherAddr; // Direct comparison works
```

**Gotcha**: You cannot call methods on Kit addresses.

```typescript
// WRONG
const addr = address('...');
console.log(addr.toBase58()); // Error: toBase58 is not a function

// RIGHT
console.log(addr); // It's already a string
```

### Optional vs Required Fields

**Edge Case**: Kit's type system enforces required fields at compile time.

```typescript
// v1: Runtime error if missing
const tx = new Transaction();
tx.add(instruction);
await sendTransaction(tx); // Runtime error: missing blockhash

// Kit: Compile-time error
const tx = createTransactionMessage({ version: 0 });
await signTransactionMessageWithSigners(tx);
// TypeScript Error: Transaction message must have fee payer
```

**Gotcha**: This is a benefit, but requires understanding the types.

---

## 2. Async/Sync Behavior Changes

### Keypair Generation

**Edge Case**: Kit uses WebCrypto, making all key operations async.

```typescript
// v1: Synchronous
const keypair = Keypair.generate();
const derived = Keypair.fromSeed(seed);
const loaded = Keypair.fromSecretKey(bytes);

// Kit: All async
const keypair = await generateKeyPairSigner();
const derived = await createKeyPairSignerFromBytes(seed);
const loaded = await createKeyPairSignerFromBytes(bytes);
```

**Gotcha**: Module-level keypair initialization breaks.

```typescript
// v1: Works
export const DEFAULT_KEYPAIR = Keypair.generate();

// Kit: BROKEN
export const DEFAULT_KEYPAIR = await generateKeyPairSigner(); // SyntaxError

// Kit: SOLUTION
let _defaultKeypair: KeyPairSigner | null = null;
export async function getDefaultKeypair() {
  if (!_defaultKeypair) {
    _defaultKeypair = await generateKeyPairSigner();
  }
  return _defaultKeypair;
}
```

### PDA Derivation

**Edge Case**: PDA functions may be async in Kit.

```typescript
// v1: Synchronous
const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);

// Kit: Async (uses async hash functions)
const [pda, bump] = await getProgramDerivedAddress({
  programAddress: address(programId),
  seeds,
});
```

---

## 3. Numeric Type Migration

### BigInt Everywhere

**Edge Case**: All lamport amounts use BigInt.

```typescript
// v1: number
const lamports = 1000000000;
const balance = await connection.getBalance(pubkey); // Returns number

// Kit: bigint
const amount = 1_000_000_000n; // Note the 'n' suffix
const { value: balance } = await rpc.getBalance(addr).send(); // Returns bigint
```

**Gotcha**: Mixing number and bigint causes errors.

```typescript
// WRONG
const total = balance + 1000; // Error: can't mix bigint and number

// RIGHT
const total = balance + 1000n;
// or
const total = balance + BigInt(1000);
```

### JSON Serialization

**Edge Case**: BigInt doesn't serialize to JSON by default.

```typescript
// PROBLEM
const data = { amount: 1000n };
JSON.stringify(data); // TypeError: Cannot serialize BigInt

// SOLUTION 1: Convert to string
const data = { amount: 1000n.toString() };

// SOLUTION 2: Custom replacer
JSON.stringify(data, (key, value) =>
  typeof value === 'bigint' ? value.toString() : value
);
```

### Slot Numbers

**Edge Case**: Slots are bigint in Kit but number in v1.

```typescript
// v1
const slot: number = await connection.getSlot();

// Kit
const slot: bigint = await rpc.getSlot().send();

// When interfacing
const slotNumber = Number(slot); // Convert if needed (watch for overflow)
```

---

## 4. RPC Response Handling

### The .send() Suffix

**Edge Case**: Every RPC call requires `.send()`.

```typescript
// v1
const balance = await connection.getBalance(pubkey);

// Kit - WRONG
const balance = await rpc.getBalance(addr); // Returns a pending request object!

// Kit - RIGHT
const { value: balance } = await rpc.getBalance(addr).send();
```

**Gotcha**: Forgetting `.send()` returns a request builder, not the result.

### Response Wrapper

**Edge Case**: Most Kit responses are wrapped in `{ value, context }`.

```typescript
// v1: Direct value
const balance = await connection.getBalance(pubkey); // number directly

// Kit: Wrapped
const response = await rpc.getBalance(addr).send();
// response.value - the actual balance
// response.context.slot - the slot when queried
```

**Pattern**: Always destructure the value.

```typescript
const { value: balance } = await rpc.getBalance(addr).send();
const { value: accountInfo } = await rpc.getAccountInfo(addr).send();
const { value: blockhash } = await rpc.getLatestBlockhash().send();
```

### Encoding Requirements

**Edge Case**: Some RPC calls require explicit encoding.

```typescript
// v1: Works without encoding
const info = await connection.getAccountInfo(pubkey);

// Kit: May fail without encoding
const { value: info } = await rpc.getAccountInfo(addr).send();
// Error: "Encoded binary (base 58) data should be less than 128 bytes"

// Kit: Specify encoding
const { value: info } = await rpc.getAccountInfo(addr, {
  encoding: 'base64'
}).send();
```

---

## 5. Error Handling Differences

### Error Types

**Edge Case**: Kit uses `SolanaError` with codes instead of generic errors.

```typescript
// v1: Generic errors
try {
  await connection.sendTransaction(tx);
} catch (error) {
  console.log(error.message);
}

// Kit: Coded errors
import { isSolanaError, SOLANA_ERROR__..., } from '@solana/errors';

try {
  await sendAndConfirmTransaction(signedTx);
} catch (error) {
  if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_EXPIRED)) {
    // Handle expired transaction
  }
}
```

### Transaction Simulation Errors

**Edge Case**: Simulation error format differs.

```typescript
// v1: Error in logs
try {
  await connection.simulateTransaction(tx);
} catch (e) {
  const logs = e.logs; // string[]
}

// Kit: Structured error
const result = await rpc.simulateTransaction(wireTransaction).send();
if (result.value.err) {
  console.log(result.value.err); // Structured error object
  console.log(result.value.logs); // Log messages
}
```

---

## 6. Serialization & Encoding

### Buffer to Uint8Array

**Edge Case**: Kit prefers Uint8Array over Node Buffer.

```typescript
// v1: Uses Buffer
const pubkeyBytes = pubkey.toBuffer(); // Buffer

// Kit: Uses Uint8Array
import { getAddressEncoder } from '@solana/addresses';
const addrBytes = getAddressEncoder().encode(addr); // Uint8Array
```

### Custom Data Serialization

**Edge Case**: Kit has its own codec system.

```typescript
// v1: Using borsh or buffer-layout
import * as borsh from 'borsh';
const data = borsh.serialize(schema, value);

// Kit: Using @solana/codecs
import {
  getStructCodec,
  getU64Codec,
  getUtf8Codec,
} from '@solana/codecs';

const myCodec = getStructCodec([
  ['amount', getU64Codec()],
  ['name', getUtf8Codec()],
]);

const bytes = myCodec.encode({ amount: 100n, name: 'test' });
const decoded = myCodec.decode(bytes);
```

### Base58/Base64 Encoding

**Edge Case**: Use Kit's built-in encoders.

```typescript
// v1: Using bs58 package
import bs58 from 'bs58';
const decoded = bs58.decode(base58String);

// Kit: Built-in encoders
import { getBase58Encoder, getBase64Encoder } from '@solana/codecs';
const decoded = getBase58Encoder().encode(base58String);
```

---

## 7. Transaction Lifetime

### Blockhash Handling

**Edge Case**: Kit enforces transaction lifetime in the type system.

```typescript
// v1: Easy to forget, fails at runtime
const tx = new Transaction();
tx.add(instruction);
// Forgot to set blockhash - runtime error when sending

// Kit: Type system enforces
const tx = createTransactionMessage({ version: 0 });
// Must call setTransactionMessageLifetimeUsingBlockhash
// or setTransactionMessageLifetimeUsingDurableNonce
// before signing - compile error otherwise
```

### Durable Nonces

**Edge Case**: Different API for durable nonce transactions.

```typescript
// v1
tx.recentBlockhash = nonceInfo.nonce;
tx.add(
  SystemProgram.nonceAdvance({
    noncePubkey,
    authorizedPubkey,
  })
);

// Kit
import { setTransactionMessageLifetimeUsingDurableNonce } from '@solana/kit';

const tx = pipe(
  createTransactionMessage({ version: 0 }),
  tx => setTransactionMessageFeePayer(payer, tx),
  tx => setTransactionMessageLifetimeUsingDurableNonce({
    nonce: nonceValue,
    nonceAccountAddress: nonceAddress,
    nonceAuthorityAddress: authorityAddress,
  }, tx),
  // ...
);
```

---

## 8. Signer Management

### Embedded vs Explicit Signers

**Edge Case**: Kit instructions can embed signers.

```typescript
// v1: Signers passed separately
const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: sender.publicKey,
    toPubkey: recipient,
    lamports: 1000,
  })
);
await sendAndConfirmTransaction(connection, tx, [sender]); // Signers here

// Kit: Signer embedded in instruction
const instruction = getTransferSolInstruction({
  source: senderSigner, // KeyPairSigner embedded
  destination: recipientAddress,
  amount: lamports(1000n),
});
const tx = pipe(
  createTransactionMessage({ version: 0 }),
  // ...
  tx => appendTransactionMessageInstruction(instruction, tx),
);
// Signers extracted automatically
const signed = await signTransactionMessageWithSigners(tx);
```

### Multiple Signers

**Edge Case**: Managing multiple signers differs.

```typescript
// v1
await sendAndConfirmTransaction(connection, tx, [payer, account1, account2]);

// Kit: Each instruction has its signers, then sign all
const tx = pipe(
  createTransactionMessage({ version: 0 }),
  tx => setTransactionMessageFeePayer(payer.address, tx),
  tx => appendTransactionMessageInstructions([
    instructionWithSigner1, // Contains account1 signer
    instructionWithSigner2, // Contains account2 signer
  ], tx),
);

// Add fee payer as signer if not in instructions
import { addSignersToTransactionMessage } from '@solana/kit';
const txWithSigners = addSignersToTransactionMessage([payer], tx);
const signed = await signTransactionMessageWithSigners(txWithSigners);
```

---

## 9. Address Lookup Tables

### ALT Loading

**Edge Case**: Different approach to versioned transactions with ALTs.

```typescript
// v1
const lookupTable = await connection.getAddressLookupTable(tableAddress);
const messageV0 = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash,
  instructions,
}).compileToV0Message([lookupTable.value]);

// Kit
import {
  fetchAddressLookupTable,
  compileTransactionMessage,
} from '@solana/kit';

const lookupTable = await fetchAddressLookupTable(rpc, tableAddress);

// Include lookup tables in compilation
const compiledTx = compileTransactionMessage(
  transactionMessage,
  {
    addressLookupTables: [lookupTable],
  }
);
```

---

## 10. Testing Considerations

### Mock Differences

**Edge Case**: Mocking strategies differ between v1 and Kit.

```typescript
// v1: Mock Connection class
jest.mock('@solana/web3.js', () => ({
  Connection: jest.fn().mockImplementation(() => ({
    getBalance: jest.fn().mockResolvedValue(1000000000),
  })),
}));

// Kit: Mock RPC factory
jest.mock('@solana/kit', () => ({
  createSolanaRpc: jest.fn(() => ({
    getBalance: jest.fn(() => ({
      send: jest.fn().mockResolvedValue({ value: 1000000000n }),
    })),
  })),
}));
```

### Test Validator Compatibility

**Edge Case**: Test validator works with both, but types differ.

```typescript
// Both work with solana-test-validator
// But account data types differ

// v1
const account = await connection.getAccountInfo(pubkey);
account?.data; // Buffer

// Kit
const { value: account } = await rpc.getAccountInfo(addr, {
  encoding: 'base64'
}).send();
account?.data; // [string, 'base64'] tuple
```

### Bankrun

**Edge Case**: Check bankrun version for Kit compatibility.

```typescript
// Some bankrun versions may need v1 types
// Check if your version supports Kit types

// Workaround: Use compat layer
import { toLegacyPublicKey } from '@solana/compat';
const pubkey = toLegacyPublicKey(kitAddress);
// Use pubkey with bankrun
```

---

## Quick Reference: Common Gotchas

| Issue | v1 Code | Kit Code | Solution |
|-------|---------|----------|----------|
| Forgot `.send()` | N/A | `rpc.getBalance(addr)` | Add `.send()` |
| Number vs BigInt | `1000` | `1000n` | Use `n` suffix |
| Missing blockhash | Runtime error | Compile error | Set lifetime |
| Sync keypair | `Keypair.generate()` | Error | Use `await` |
| Method on address | `addr.toBase58()` | Error | Address is string |
| JSON.stringify BigInt | N/A | TypeError | Convert to string |
| Missing encoding | Works | Error | Add `{ encoding: 'base64' }` |
| Direct value access | `await getX()` | Wrapped | Destructure `{ value }` |

---

## Debugging Tips

1. **Type errors**: Read the full TypeScript error - Kit's types are descriptive
2. **Runtime errors**: Check if you forgot `.send()` on RPC calls
3. **BigInt issues**: Use `console.log(typeof value)` to check types
4. **Encoding errors**: Try `base64` or `jsonParsed` encoding
5. **Signer errors**: Ensure signers are embedded in instructions or added explicitly
