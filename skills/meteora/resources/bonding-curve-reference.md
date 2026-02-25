# Dynamic Bonding Curve SDK Reference

Complete API reference for the `@meteora-ag/dynamic-bonding-curve-sdk` package.

## Installation

```bash
npm install @meteora-ag/dynamic-bonding-curve-sdk
```

## DynamicBondingCurve Class

### Constructor

```typescript
import { DynamicBondingCurve } from '@meteora-ag/dynamic-bonding-curve-sdk';

const dbc = new DynamicBondingCurve(
  connection: Connection,
  commitment: Commitment = 'confirmed'
);
```

## Core Flow

The Dynamic Bonding Curve follows a 5-step progression:

```
1. Partner Configuration → 2. Pool Creation → 3. Trading Phase → 4. Graduation → 5. Post-Graduation Trading
```

## Pool Management Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `createPool(params)` | Create new bonding curve pool | `CreatePoolParams` | `Promise<Transaction>` |
| `fetchPoolState(address)` | Get pool state | `PublicKey` | `Promise<PoolState>` |
| `fetchConfigState(address)` | Get config state | `PublicKey` | `Promise<ConfigState>` |
| `getAllPools()` | Fetch all DBC pools | - | `Promise<PoolState[]>` |

## Trading Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `buy(params)` | Buy tokens on bonding curve | `BuyParams` | `Promise<Transaction>` |
| `sell(params)` | Sell tokens on bonding curve | `SellParams` | `Promise<Transaction>` |
| `getBuyQuote(params)` | Get quote for buying | `BuyQuoteParams` | `Promise<BuyQuote>` |
| `getSellQuote(params)` | Get quote for selling | `SellQuoteParams` | `Promise<SellQuote>` |

## Migration Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `migrateToDAMMV1(params)` | Migrate to DAMM v1 | `MigrateParams` | `Promise<Transaction>` |
| `migrateToDAMMV2(params)` | Migrate to DAMM v2 | `MigrateParams` | `Promise<Transaction>` |
| `createMetadata(params)` | Create token metadata (v1 migration) | `MetadataParams` | `Promise<Transaction>` |
| `lockLpTokens(params)` | Lock LP tokens | `LockLpParams` | `Promise<Transaction>` |
| `claimLpTokens(params)` | Claim LP after lock | `ClaimLpParams` | `Promise<Transaction>` |

## Types

### PoolState

```typescript
interface PoolState {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  config: PublicKey;
  creator: PublicKey;
  baseReserve: BN;
  quoteReserve: BN;
  totalSupply: BN;
  graduated: boolean;
  graduationThreshold: BN;
  currentMarketCap: BN;
  tradingFeeRate: BN;
  migrationFeeRate: BN;
  createdAt: BN;
  graduatedAt: BN | null;
}
```

### ConfigState

```typescript
interface ConfigState {
  authority: PublicKey;
  feeTier: number;
  tradingFeeRate: BN;
  migrationFeeRate: BN;
  graduationThreshold: BN;
  migrationTarget: number;  // 0 = DAMM v1, 1 = DAMM v2
  curveType: number;
  curveParams: CurveParams;
}
```

### BuyQuote

```typescript
interface BuyQuote {
  baseAmount: BN;        // Tokens to receive
  quoteAmount: BN;       // Quote to spend (including fees)
  fee: BN;               // Trading fee
  price: Decimal;        // Current price
  priceImpact: Decimal;  // Price impact percentage
  minBaseAmount: BN;     // Minimum tokens with slippage
}
```

### SellQuote

```typescript
interface SellQuote {
  baseAmount: BN;         // Tokens to sell
  quoteAmount: BN;        // Quote to receive
  fee: BN;                // Trading fee
  price: Decimal;         // Current price
  priceImpact: Decimal;   // Price impact percentage
  minQuoteAmount: BN;     // Minimum quote with slippage
}
```

## Parameter Interfaces

### CreatePoolParams

```typescript
interface CreatePoolParams {
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  config: PublicKey;
  baseAmount: BN;
  quoteAmount: BN;
  name: string;
  symbol: string;
  uri: string;
}
```

### BuyParams

```typescript
interface BuyParams {
  payer: PublicKey;
  pool: PublicKey;
  quoteAmount: BN;
  minBaseAmount: BN;
}
```

### SellParams

```typescript
interface SellParams {
  payer: PublicKey;
  pool: PublicKey;
  baseAmount: BN;
  minQuoteAmount: BN;
}
```

### MigrateParams

```typescript
interface MigrateParams {
  pool: PublicKey;
  payer: PublicKey;
}
```

### LockLpParams

```typescript
interface LockLpParams {
  pool: PublicKey;
  payer: PublicKey;
  lockDuration: BN;  // Duration in seconds
}
```

## Fee Tier Configurations

| Tier | Fee (bps) | Trading Fee | Migration Fee | Use Case |
|------|-----------|-------------|---------------|----------|
| 1 | 25 | 0.25% | 0.25% | Standard launches |
| 2 | 50 | 0.50% | 0.50% | Community tokens |
| 3 | 100 | 1.00% | 1.00% | Meme tokens |
| 4 | 200 | 2.00% | 2.00% | High volatility |
| 5 | 400 | 4.00% | 4.00% | Experimental |
| 6 | 600 | 6.00% | 6.00% | Maximum protection |

## Bonding Curve Types

### Linear Curve

```
Price = a + b * supply
```

Where:
- `a` = base price
- `b` = slope

### Exponential Curve

```
Price = a * e^(b * supply)
```

Where:
- `a` = base multiplier
- `b` = growth rate

### Sigmoid Curve

```
Price = L / (1 + e^(-k * (supply - x0)))
```

Where:
- `L` = maximum price
- `k` = steepness
- `x0` = midpoint

## Usage Examples

### Launch Token on Bonding Curve

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { DynamicBondingCurve } from '@meteora-ag/dynamic-bonding-curve-sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const dbc = new DynamicBondingCurve(connection, 'confirmed');

// Create bonding curve pool
const createTx = await dbc.createPool({
  creator: wallet.publicKey,
  baseMint: tokenMint,
  quoteMint: NATIVE_MINT, // SOL
  config: configAddress,
  baseAmount: new BN(1_000_000_000_000), // 1M tokens (6 decimals)
  quoteAmount: new BN(0),
  name: 'My Token',
  symbol: 'MTK',
  uri: 'https://arweave.net/metadata.json',
});

await sendAndConfirmTransaction(connection, createTx, [wallet]);
```

### Buy Tokens

```typescript
// Get buy quote
const buyQuote = await dbc.getBuyQuote({
  pool: poolAddress,
  quoteAmount: new BN(1_000_000_000), // 1 SOL
});

console.log('Tokens to receive:', buyQuote.baseAmount.toString());
console.log('Price:', buyQuote.price.toString());
console.log('Price Impact:', buyQuote.priceImpact.toString(), '%');

// Execute buy with 1% slippage
const slippageBps = 100;
const minTokens = buyQuote.baseAmount.mul(new BN(10000 - slippageBps)).div(new BN(10000));

const buyTx = await dbc.buy({
  payer: wallet.publicKey,
  pool: poolAddress,
  quoteAmount: new BN(1_000_000_000),
  minBaseAmount: minTokens,
});

await sendAndConfirmTransaction(connection, buyTx, [wallet]);
```

### Sell Tokens

```typescript
// Get sell quote
const sellQuote = await dbc.getSellQuote({
  pool: poolAddress,
  baseAmount: new BN(1_000_000), // 1 token
});

console.log('SOL to receive:', sellQuote.quoteAmount.toString());
console.log('Price:', sellQuote.price.toString());

// Execute sell
const sellTx = await dbc.sell({
  payer: wallet.publicKey,
  pool: poolAddress,
  baseAmount: new BN(1_000_000),
  minQuoteAmount: sellQuote.minQuoteAmount,
});

await sendAndConfirmTransaction(connection, sellTx, [wallet]);
```

### Check Graduation Status

```typescript
const poolState = await dbc.fetchPoolState(poolAddress);

console.log('Graduated:', poolState.graduated);
console.log('Current Market Cap:', poolState.currentMarketCap.toString());
console.log('Graduation Threshold:', poolState.graduationThreshold.toString());

const progress = poolState.currentMarketCap.mul(new BN(100)).div(poolState.graduationThreshold);
console.log('Progress:', progress.toString(), '%');
```

### Migrate to DAMM v2

```typescript
// Check if graduated
const poolState = await dbc.fetchPoolState(poolAddress);
if (!poolState.graduated) {
  console.log('Pool not yet graduated');
  return;
}

// Migrate to DAMM v2
const migrateTx = await dbc.migrateToDAMMV2({
  pool: poolAddress,
  payer: wallet.publicKey,
});

await sendAndConfirmTransaction(connection, migrateTx, [wallet]);
console.log('Successfully migrated to DAMM v2');
```

### DAMM v1 Migration (Full Flow)

```typescript
// Step 1: Create metadata
const metadataTx = await dbc.createMetadata({
  pool: poolAddress,
  payer: wallet.publicKey,
});
await sendAndConfirmTransaction(connection, metadataTx, [wallet]);

// Step 2: Migrate
const migrateTx = await dbc.migrateToDAMMV1({
  pool: poolAddress,
  payer: wallet.publicKey,
});
await sendAndConfirmTransaction(connection, migrateTx, [wallet]);

// Step 3: Lock LP tokens (optional but recommended)
const lockTx = await dbc.lockLpTokens({
  pool: poolAddress,
  payer: wallet.publicKey,
  lockDuration: new BN(86400 * 365), // 1 year
});
await sendAndConfirmTransaction(connection, lockTx, [wallet]);

// Step 4: Claim LP tokens (after lock expires)
const claimTx = await dbc.claimLpTokens({
  pool: poolAddress,
  payer: wallet.publicKey,
});
await sendAndConfirmTransaction(connection, claimTx, [wallet]);
```

## Manual Migrator

For pools that haven't auto-graduated, use the web interface:

- **Mainnet**: https://migrator.meteora.ag
- **Devnet**: https://migrator.meteora.ag/devnet

## Program Address

| Network | Address |
|---------|---------|
| Mainnet-beta | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| Devnet | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
