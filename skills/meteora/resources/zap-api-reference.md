# Zap SDK API Reference

The Zap SDK enables single-token entry and exit for Meteora liquidity positions, automatically handling the swap and deposit/withdrawal in a single transaction.

## Installation

```bash
npm install @meteora-ag/zap-sdk
# or
yarn add @meteora-ag/zap-sdk
```

## Program ID

```
Mainnet/Devnet: zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz
```

## Prerequisites

**Jupiter API Key Required**: As of January 2026, Jupiter mandates an API key for all requests. Obtain keys through the [Jupiter Portal](https://portal.jup.ag).

---

## Initialization

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { Zap } from '@meteora-ag/zap-sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
const JUPITER_API_KEY = 'your-api-key';

const zap = new Zap(connection, JUPITER_API_URL, JUPITER_API_KEY);
```

---

## Zap In Functions

### zapInDlmm

Zap single token into a DLMM concentrated liquidity position.

```typescript
const tx = await zap.zapInDlmm({
  user: PublicKey,           // User's public key
  lbPairAddress: PublicKey,  // DLMM pool address
  inputMint: PublicKey,      // Token to deposit
  inputAmount: BN,           // Amount in base units
  slippageBps: number,       // Slippage tolerance (100 = 1%)
  positionPubkey: PublicKey, // Position address (new or existing)
  strategyType: string,      // 'SpotBalanced', 'SpotOneSide', etc.
  minBinId: number,          // Lower bin ID for position
  maxBinId: number,          // Upper bin ID for position
});
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `user` | `PublicKey` | Wallet address signing the transaction |
| `lbPairAddress` | `PublicKey` | DLMM pool (LB pair) address |
| `inputMint` | `PublicKey` | Token mint to deposit |
| `inputAmount` | `BN` | Amount in base units (lamports) |
| `slippageBps` | `number` | Slippage tolerance in basis points |
| `positionPubkey` | `PublicKey` | Position address |
| `strategyType` | `string` | Distribution strategy type |
| `minBinId` | `number` | Lower bound bin ID |
| `maxBinId` | `number` | Upper bound bin ID |

**Strategy Types:**
- `SpotBalanced` - Balanced around current price
- `SpotOneSide` - Single-sided liquidity
- `CurveBalanced` - Curve distribution around current price
- `BidAskBalanced` - Bid/ask distribution

---

### zapInDammV2

Zap single token into a DAMM v2 position.

```typescript
const tx = await zap.zapInDammV2({
  user: PublicKey,           // User's public key
  poolAddress: PublicKey,    // DAMM v2 pool address
  inputMint: PublicKey,      // Token to deposit
  inputAmount: BN,           // Amount in base units
  slippageBps: number,       // Slippage tolerance
  positionPubkey: PublicKey, // Position address
});
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `user` | `PublicKey` | Wallet address |
| `poolAddress` | `PublicKey` | DAMM v2 pool address |
| `inputMint` | `PublicKey` | Token mint to deposit |
| `inputAmount` | `BN` | Amount in base units |
| `slippageBps` | `number` | Slippage tolerance |
| `positionPubkey` | `PublicKey` | Position NFT address |

---

## Zap Out Functions

### zapOutDlmm

Zap out from DLMM position to a single token.

```typescript
const tx = await zap.zapOutDlmm({
  user: PublicKey,            // User's public key
  lbPairAddress: PublicKey,   // DLMM pool address
  outputMint: PublicKey,      // Token to receive
  positionPubkey: PublicKey,  // Position address
  percentageToZap: number,    // 1-100 percentage to withdraw
  slippageBps: number,        // Slippage tolerance
});
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `user` | `PublicKey` | Wallet address |
| `lbPairAddress` | `PublicKey` | DLMM pool address |
| `outputMint` | `PublicKey` | Token mint to receive |
| `positionPubkey` | `PublicKey` | Position address |
| `percentageToZap` | `number` | Percentage of position (1-100) |
| `slippageBps` | `number` | Slippage tolerance |

---

### zapOutDammV2

Zap out from DAMM v2 position to a single token.

```typescript
const tx = await zap.zapOutDammV2({
  user: PublicKey,
  poolAddress: PublicKey,
  outputMint: PublicKey,
  positionPubkey: PublicKey,
  percentageToZap: number,
  slippageBps: number,
});
```

---

### zapOutThroughJupiter

Zap out using Jupiter aggregator for optimal routing.

```typescript
const tx = await zap.zapOutThroughJupiter({
  user: PublicKey,              // User's public key
  inputMint: PublicKey,         // Token to swap from
  outputMint: PublicKey,        // Token to receive
  inputTokenProgram: PublicKey, // Token program for input
  outputTokenProgram: PublicKey,// Token program for output
  jupiterSwapResponse: object,  // Response from Jupiter quote API
  maxSwapAmount: BN,            // Maximum amount to swap
  percentageToZap: number,      // Percentage to zap
});
```

---

## Helper Functions

### getJupiterQuote

Get a quote from Jupiter for swap routing.

```typescript
const quote = await zap.getJupiterQuote({
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN,
  slippageBps: number,
  onlyDirectRoutes?: boolean,
  excludeDexes?: string[],
});
```

**Returns:**
```typescript
{
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: RouteStep[];
}
```

---

### getJupiterSwapInstruction

Get swap instruction from Jupiter quote.

```typescript
const swapIx = await zap.getJupiterSwapInstruction(
  jupiterQuote: object,
  userPublicKey: PublicKey
);
```

---

### getTokenProgramFromMint

Retrieve the token program associated with a mint.

```typescript
const tokenProgram = await zap.getTokenProgramFromMint(
  connection: Connection,
  mintAddress: PublicKey
);
// Returns: TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
```

---

## Complete Examples

### Zap Into DLMM with SOL

```typescript
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Zap } from '@meteora-ag/zap-sdk';
import BN from 'bn.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const wallet = Keypair.fromSecretKey(/* your key */);

const zap = new Zap(
  connection,
  'https://quote-api.jup.ag/v6',
  'your-jupiter-api-key'
);

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const dlmmPool = new PublicKey('POOL_ADDRESS');
const position = Keypair.generate();

// Get active bin for price reference
const dlmm = await DLMM.create(connection, dlmmPool);
const activeBin = await dlmm.getActiveBin();

const zapInTx = await zap.zapInDlmm({
  user: wallet.publicKey,
  lbPairAddress: dlmmPool,
  inputMint: SOL_MINT,
  inputAmount: new BN(1_000_000_000), // 1 SOL
  slippageBps: 100,
  positionPubkey: position.publicKey,
  strategyType: 'SpotBalanced',
  minBinId: activeBin.binId - 10,
  maxBinId: activeBin.binId + 10,
});

const txId = await sendAndConfirmTransaction(connection, zapInTx, [wallet, position]);
console.log('Zap in complete:', txId);
```

### Zap Out to USDC

```typescript
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

const zapOutTx = await zap.zapOutDlmm({
  user: wallet.publicKey,
  lbPairAddress: dlmmPool,
  outputMint: USDC_MINT,
  positionPubkey: position.publicKey,
  percentageToZap: 100, // Full withdrawal
  slippageBps: 100,
});

const txId = await sendAndConfirmTransaction(connection, zapOutTx, [wallet]);
console.log('Zap out complete:', txId);
```

---

## Error Handling

```typescript
try {
  const tx = await zap.zapInDlmm(params);
  await sendAndConfirmTransaction(connection, tx, [wallet]);
} catch (error) {
  if (error.message.includes('Slippage')) {
    console.error('Slippage exceeded - increase tolerance');
  } else if (error.message.includes('InsufficientBalance')) {
    console.error('Not enough tokens for zap');
  } else if (error.message.includes('InvalidMint')) {
    console.error('Token not supported by pool');
  } else {
    throw error;
  }
}
```

---

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Jupiter API key required` | Missing API key | Get key from Jupiter Portal |
| `Slippage exceeded` | Price moved beyond tolerance | Increase slippageBps |
| `Insufficient balance` | Not enough tokens | Check wallet balance |
| `Invalid position` | Position doesn't exist | Create position first |
| `Route not found` | No swap path available | Try different output token |

---

## Related Resources

- [Zap SDK GitHub](https://github.com/MeteoraAg/zap-sdk)
- [Zap Program GitHub](https://github.com/MeteoraAg/zap-program)
- [Jupiter API Docs](https://station.jup.ag/docs)
- [Meteora Documentation](https://docs.meteora.ag)
