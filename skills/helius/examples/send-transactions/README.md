# Send Transactions Examples

Examples demonstrating optimized transaction sending with Helius.

## Setup

```typescript
import { createHelius } from "helius-sdk";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  address,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  prependTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

const API_KEY = process.env.HELIUS_API_KEY!;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const helius = createHelius({ apiKey: API_KEY });
const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
```

## Basic SOL Transfer

```typescript
const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

async function transferSOL(
  sender: KeyPairSigner,
  recipientAddress: string,
  amountSol: number
) {
  const recipient = address(recipientAddress);
  const amountLamports = lamports(BigInt(amountSol * 1e9));

  // Get blockhash
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  // Build transaction
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstruction(
      getTransferSolInstruction({
        source: sender,
        destination: recipient,
        amount: amountLamports,
      }),
      tx
    ),
  );

  // Sign
  const signedTx = await signTransactionMessageWithSigners(tx);

  // Send and confirm
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  const signature = getSignatureFromTransaction(signedTx);
  console.log("Transaction confirmed:", signature);

  return signature;
}
```

## Transfer with Priority Fees

```typescript
async function transferWithPriorityFee(
  sender: KeyPairSigner,
  recipientAddress: string,
  amountSol: number,
  priorityLevel: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH" = "MEDIUM"
) {
  const recipient = address(recipientAddress);
  const amountLamports = lamports(BigInt(amountSol * 1e9));

  // Get priority fee estimate
  const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
    accountKeys: [sender.address, recipientAddress],
    options: { priorityLevel },
  });

  console.log(`Priority fee (${priorityLevel}): ${priorityFeeEstimate} microLamports`);

  // Get blockhash
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  // Build transaction with compute budget
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    // Add compute budget instructions FIRST
    (tx) => prependTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 200_000 }),
      getSetComputeUnitPriceInstruction({
        microLamports: BigInt(priorityFeeEstimate)
      }),
    ], tx),
    // Then the transfer
    (tx) => appendTransactionMessageInstruction(
      getTransferSolInstruction({
        source: sender,
        destination: recipient,
        amount: amountLamports,
      }),
      tx
    ),
  );

  // Sign
  const signedTx = await signTransactionMessageWithSigners(tx);

  // Send and confirm
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  return getSignatureFromTransaction(signedTx);
}
```

## Smart Transaction via Helius SDK

```typescript
async function sendSmartTransaction(
  sender: KeyPairSigner,
  recipientAddress: string,
  amountSol: number
) {
  const recipient = address(recipientAddress);
  const amountLamports = lamports(BigInt(amountSol * 1e9));

  // Get blockhash
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  // Build transaction
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstruction(
      getTransferSolInstruction({
        source: sender,
        destination: recipient,
        amount: amountLamports,
      }),
      tx
    ),
  );

  // Sign
  const signedTx = await signTransactionMessageWithSigners(tx);

  // Send via Helius smart transaction (automatic retry and optimization)
  const signature = await helius.tx.sendSmartTransaction({
    transaction: getBase64EncodedWireTransaction(signedTx),
    skipPreflight: false,
    maxRetries: 3,
  });

  console.log("Smart transaction confirmed:", signature);
  return signature;
}
```

## Dynamic Priority Fee Adjustment

```typescript
async function sendWithDynamicFees(
  sender: KeyPairSigner,
  buildTransaction: (blockhash: any, priorityFee: bigint) => Promise<any>,
  maxRetries = 3
) {
  const levels = ["MEDIUM", "HIGH", "VERY_HIGH"] as const;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const level = levels[Math.min(attempt, levels.length - 1)];

    try {
      // Get fresh blockhash
      const { value: blockhash } = await rpc.getLatestBlockhash().send();

      // Get priority fee
      const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
        accountKeys: [sender.address],
        options: { priorityLevel: level },
      });

      console.log(`Attempt ${attempt + 1} with ${level} priority (${priorityFeeEstimate} microLamports)`);

      // Build and sign transaction
      const tx = await buildTransaction(blockhash, BigInt(priorityFeeEstimate));
      const signedTx = await signTransactionMessageWithSigners(tx);

      // Send
      const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
      await sendAndConfirm(signedTx, { commitment: "confirmed" });

      return getSignatureFromTransaction(signedTx);
    } catch (error: any) {
      console.error(`Attempt ${attempt + 1} failed:`, error.message);

      if (attempt === maxRetries - 1) {
        throw error;
      }

      // Wait before retry
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// Usage
const signature = await sendWithDynamicFees(
  signer,
  async (blockhash, priorityFee) => {
    return pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(signer.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
      (tx) => prependTransactionMessageInstructions([
        getSetComputeUnitLimitInstruction({ units: 200_000 }),
        getSetComputeUnitPriceInstruction({ microLamports: priorityFee }),
      ], tx),
      (tx) => appendTransactionMessageInstruction(transferIx, tx),
    );
  }
);
```

## Estimate Compute Units

```typescript
async function estimateAndSendTransaction(
  sender: KeyPairSigner,
  instruction: IInstruction
) {
  // Build transaction for simulation
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const simulationTx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstruction(instruction, tx),
  );

  const signedSimTx = await signTransactionMessageWithSigners(simulationTx);

  // Simulate to get compute units
  const simulation = await rpc.simulateTransaction(
    getBase64EncodedWireTransaction(signedSimTx),
    { encoding: "base64", replaceRecentBlockhash: true }
  ).send();

  if (simulation.value.err) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const unitsConsumed = simulation.value.unitsConsumed || 200_000;
  const computeLimit = Math.ceil(unitsConsumed * 1.1); // 10% buffer

  console.log(`Estimated compute units: ${unitsConsumed}`);
  console.log(`Setting limit: ${computeLimit}`);

  // Get priority fee
  const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
    accountKeys: [sender.address],
    options: { priorityLevel: "MEDIUM" },
  });

  // Build final transaction
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => prependTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: computeLimit }),
      getSetComputeUnitPriceInstruction({ microLamports: BigInt(priorityFeeEstimate) }),
    ], tx),
    (tx) => appendTransactionMessageInstruction(instruction, tx),
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  return getSignatureFromTransaction(signedTx);
}
```

## Transaction Builder Helper

```typescript
class TransactionBuilder {
  private rpc: Rpc;
  private rpcSubscriptions: RpcSubscriptions;
  private helius: Helius;

  constructor(rpcUrl: string, wsUrl: string, helius: Helius) {
    this.rpc = createSolanaRpc(rpcUrl);
    this.rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
    this.helius = helius;
  }

  async sendTransaction(
    signer: KeyPairSigner,
    instructions: IInstruction[],
    options: {
      priorityLevel?: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
      computeUnits?: number;
      skipPreflight?: boolean;
    } = {}
  ) {
    const {
      priorityLevel = "MEDIUM",
      computeUnits = 200_000,
      skipPreflight = false,
    } = options;

    // Get priority fee
    const { priorityFeeEstimate } = await this.helius.getPriorityFeeEstimate({
      accountKeys: [signer.address],
      options: { priorityLevel },
    });

    // Get blockhash
    const { value: blockhash } = await this.rpc.getLatestBlockhash().send();

    // Build transaction
    let tx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(signer.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
      (tx) => prependTransactionMessageInstructions([
        getSetComputeUnitLimitInstruction({ units: computeUnits }),
        getSetComputeUnitPriceInstruction({ microLamports: BigInt(priorityFeeEstimate) }),
      ], tx),
    );

    // Add instructions
    for (const ix of instructions) {
      tx = appendTransactionMessageInstruction(ix, tx);
    }

    // Sign
    const signedTx = await signTransactionMessageWithSigners(tx);

    // Send
    const sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc: this.rpc,
      rpcSubscriptions: this.rpcSubscriptions,
    });

    await sendAndConfirm(signedTx, {
      commitment: "confirmed",
      skipPreflight,
    });

    return getSignatureFromTransaction(signedTx);
  }
}

// Usage
const builder = new TransactionBuilder(RPC_URL, WS_URL, helius);

const signature = await builder.sendTransaction(
  signer,
  [transferInstruction1, transferInstruction2],
  { priorityLevel: "HIGH", computeUnits: 100_000 }
);
```

## Monitor Transaction Confirmation

```typescript
async function sendAndMonitor(
  signedTx: SignedTransaction,
  commitment: "processed" | "confirmed" | "finalized" = "confirmed"
) {
  const signature = getSignatureFromTransaction(signedTx);
  console.log("Sending transaction:", signature);

  // Send without confirming
  const send = sendTransactionWithoutConfirmingFactory({ rpc });
  await send(signedTx, { skipPreflight: false });

  console.log("Transaction sent, waiting for confirmation...");

  // Poll for status
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    const { value: statuses } = await rpc.getSignatureStatuses([signature]).send();
    const status = statuses[0];

    if (status) {
      console.log(`Status: ${status.confirmationStatus}`);

      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }

      if (commitment === "processed" && status.confirmationStatus) {
        return signature;
      }
      if (commitment === "confirmed" &&
          (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        return signature;
      }
      if (commitment === "finalized" && status.confirmationStatus === "finalized") {
        return signature;
      }
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error("Transaction confirmation timeout");
}
```

## Complete Example

```typescript
import { createHelius } from "helius-sdk";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  address,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  prependTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import bs58 from "bs58";

async function main() {
  const API_KEY = process.env.HELIUS_API_KEY!;
  const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
  const RECIPIENT = "RecipientAddressHere";

  const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
  const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

  // Initialize
  const helius = createHelius({ apiKey: API_KEY });
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);

  // Create signer
  const signer = await createKeyPairSignerFromBytes(bs58.decode(PRIVATE_KEY));
  console.log("Sender:", signer.address);

  // Get priority fee
  const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
    accountKeys: [signer.address, RECIPIENT],
    options: { priorityLevel: "HIGH" },
  });
  console.log("Priority fee:", priorityFeeEstimate, "microLamports");

  // Get blockhash
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  // Build transaction
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => prependTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 100_000 }),
      getSetComputeUnitPriceInstruction({ microLamports: BigInt(priorityFeeEstimate) }),
    ], tx),
    (tx) => appendTransactionMessageInstruction(
      getTransferSolInstruction({
        source: signer,
        destination: address(RECIPIENT),
        amount: lamports(10_000_000n), // 0.01 SOL
      }),
      tx
    ),
  );

  // Sign and send
  const signedTx = await signTransactionMessageWithSigners(tx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  const signature = getSignatureFromTransaction(signedTx);
  console.log("Transaction confirmed:", signature);
}

main().catch(console.error);
```
