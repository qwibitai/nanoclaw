# Solana Kit Troubleshooting Guide

Common issues and solutions when using @solana/kit.

## Installation Issues

### Cannot find module '@solana/kit'

```bash
# Ensure you're installing the correct package
npm install @solana/kit

# Check installation
npm list @solana/kit
```

### TypeScript errors with imports

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true
  }
}
```

### BigInt serialization error

```typescript
// Error: TypeError: Do not know how to serialize a BigInt

// Solution: Use string conversion or custom replacer
JSON.stringify(data, (key, value) =>
  typeof value === "bigint" ? value.toString() : value
);
```

---

## RPC Connection Issues

### Error: fetch failed / ECONNREFUSED

**Cause**: Invalid RPC URL or network issues.

```typescript
// Check your endpoint
const rpc = createSolanaRpc("https://api.devnet.solana.com");

// Test connection
try {
  const slot = await rpc.getSlot().send();
  console.log("Connected, slot:", slot);
} catch (error) {
  console.error("Connection failed:", error);
}
```

### Error: 429 Too Many Requests

**Cause**: Rate limiting from public RPC.

```typescript
// Solution 1: Use a premium RPC provider
const rpc = createSolanaRpc("https://mainnet.helius-rpc.com/?api-key=YOUR_KEY");

// Solution 2: Add delay between requests
async function rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
  await new Promise((r) => setTimeout(r, 200));  // 5 req/sec
  return fn();
}
```

### WebSocket disconnects

```typescript
// Implement reconnection logic
async function watchWithReconnect(addr: string, onUpdate: (data: any) => void) {
  while (true) {
    try {
      const controller = new AbortController();
      const sub = await rpcSubscriptions
        .accountNotifications(address(addr), { commitment: "confirmed" })
        .subscribe({ abortSignal: controller.signal });

      for await (const notification of sub) {
        onUpdate(notification);
      }
    } catch (error) {
      console.log("Reconnecting in 5s...");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
```

---

## Transaction Errors

### Error: Blockhash not found / expired

**Cause**: Transaction took too long to confirm or blockhash was invalid.

```typescript
// Solution: Get fresh blockhash and retry
async function sendWithRetry(buildTx: () => Promise<any>, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const tx = await buildTx();  // Get fresh blockhash each time
      const signedTx = await signTransactionMessageWithSigners(tx);
      await sendAndConfirm(signedTx, { commitment: "confirmed" });
      return getSignatureFromTransaction(signedTx);
    } catch (error: any) {
      if (error.message?.includes("blockhash") && i < maxRetries - 1) {
        console.log("Blockhash expired, retrying...");
        continue;
      }
      throw error;
    }
  }
}
```

### Error: Transaction simulation failed

```typescript
// Simulate first to see the error
const encoded = getBase64EncodedWireTransaction(signedTx);
const sim = await rpc.simulateTransaction(encoded, {
  commitment: "confirmed",
}).send();

if (sim.value.err) {
  console.error("Error:", sim.value.err);
  console.error("Logs:", sim.value.logs);
}
```

### Error: Insufficient funds

```typescript
// Check balance before sending
const balance = await rpc.getBalance(sender.address).send();
const requiredLamports = transferAmount + 5000n;  // amount + estimated fee

if (balance.value < requiredLamports) {
  throw new Error(`Insufficient: have ${balance.value}, need ${requiredLamports}`);
}
```

### Error: Transaction too large (1232 bytes)

```typescript
// Solution 1: Split into multiple transactions
const chunks = chunkArray(instructions, 5);  // 5 instructions per tx

for (const chunk of chunks) {
  const tx = await buildTransaction(feePayer, chunk);
  await signAndSend(tx);
}

// Solution 2: Use Address Lookup Tables
const tx = pipe(
  createTransactionMessage({ version: 0 }),
  // ...
  (tx) => setTransactionMessageAddressLookupTable(tx, lookupTable),
  (tx) => appendTransactionMessageInstructions(instructions, tx),
);
```

### Error: Signature verification failed

**Cause**: Transaction modified after signing or wrong signer.

```typescript
// Ensure all required signers are included
const tx = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayerSigner(payer, tx),  // Signer, not just address
  (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  (tx) => appendTransactionMessageInstruction(
    getTransferSolInstruction({
      source: sender,  // Must be KeyPairSigner, not Address
      destination: recipient,  // Can be just Address
      amount: lamports(1000000n),
    }),
    tx
  ),
);
```

---

## Signer Issues

### Error: Signer required but address provided

```typescript
// Wrong: Using address where signer is required
getTransferSolInstruction({
  source: address("..."),  // ERROR: needs signer
  destination: address("..."),
  amount: lamports(1000n),
});

// Correct: Use KeyPairSigner for source
getTransferSolInstruction({
  source: mySigner,  // KeyPairSigner
  destination: address("..."),  // Address is OK for destination
  amount: lamports(1000n),
});
```

### Error: Invalid keypair bytes

```typescript
// Base58 private key (Phantom)
import bs58 from "bs58";
const signer = await createKeyPairSignerFromBytes(
  bs58.decode(process.env.PRIVATE_KEY!)
);

// JSON array (Solana CLI)
const keyArray = JSON.parse(process.env.PRIVATE_KEY!);
const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(keyArray)
);

// From file
import fs from "fs";
const keyData = JSON.parse(fs.readFileSync("keypair.json", "utf8"));
const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(keyData)
);
```

---

## Account Issues

### Error: Account not found

```typescript
// Check if account exists before using
const account = await fetchEncodedAccount(rpc, addr);
if (!account.exists) {
  console.log("Account does not exist, creating...");
  // Create account logic
}
```

### Error: Invalid account owner

```typescript
// Verify account is owned by expected program
const account = await fetchEncodedAccount(rpc, addr);
assertAccountExists(account);

const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
if (account.programAddress !== TOKEN_PROGRAM) {
  throw new Error(`Wrong owner: ${account.programAddress}`);
}
```

### Error: Account data too small

```typescript
// Ensure correct account size when creating
const mintSpace = BigInt(getMintSize());  // Use helper functions
const rentLamports = await rpc.getMinimumBalanceForRentExemption(mintSpace).send();

getCreateAccountInstruction({
  payer,
  newAccount: mint,
  lamports: rentLamports,
  space: mintSpace,  // Must match expected size
  programAddress: TOKEN_PROGRAM_ADDRESS,
});
```

---

## Token Issues

### Error: Token account not found

```typescript
// Use idempotent instruction to create if missing
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";

const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
  mint: mintAddress,
  owner: ownerAddress,
  payer,
});

// Include in transaction before transfer
```

### Error: Insufficient token balance

```typescript
// Check token balance
const [ata] = await findAssociatedTokenPda({
  mint: mintAddress,
  owner: ownerAddress,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});

const balance = await rpc.getTokenAccountBalance(ata).send();
console.log("Token balance:", balance.value.uiAmount);

if (BigInt(balance.value.amount) < transferAmount) {
  throw new Error("Insufficient token balance");
}
```

---

## Common Mistakes

### 1. Not awaiting async functions

```typescript
// Wrong
const signer = generateKeyPairSigner();  // Missing await

// Correct
const signer = await generateKeyPairSigner();
```

### 2. Forgetting .send() on RPC calls

```typescript
// Wrong
const balance = rpc.getBalance(addr);  // Returns RpcRequest, not result

// Correct
const balance = await rpc.getBalance(addr).send();
```

### 3. Using wrong address format

```typescript
// Wrong: Using string directly
setTransactionMessageFeePayer("Address...", tx);

// Correct: Convert to Address type
setTransactionMessageFeePayer(address("Address..."), tx);
```

### 4. Modifying transaction after signing

```typescript
// Wrong: Adding instruction after signing
const signedTx = await signTransactionMessageWithSigners(tx);
// Don't modify signedTx!

// Correct: Build complete transaction, then sign once
const tx = pipe(
  createTransactionMessage({ version: 0 }),
  // ... all modifications ...
);
const signedTx = await signTransactionMessageWithSigners(tx);
```

### 5. Not using versioned transactions

```typescript
// Always specify version 0 for modern features
createTransactionMessage({ version: 0 });  // v0 transaction

// Legacy (avoid unless necessary)
createTransactionMessage({ version: "legacy" });
```

---

## Debugging Tips

### Enable verbose logging

```typescript
// Log transaction details before sending
const signedTx = await signTransactionMessageWithSigners(tx);
console.log("Signature:", getSignatureFromTransaction(signedTx));
console.log("Fee payer:", /* extract from tx */);

// Simulate first
const sim = await rpc.simulateTransaction(
  getBase64EncodedWireTransaction(signedTx),
  { commitment: "confirmed" }
).send();
console.log("Simulation:", sim);
```

### Check transaction on explorer

```typescript
const signature = getSignatureFromTransaction(signedTx);
console.log(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
```

### Decode account data

```typescript
// Use codecs to decode and inspect account data
const account = await fetchEncodedAccount(rpc, addr);
if (account.exists) {
  console.log("Raw data (hex):", Buffer.from(account.data).toString("hex"));
  console.log("Data length:", account.data.length);
}
```
