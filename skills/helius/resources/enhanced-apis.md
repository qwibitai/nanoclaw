# Enhanced APIs Reference

Complete reference for Helius Enhanced Transactions API and Priority Fee API.

## Enhanced Transactions API

Get parsed, human-readable transaction data with decoded instructions and context.

### getTransactions

Parse transactions by signature.

```typescript
const parsed = await helius.enhanced.getTransactions({
  transactions: [
    "5wHu1qwD7q5...signature1",
    "3kNqXz9Rp2...signature2",
    "7mYtBvCx8w...signature3",
  ],
});
```

**Direct API Call:**

```typescript
const response = await fetch(
  `https://api.helius.xyz/v0/transactions?api-key=${API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transactions: ["signature1", "signature2"],
    }),
  }
);

const parsed = await response.json();
```

**Response Structure:**

```typescript
interface EnhancedTransaction {
  signature: string;
  slot: number;
  timestamp: number;
  fee: number;
  feePayer: string;
  type: TransactionType;
  source: TransactionSource;
  description: string;

  // Native SOL transfers
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number; // lamports
  }>;

  // Token transfers
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
    tokenStandard: string;
  }>;

  // Account data changes
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      userAccount: string;
      tokenAccount: string;
      mint: string;
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
    }>;
  }>;

  // Parsed events (swaps, NFT sales, etc.)
  events: {
    swap?: SwapEvent;
    nft?: NftEvent;
    compressed?: CompressedNftEvent;
  };

  // Raw instruction data
  instructions: Array<{
    accounts: string[];
    data: string;
    programId: string;
    innerInstructions: Array<{...}>;
  }>;
}
```

### getTransactionsByAddress

Get parsed transaction history for an address.

```typescript
// Via SDK
const history = await helius.enhanced.getTransactionsByAddress({
  address: "wallet_address",
  type: "SWAP",        // Optional filter
  source: "JUPITER",   // Optional filter
});

// Via REST API
const response = await fetch(
  `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${API_KEY}&type=SWAP`
);

const transactions = await response.json();
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `address` | string | Wallet or account address |
| `type` | string | Filter by transaction type |
| `source` | string | Filter by source/protocol |
| `before` | string | Signature to paginate before |
| `until` | string | Signature to stop at |
| `limit` | number | Max results (default: 100) |

### Transaction Types

| Type | Description |
|------|-------------|
| `UNKNOWN` | Unrecognized transaction |
| `TRANSFER` | SOL or token transfer |
| `SWAP` | DEX swap |
| `NFT_SALE` | NFT marketplace sale |
| `NFT_LISTING` | NFT listed for sale |
| `NFT_CANCEL_LISTING` | Listing cancelled |
| `NFT_BID` | Bid placed on NFT |
| `NFT_BID_CANCELLED` | Bid cancelled |
| `NFT_MINT` | NFT minted |
| `NFT_AUCTION_CREATED` | Auction started |
| `NFT_AUCTION_UPDATED` | Auction modified |
| `NFT_AUCTION_CANCELLED` | Auction cancelled |
| `NFT_PARTICIPATION_REWARD` | Auction participation reward |
| `NFT_MINT_REJECTED` | Mint rejected |
| `TOKEN_MINT` | Token minted |
| `BURN` | Token/NFT burned |
| `BURN_NFT` | NFT specifically burned |
| `PLATFORM_FEE` | Protocol fee paid |
| `LOAN` | Lending protocol loan |
| `REPAY_LOAN` | Loan repayment |
| `ADD_TO_POOL` | Liquidity added |
| `REMOVE_FROM_POOL` | Liquidity removed |
| `CLOSE_POSITION` | Position closed |
| `UNLABELED` | Transaction with no clear type |
| `CLOSE_ACCOUNT` | Account closed |
| `WITHDRAW` | Withdrawal from protocol |
| `DEPOSIT` | Deposit to protocol |
| `STAKE` | SOL staked |
| `UNSTAKE` | SOL unstaked |
| `STAKE_SOL` | Liquid staking |
| `UNSTAKE_SOL` | Liquid unstaking |
| `MERGE_STAKE` | Stake accounts merged |
| `SPLIT_STAKE` | Stake account split |
| `COMPRESSED_NFT_MINT` | cNFT minted |
| `COMPRESSED_NFT_TRANSFER` | cNFT transferred |
| `COMPRESSED_NFT_BURN` | cNFT burned |

### Transaction Sources

| Source | Protocol |
|--------|----------|
| `FORM_FUNCTION` | Form Function |
| `EXCHANGE_ART` | Exchange Art |
| `CANDY_MACHINE_V3` | Metaplex CM V3 |
| `CANDY_MACHINE_V2` | Metaplex CM V2 |
| `CANDY_MACHINE_V1` | Metaplex CM V1 |
| `MAGIC_EDEN` | Magic Eden |
| `MAGIC_EDEN_V2` | Magic Eden V2 |
| `HOLAPLEX` | Holaplex |
| `METAPLEX` | Metaplex |
| `OPENSEA` | OpenSea |
| `SOLANA_PROGRAM_LIBRARY` | SPL |
| `ANCHOR` | Anchor |
| `PHANTOM` | Phantom |
| `SYSTEM_PROGRAM` | System Program |
| `STAKE_PROGRAM` | Stake Program |
| `RAYDIUM` | Raydium |
| `JUPITER` | Jupiter |
| `ORCA` | Orca |
| `TENSOR` | Tensor |
| `TENSOR_CNFT` | Tensor cNFT |
| `SOLSEA` | SolSea |
| `SOLANART` | Solanart |
| `DIGITALLEYES` | DigitalEyes |
| `SERUM` | Serum DEX |
| `MANGO` | Mango Markets |
| `SOLEND` | Solend |
| `MARINADE` | Marinade Finance |
| `JITO` | Jito |
| `HELIUS` | Helius |
| `WORMHOLE` | Wormhole |
| `DEBRIDGE` | deBridge |
| `ALLBRIDGE` | AllBridge |
| `STEPN` | STEPN |
| `BUBBLEGUM` | Metaplex Bubblegum |

---

## Priority Fee API

Get real-time priority fee recommendations based on network conditions.

### getPriorityFeeEstimate

```typescript
const estimate = await helius.getPriorityFeeEstimate({
  // Option 1: Provide transaction
  transaction: base64EncodedTransaction,

  // Option 2: Provide account keys
  accountKeys: ["account1", "account2", "account3"],

  // Options
  options: {
    priorityLevel: "HIGH",
    includeAllPriorityFeeLevels: true,
    lookbackSlots: 150,
    includeVote: false,
    recommended: true,
  },
});
```

**Direct API Call:**

```typescript
const response = await fetch(RPC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getPriorityFeeEstimate",
    params: [{
      accountKeys: ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"],
      options: {
        priorityLevel: "HIGH",
      },
    }],
  }),
});

const { result } = await response.json();
console.log(result.priorityFeeEstimate); // microLamports
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `transaction` | string | Base64 encoded transaction |
| `accountKeys` | string[] | Account addresses in transaction |
| `options.priorityLevel` | string | LOW, MEDIUM, HIGH, VERY_HIGH |
| `options.includeAllPriorityFeeLevels` | boolean | Return all fee levels |
| `options.lookbackSlots` | number | Slots to analyze (default: 150) |
| `options.includeVote` | boolean | Include vote transactions |
| `options.recommended` | boolean | Use recommended heuristics |

**Response:**

```typescript
interface PriorityFeeEstimate {
  priorityFeeEstimate: number; // microLamports

  // If includeAllPriorityFeeLevels: true
  priorityFeeLevels?: {
    min: number;
    low: number;
    medium: number;
    high: number;
    veryHigh: number;
    unsafeMax: number;
  };
}
```

### Priority Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| `LOW` | 25th percentile | Non-urgent transactions |
| `MEDIUM` | 50th percentile | Standard transactions |
| `HIGH` | 75th percentile | Time-sensitive trades |
| `VERY_HIGH` | 95th percentile | Critical operations |
| `UNSAFE_MAX` | Maximum observed | Emergency only |

### Using Priority Fees

```typescript
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  prependTransactionMessageInstructions,
  appendTransactionMessageInstruction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

async function buildOptimizedTransaction(
  rpc: Rpc,
  helius: Helius,
  signer: KeyPairSigner,
  instruction: IInstruction
) {
  // 1. Get accounts that will be used
  const accountKeys = [signer.address, /* other accounts */];

  // 2. Get priority fee estimate
  const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
    accountKeys,
    options: { priorityLevel: "HIGH" },
  });

  // 3. Get latest blockhash
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  // 4. Build transaction with compute budget instructions
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => prependTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 200_000 }),
      getSetComputeUnitPriceInstruction({
        microLamports: BigInt(priorityFeeEstimate)
      }),
    ], tx),
    (tx) => appendTransactionMessageInstruction(instruction, tx),
  );

  return tx;
}
```

### Dynamic Fee Adjustment

```typescript
async function sendWithDynamicFees(
  helius: Helius,
  rpc: Rpc,
  transaction: Transaction,
  options: { maxRetries: number; startLevel: string }
) {
  const levels = ["MEDIUM", "HIGH", "VERY_HIGH"];
  let levelIndex = levels.indexOf(options.startLevel);

  for (let i = 0; i < options.maxRetries; i++) {
    const level = levels[Math.min(levelIndex, levels.length - 1)];

    const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
      transaction: getBase64EncodedWireTransaction(transaction),
      options: { priorityLevel: level },
    });

    // Update transaction with new fee
    const updatedTx = await updateTransactionFee(
      transaction,
      priorityFeeEstimate
    );

    try {
      const sig = await helius.tx.sendSmartTransaction({
        transaction: getBase64EncodedWireTransaction(updatedTx),
      });
      return sig;
    } catch (error) {
      if (error.message.includes("blockhash")) {
        // Blockhash expired, rebuild transaction
        throw error;
      }
      // Increase priority level for retry
      levelIndex++;
    }
  }

  throw new Error("Failed to land transaction after max retries");
}
```

### Fee Estimation Best Practices

1. **Use account keys for estimates** when possible - more accurate than transaction-based estimates for planning

2. **Cache estimates briefly** - Fee conditions don't change rapidly, 5-10 second cache is reasonable

3. **Start with MEDIUM** - Upgrade to HIGH only if transactions fail to land

4. **Set appropriate compute limits** - Overestimating wastes fees, underestimating fails transactions

5. **Monitor fee trends** - Use `includeAllPriorityFeeLevels` to understand current network state

```typescript
async function getNetworkFeeState(helius: Helius) {
  const { priorityFeeLevels } = await helius.getPriorityFeeEstimate({
    accountKeys: ["11111111111111111111111111111111"], // System program
    options: { includeAllPriorityFeeLevels: true },
  });

  return {
    isCongestedNetwork: priorityFeeLevels.high > 100_000,
    recommendedFee: priorityFeeLevels.medium,
    urgentFee: priorityFeeLevels.high,
  };
}
```
