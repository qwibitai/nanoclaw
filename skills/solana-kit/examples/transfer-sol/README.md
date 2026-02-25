# Transfer SOL with Solana Kit

Complete example of transferring SOL between wallets.

## Setup

```bash
npm install @solana/kit @solana-program/system
```

## Full Example

```typescript
// transfer-sol.ts
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  airdropFactory,
  address,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";

const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

async function transferSol() {
  // 1. Setup RPC connections
  const rpc = createSolanaRpc("https://api.devnet.solana.com");
  const rpcSubscriptions = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");

  // 2. Create or load signers
  const sender = await generateKeyPairSigner();
  const recipient = await generateKeyPairSigner();

  console.log("Sender:", sender.address);
  console.log("Recipient:", recipient.address);

  // 3. Fund sender on devnet
  const airdrop = airdropFactory({ rpc, rpcSubscriptions });
  console.log("Requesting airdrop...");
  await airdrop({
    commitment: "confirmed",
    lamports: lamports(2n * LAMPORTS_PER_SOL),
    recipientAddress: sender.address,
  });

  // 4. Check balance
  const balanceBefore = await rpc.getBalance(sender.address).send();
  console.log("Sender balance:", Number(balanceBefore.value) / 1e9, "SOL");

  // 5. Get latest blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  // 6. Build transfer instruction
  const transferInstruction = getTransferSolInstruction({
    source: sender,  // Signer with funds
    destination: recipient.address,  // Just the address
    amount: lamports(LAMPORTS_PER_SOL / 2n),  // 0.5 SOL
  });

  // 7. Build transaction message with pipe
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstruction(transferInstruction, tx),
  );

  // 8. Sign transaction
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);

  // 9. Get signature (available before sending)
  const signature = getSignatureFromTransaction(signedTransaction);
  console.log("Transaction signature:", signature);

  // 10. Send and confirm
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTransaction, {
    commitment: "confirmed",
    skipPreflight: false,
  });

  console.log("Transfer confirmed!");

  // 11. Verify balances
  const senderBalanceAfter = await rpc.getBalance(sender.address).send();
  const recipientBalance = await rpc.getBalance(recipient.address).send();

  console.log("Sender balance after:", Number(senderBalanceAfter.value) / 1e9, "SOL");
  console.log("Recipient balance:", Number(recipientBalance.value) / 1e9, "SOL");

  return signature;
}

transferSol().catch(console.error);
```

## Using Existing Wallet

```typescript
import { createKeyPairSignerFromBytes } from "@solana/kit";
import bs58 from "bs58";

// From base58 private key (Phantom export format)
async function fromBase58(privateKey: string) {
  const bytes = bs58.decode(privateKey);
  return createKeyPairSignerFromBytes(bytes);
}

// From JSON array (Solana CLI format)
async function fromJsonArray(jsonKey: string) {
  const keyArray = JSON.parse(jsonKey);
  return createKeyPairSignerFromBytes(new Uint8Array(keyArray));
}

// From file
import fs from "fs";
async function fromFile(path: string) {
  const keyData = JSON.parse(fs.readFileSync(path, "utf8"));
  return createKeyPairSignerFromBytes(new Uint8Array(keyData));
}
```

## Transfer to Known Address

```typescript
import { address } from "@solana/kit";

async function transferToAddress(
  sender: KeyPairSigner,
  recipientAddress: string,
  amountSol: number
) {
  const recipient = address(recipientAddress);
  const amountLamports = lamports(BigInt(Math.floor(amountSol * 1e9)));

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstruction(
      getTransferSolInstruction({
        source: sender,
        destination: recipient,
        amount: amountLamports,
      }),
      tx
    ),
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  return getSignatureFromTransaction(signedTx);
}

// Usage
const sig = await transferToAddress(
  mySigner,
  "RecipientAddressHere1111111111111111111111111",
  0.5  // 0.5 SOL
);
```

## Multiple Transfers in One Transaction

```typescript
async function batchTransfer(
  sender: KeyPairSigner,
  transfers: Array<{ to: string; amount: number }>
) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  // Create all transfer instructions
  const instructions = transfers.map(({ to, amount }) =>
    getTransferSolInstruction({
      source: sender,
      destination: address(to),
      amount: lamports(BigInt(Math.floor(amount * 1e9))),
    })
  );

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  return getSignatureFromTransaction(signedTx);
}

// Usage
await batchTransfer(sender, [
  { to: "Address1...", amount: 0.1 },
  { to: "Address2...", amount: 0.2 },
  { to: "Address3...", amount: 0.3 },
]);
```

## With Priority Fee

```typescript
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

async function transferWithPriorityFee(
  sender: KeyPairSigner,
  recipient: Address,
  amountLamports: Lamports,
  priorityFeeInMicroLamports: bigint
) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    // Prepend compute budget instructions
    (tx) => prependTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 200_000 }),
      getSetComputeUnitPriceInstruction({ microLamports: priorityFeeInMicroLamports }),
    ], tx),
    (tx) => appendTransactionMessageInstruction(
      getTransferSolInstruction({
        source: sender,
        destination: recipient,
        amount: amountLamports,
      }),
      tx
    ),
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  return getSignatureFromTransaction(signedTx);
}
```

## Error Handling

```typescript
import {
  isSolanaError,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
} from "@solana/errors";

async function safeTransfer(sender: KeyPairSigner, recipient: Address, amount: Lamports) {
  try {
    // Check balance first
    const balance = await rpc.getBalance(sender.address).send();
    const requiredLamports = BigInt(amount) + 5000n; // amount + fee estimate

    if (balance.value < requiredLamports) {
      throw new Error(`Insufficient balance. Have: ${balance.value}, Need: ${requiredLamports}`);
    }

    // Build and send
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(sender.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstruction(
        getTransferSolInstruction({ source: sender, destination: recipient, amount }),
        tx
      ),
    );

    const signedTx = await signTransactionMessageWithSigners(tx);
    await sendAndConfirm(signedTx, { commitment: "confirmed" });

    return { success: true, signature: getSignatureFromTransaction(signedTx) };

  } catch (error) {
    if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS)) {
      return { success: false, error: "Insufficient funds for transfer" };
    }
    if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)) {
      return { success: false, error: "Blockhash expired, please retry" };
    }
    throw error;
  }
}
```
