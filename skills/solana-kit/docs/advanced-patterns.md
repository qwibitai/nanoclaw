# Advanced Patterns with Solana Kit

Advanced usage patterns for production applications.

## Custom RPC Transports

Kit allows complete customization of RPC transports.

### Rate-Limited Transport

```typescript
import {
  createSolanaRpc,
  createDefaultRpcTransport,
} from "@solana/kit";

function createRateLimitedTransport(
  url: string,
  requestsPerSecond: number
) {
  const transport = createDefaultRpcTransport({ url });
  const minInterval = 1000 / requestsPerSecond;
  let lastRequest = 0;

  return async (request: any) => {
    const now = Date.now();
    const timeSinceLast = now - lastRequest;

    if (timeSinceLast < minInterval) {
      await new Promise((r) => setTimeout(r, minInterval - timeSinceLast));
    }

    lastRequest = Date.now();
    return transport(request);
  };
}

// Usage
const transport = createRateLimitedTransport(
  "https://api.devnet.solana.com",
  5  // 5 requests per second
);
const rpc = createSolanaRpc({ transport });
```

### Retry Transport

```typescript
function createRetryTransport(
  url: string,
  maxRetries = 3,
  baseDelayMs = 1000
) {
  const transport = createDefaultRpcTransport({ url });

  return async (request: any) => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await transport(request);
      } catch (error: any) {
        lastError = error;

        // Retry on rate limit or server errors
        if (error.status === 429 || error.status >= 500) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  };
}
```

### Failover Transport

```typescript
function createFailoverTransport(urls: string[]) {
  const transports = urls.map((url) => createDefaultRpcTransport({ url }));
  let currentIndex = 0;

  return async (request: any) => {
    const startIndex = currentIndex;

    do {
      try {
        return await transports[currentIndex](request);
      } catch (error) {
        console.log(`Transport ${currentIndex} failed, trying next`);
        currentIndex = (currentIndex + 1) % transports.length;

        if (currentIndex === startIndex) {
          throw new Error("All RPC endpoints failed");
        }
      }
    } while (true);
  };
}

// Usage with multiple providers
const transport = createFailoverTransport([
  "https://api.mainnet-beta.solana.com",
  "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
  "https://rpc.ankr.com/solana",
]);
```

### Round-Robin Transport

```typescript
function createRoundRobinTransport(urls: string[]) {
  const transports = urls.map((url) => createDefaultRpcTransport({ url }));
  let index = 0;

  return async (request: any) => {
    const transport = transports[index];
    index = (index + 1) % transports.length;
    return transport(request);
  };
}
```

## Transaction Optimization

### Optimal Compute Budget

```typescript
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

async function simulateAndOptimize(
  rpc: Rpc,
  transaction: any,
  feePayer: KeyPairSigner
) {
  // Simulate with high compute to get actual usage
  const simResult = await rpc.simulateTransaction(
    getBase64EncodedWireTransaction(transaction),
    { commitment: "confirmed" }
  ).send();

  if (simResult.value.err) {
    throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}`);
  }

  // Get actual compute used (add 10% buffer)
  const unitsUsed = simResult.value.unitsConsumed || 200_000;
  const optimalUnits = Math.ceil(Number(unitsUsed) * 1.1);

  console.log(`Simulation used ${unitsUsed} CU, setting ${optimalUnits}`);

  // Rebuild with optimal compute
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  return pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => prependTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: optimalUnits }),
      getSetComputeUnitPriceInstruction({ microLamports: 1000n }),
    ], tx),
    (tx) => appendTransactionMessageInstructions(originalInstructions, tx),
  );
}
```

### Priority Fee Estimation

```typescript
async function estimatePriorityFee(
  rpc: Rpc,
  accounts: Address[]
): Promise<bigint> {
  const recentFees = await rpc.getRecentPrioritizationFees(accounts).send();

  if (recentFees.length === 0) {
    return 1000n;  // Default
  }

  // Get median fee
  const fees = recentFees.map((f) => f.prioritizationFee).sort((a, b) => Number(a - b));
  const medianFee = fees[Math.floor(fees.length / 2)];

  // Add 20% buffer
  return BigInt(Math.ceil(Number(medianFee) * 1.2));
}
```

## Durable Nonce Transactions

For transactions that don't expire:

```typescript
import {
  setTransactionMessageLifetimeUsingDurableNonce,
  sendAndConfirmDurableNonceTransactionFactory,
} from "@solana/kit";
import {
  getCreateNonceAccountInstruction,
  getAdvanceNonceAccountInstruction,
} from "@solana-program/system";

// Create nonce account
async function createNonceAccount(
  payer: KeyPairSigner,
  nonceAuthority: Address
) {
  const nonceAccount = await generateKeyPairSigner();
  const space = 80n;  // Nonce account size
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();

  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstruction(
      getCreateNonceAccountInstruction({
        payer,
        nonceAccount,
        nonceAuthority,
        lamports: rent,
      }),
      tx
    ),
  );

  await signAndSend(tx);
  return nonceAccount.address;
}

// Use nonce for durable transaction
async function createDurableTransaction(
  feePayer: KeyPairSigner,
  nonceAccount: Address,
  nonceAuthority: KeyPairSigner,
  instructions: any[]
) {
  // Fetch current nonce
  const nonceAccountInfo = await fetchEncodedAccount(rpc, nonceAccount);
  assertAccountExists(nonceAccountInfo);

  // Parse nonce from account data (blockhash is at offset 40)
  const nonce = /* decode nonce from account data */;

  return pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingDurableNonce({
      nonce,
      nonceAccountAddress: nonceAccount,
      nonceAuthorityAddress: nonceAuthority.address,
    }, tx),
    (tx) => prependTransactionMessageInstruction(
      getAdvanceNonceAccountInstruction({
        nonceAccount,
        nonceAuthority,
      }),
      tx
    ),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
}

// Send durable nonce transaction
const sendDurable = sendAndConfirmDurableNonceTransactionFactory({
  rpc,
  rpcSubscriptions,
});
await sendDurable(signedDurableTx, { commitment: "confirmed" });
```

## Address Lookup Tables

Reduce transaction size with lookup tables:

```typescript
import {
  setTransactionMessageAddressLookupTable,
  fetchAddressLookupTable,
} from "@solana/kit";
import {
  getCreateLookupTableInstruction,
  getExtendLookupTableInstruction,
} from "@solana-program/address-lookup-table";

// Create lookup table
async function createLookupTable(
  authority: KeyPairSigner,
  addresses: Address[]
) {
  const recentSlot = await rpc.getSlot().send();

  // Create table
  const createIx = getCreateLookupTableInstruction({
    authority: authority.address,
    payer: authority,
    recentSlot,
  });

  // Derive table address from instruction
  const lookupTableAddress = /* derive from createIx */;

  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const createTx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(authority, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstruction(createIx, tx),
  );

  await signAndSend(createTx);

  // Extend table with addresses
  const extendIx = getExtendLookupTableInstruction({
    lookupTable: lookupTableAddress,
    authority: authority.address,
    payer: authority,
    addresses,
  });

  const extendTx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(authority, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(
      (await rpc.getLatestBlockhash().send()).value,
      tx
    ),
    (tx) => appendTransactionMessageInstruction(extendIx, tx),
  );

  await signAndSend(extendTx);

  return lookupTableAddress;
}

// Use lookup table in transaction
async function buildWithLookupTable(
  feePayer: KeyPairSigner,
  lookupTableAddress: Address,
  instructions: any[]
) {
  const lookupTable = await fetchAddressLookupTable(rpc, lookupTableAddress);
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  return pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => setTransactionMessageAddressLookupTable(tx, lookupTable),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
}
```

## Partial Signing / Multisig

```typescript
import {
  partiallySignTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
} from "@solana/kit";

// Scenario: Transaction needs signatures from multiple parties
async function multisigTransaction(
  feePayer: KeyPairSigner,
  signer1: KeyPairSigner,
  signer2: KeyPairSigner,
  instructions: any[]
) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  // Build transaction with all signers
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );

  // Signer 1 partially signs
  const partialTx1 = await partiallySignTransactionMessageWithSigners(tx);

  // In real world, this would be sent to signer 2
  // Signer 2 adds their signature
  const partialTx2 = await partiallySignTransactionMessageWithSigners(partialTx1);

  // Fee payer adds final signature
  const fullySigned = await signTransactionMessageWithSigners(partialTx2);

  return fullySigned;
}
```

## Offchain Messages

Sign messages without transactions:

```typescript
import {
  createOffchainMessage,
  signOffchainMessage,
  verifyOffchainMessage,
} from "@solana/kit";

// Sign a message
async function signMessage(signer: KeyPairSigner, message: string) {
  const offchainMessage = createOffchainMessage({
    message: new TextEncoder().encode(message),
    version: 0,
  });

  const signature = await signOffchainMessage(signer, offchainMessage);
  return signature;
}

// Verify a signed message
async function verifyMessage(
  signature: Signature,
  message: string,
  expectedSigner: Address
): Promise<boolean> {
  const offchainMessage = createOffchainMessage({
    message: new TextEncoder().encode(message),
    version: 0,
  });

  return verifyOffchainMessage(signature, offchainMessage, expectedSigner);
}
```

## Batching RPC Calls

```typescript
// Manual batching for custom RPCs
async function batchGetBalances(rpc: Rpc, addresses: Address[]) {
  // Split into chunks of 100
  const chunkSize = 100;
  const chunks: Address[][] = [];

  for (let i = 0; i < addresses.length; i += chunkSize) {
    chunks.push(addresses.slice(i, i + chunkSize));
  }

  const results = new Map<string, bigint>();

  // Process chunks in parallel
  await Promise.all(
    chunks.map(async (chunk) => {
      const accounts = await fetchEncodedAccounts(rpc, chunk);

      for (let i = 0; i < chunk.length; i++) {
        const account = accounts[i];
        results.set(
          chunk[i],
          account.exists ? account.lamports : 0n
        );
      }
    })
  );

  return results;
}
```

## Transaction Simulation

```typescript
async function simulateBeforeSend(
  rpc: Rpc,
  transaction: any
): Promise<{
  success: boolean;
  logs: string[];
  unitsConsumed: number;
  error?: any;
}> {
  const encoded = getBase64EncodedWireTransaction(transaction);

  const result = await rpc.simulateTransaction(encoded, {
    commitment: "confirmed",
    replaceRecentBlockhash: true,
    sigVerify: false,
  }).send();

  return {
    success: result.value.err === null,
    logs: result.value.logs || [],
    unitsConsumed: Number(result.value.unitsConsumed || 0),
    error: result.value.err,
  };
}

// Usage
const sim = await simulateBeforeSend(rpc, signedTx);
if (!sim.success) {
  console.error("Transaction would fail:", sim.error);
  console.error("Logs:", sim.logs);
} else {
  console.log("Simulation passed, using", sim.unitsConsumed, "CU");
  await sendAndConfirm(signedTx);
}
```

## Jito Bundle Submission

For MEV protection:

```typescript
async function submitJitoBundle(
  transactions: any[],
  jitoEndpoint: string
) {
  const serializedTxs = transactions.map((tx) =>
    getBase64EncodedWireTransaction(tx)
  );

  const response = await fetch(`${jitoEndpoint}/api/v1/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [serializedTxs],
    }),
  });

  const result = await response.json();
  return result.result;  // Bundle ID
}
```
