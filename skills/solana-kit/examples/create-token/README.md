# Create SPL Token with Solana Kit

Complete example of creating and minting SPL tokens.

## Setup

```bash
npm install @solana/kit @solana-program/system @solana-program/token
```

## Full Example: Create Token & Mint

```typescript
// create-token.ts
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  airdropFactory,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getInitializeMintInstruction,
  getMintToInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintSize,
} from "@solana-program/token";

const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

async function createToken() {
  // 1. Setup
  const rpc = createSolanaRpc("https://api.devnet.solana.com");
  const rpcSubscriptions = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  // 2. Create signers
  const payer = await generateKeyPairSigner();      // Pays for transactions
  const mintAuthority = await generateKeyPairSigner(); // Can mint new tokens
  const mint = await generateKeyPairSigner();          // The token mint account
  const tokenOwner = await generateKeyPairSigner();    // Will receive minted tokens

  console.log("Payer:", payer.address);
  console.log("Mint:", mint.address);
  console.log("Token Owner:", tokenOwner.address);

  // 3. Fund payer
  const airdrop = airdropFactory({ rpc, rpcSubscriptions });
  await airdrop({
    commitment: "confirmed",
    lamports: lamports(2n * LAMPORTS_PER_SOL),
    recipientAddress: payer.address,
  });
  console.log("Funded payer with 2 SOL");

  // 4. Calculate rent for mint account
  const mintSpace = BigInt(getMintSize());
  const mintRent = await rpc.getMinimumBalanceForRentExemption(mintSpace).send();
  console.log("Mint rent:", Number(mintRent) / 1e9, "SOL");

  // 5. Get blockhash
  const { value: blockhash1 } = await rpc.getLatestBlockhash().send();

  // 6. Create mint account and initialize
  const createMintInstructions = [
    // Create the account
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: mintRent,
      space: mintSpace,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    // Initialize as mint
    getInitializeMintInstruction({
      mint: mint.address,
      decimals: 9,
      mintAuthority: mintAuthority.address,
      freezeAuthority: null,  // No freeze authority
    }),
  ];

  const createMintTx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash1, tx),
    (tx) => appendTransactionMessageInstructions(createMintInstructions, tx),
  );

  const signedCreateMint = await signTransactionMessageWithSigners(createMintTx);
  await sendAndConfirm(signedCreateMint, { commitment: "confirmed" });
  console.log("Mint created:", getSignatureFromTransaction(signedCreateMint));

  // 7. Find Associated Token Account (ATA)
  const [ata] = await findAssociatedTokenPda({
    mint: mint.address,
    owner: tokenOwner.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  console.log("ATA address:", ata);

  // 8. Create ATA and mint tokens
  const { value: blockhash2 } = await rpc.getLatestBlockhash().send();

  const mintInstructions = [
    // Create ATA (idempotent - won't fail if exists)
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      mint: mint.address,
      owner: tokenOwner.address,
      payer,
    }),
    // Mint tokens
    getMintToInstruction({
      mint: mint.address,
      token: ata,
      mintAuthority,
      amount: 1_000_000_000n * 10n ** 9n,  // 1 billion tokens (with 9 decimals)
    }),
  ];

  const mintTx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash2, tx),
    (tx) => appendTransactionMessageInstructions(mintInstructions, tx),
  );

  const signedMintTx = await signTransactionMessageWithSigners(mintTx);
  await sendAndConfirm(signedMintTx, { commitment: "confirmed" });
  console.log("Tokens minted:", getSignatureFromTransaction(signedMintTx));

  // 9. Verify
  const tokenAccount = await rpc.getTokenAccountBalance(ata).send();
  console.log("Token balance:", tokenAccount.value.uiAmount, "tokens");

  return {
    mint: mint.address,
    ata,
    mintAuthority: mintAuthority.address,
    owner: tokenOwner.address,
  };
}

createToken().catch(console.error);
```

## Transfer Tokens

```typescript
import { getTransferInstruction } from "@solana-program/token";

async function transferTokens(
  owner: KeyPairSigner,        // Token owner (signer)
  mint: Address,               // Token mint
  recipient: Address,          // Recipient wallet
  amount: bigint,              // Amount in smallest units
  payer: KeyPairSigner         // Fee payer
) {
  // Find source and destination ATAs
  const [sourceAta] = await findAssociatedTokenPda({
    mint,
    owner: owner.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const [destAta] = await findAssociatedTokenPda({
    mint,
    owner: recipient,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const instructions = [
    // Create destination ATA if needed
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      mint,
      owner: recipient,
      payer,
    }),
    // Transfer tokens
    getTransferInstruction({
      source: sourceAta,
      destination: destAta,
      authority: owner,
      amount,
    }),
  ];

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  return getSignatureFromTransaction(signedTx);
}
```

## Burn Tokens

```typescript
import { getBurnInstruction } from "@solana-program/token";

async function burnTokens(
  owner: KeyPairSigner,
  mint: Address,
  amount: bigint
) {
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner: owner.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(owner, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstruction(
      getBurnInstruction({
        mint,
        account: ata,
        authority: owner,
        amount,
      }),
      tx
    ),
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  return getSignatureFromTransaction(signedTx);
}
```

## Get Token Balance

```typescript
async function getTokenBalance(wallet: Address, mint: Address) {
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner: wallet,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  try {
    const balance = await rpc.getTokenAccountBalance(ata).send();
    return {
      amount: BigInt(balance.value.amount),
      decimals: balance.value.decimals,
      uiAmount: balance.value.uiAmount,
    };
  } catch {
    // Account doesn't exist
    return { amount: 0n, decimals: 0, uiAmount: 0 };
  }
}
```

## List All Token Accounts

```typescript
async function getAllTokenAccounts(wallet: Address) {
  const accounts = await rpc.getTokenAccountsByOwner(
    wallet,
    { programId: TOKEN_PROGRAM_ADDRESS },
    { encoding: "jsonParsed" }
  ).send();

  return accounts.value.map((account) => ({
    pubkey: account.pubkey,
    mint: account.account.data.parsed.info.mint,
    balance: account.account.data.parsed.info.tokenAmount.uiAmount,
    decimals: account.account.data.parsed.info.tokenAmount.decimals,
  }));
}

// Usage
const tokens = await getAllTokenAccounts(address("WalletAddress..."));
for (const token of tokens) {
  console.log(`${token.mint}: ${token.balance}`);
}
```

## Create Token with Metadata (Token-2022)

```typescript
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getInitializeMetadataPointerInstruction,
  getInitializeInstruction as getInitializeMetadataInstruction,
  getMintSize as getMint2022Size,
  ExtensionType,
} from "@solana-program/token-2022";

async function createTokenWithMetadata(
  name: string,
  symbol: string,
  uri: string,
  decimals: number = 9
) {
  const mint = await generateKeyPairSigner();

  // Calculate space with metadata extension
  const mintSpace = getMint2022Size([ExtensionType.MetadataPointer]);

  const mintRent = await rpc.getMinimumBalanceForRentExemption(BigInt(mintSpace)).send();

  const instructions = [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: mintRent,
      space: BigInt(mintSpace),
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeMetadataPointerInstruction({
      mint: mint.address,
      authority: mintAuthority.address,
      metadataAddress: mint.address,  // Metadata stored in mint account
    }),
    getInitializeMintInstruction({
      mint: mint.address,
      decimals,
      mintAuthority: mintAuthority.address,
      freezeAuthority: null,
    }),
    getInitializeMetadataInstruction({
      mint: mint.address,
      updateAuthority: mintAuthority.address,
      name,
      symbol,
      uri,
    }),
  ];

  // ... build and send transaction
}
```

## Helper: Token Factory

```typescript
class TokenFactory {
  constructor(
    private rpc: Rpc,
    private rpcSubscriptions: RpcSubscriptions,
    private payer: KeyPairSigner
  ) {}

  private get sendAndConfirm() {
    return sendAndConfirmTransactionFactory({
      rpc: this.rpc,
      rpcSubscriptions: this.rpcSubscriptions,
    });
  }

  async createMint(decimals: number, mintAuthority: Address) {
    const mint = await generateKeyPairSigner();
    const mintSpace = BigInt(getMintSize());
    const mintRent = await this.rpc.getMinimumBalanceForRentExemption(mintSpace).send();
    const { value: blockhash } = await this.rpc.getLatestBlockhash().send();

    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(this.payer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
      (tx) => appendTransactionMessageInstructions([
        getCreateAccountInstruction({
          payer: this.payer,
          newAccount: mint,
          lamports: mintRent,
          space: mintSpace,
          programAddress: TOKEN_PROGRAM_ADDRESS,
        }),
        getInitializeMintInstruction({
          mint: mint.address,
          decimals,
          mintAuthority,
          freezeAuthority: null,
        }),
      ], tx),
    );

    const signedTx = await signTransactionMessageWithSigners(tx);
    await this.sendAndConfirm(signedTx, { commitment: "confirmed" });

    return mint.address;
  }

  async mintTo(mint: Address, recipient: Address, authority: KeyPairSigner, amount: bigint) {
    const [ata] = await findAssociatedTokenPda({
      mint,
      owner: recipient,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const { value: blockhash } = await this.rpc.getLatestBlockhash().send();

    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(this.payer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
      (tx) => appendTransactionMessageInstructions([
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          mint,
          owner: recipient,
          payer: this.payer,
        }),
        getMintToInstruction({
          mint,
          token: ata,
          mintAuthority: authority,
          amount,
        }),
      ], tx),
    );

    const signedTx = await signTransactionMessageWithSigners(tx);
    await this.sendAndConfirm(signedTx, { commitment: "confirmed" });

    return ata;
  }
}

// Usage
const factory = new TokenFactory(rpc, rpcSubscriptions, payer);
const mintAddress = await factory.createMint(9, mintAuthority.address);
const ata = await factory.mintTo(mintAddress, recipient, mintAuthority, 1000n * 10n ** 9n);
```
