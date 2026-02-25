# Kamino Liquidity SDK (kliquidity-sdk) API Reference

Complete API reference for `@kamino-finance/kliquidity-sdk`.

## Installation

```bash
npm install @kamino-finance/kliquidity-sdk
# or
yarn add @kamino-finance/kliquidity-sdk
```

## Core Class: Kamino

Main entry point for liquidity management operations.

```typescript
import { Kamino } from "@kamino-finance/kliquidity-sdk";
import { Connection, clusterApiUrl } from "@solana/web3.js";

const connection = new Connection(clusterApiUrl("mainnet-beta"));
const kamino = new Kamino("mainnet-beta", connection);
```

### Constructor

```typescript
constructor(
  cluster: SolanaCluster,           // "mainnet-beta" | "devnet"
  rpc: Rpc<SolanaRpcApi> | Connection,
  globalConfig?: Address,
  programId?: Address,
  whirlpoolProgramId?: Address,
  raydiumProgramId?: Address,
  meteoraProgramId?: Address,
  jupBaseAPI?: string,
  kSwapBaseAPI?: string
)
```

## Connection & Configuration

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getConnection()` | `Rpc<SolanaRpcApi>` | Get current RPC connection |
| `getProgramID()` | `Address` | Get Kamino program ID |
| `getGlobalConfig()` | `Address` | Get global config address |
| `setGlobalConfig(config)` | `void` | Set global config |
| `getSupportedDexes()` | `Dex[]` | Get supported DEX integrations |

## Token & Collateral Methods

### Get Available Tokens

```typescript
// Get all depositable tokens
const tokens = await kamino.getDepositableTokens();

// Get collateral info
const collateralInfos = await kamino.getCollateralInfos();

// Get disabled token prices
const disabledPrices = await kamino.getDisabledTokensPrices(collateralInfos);
```

### Methods Reference

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getDepositableTokens` | `()` | `Promise<CollateralInfo[]>` | All depositable tokens |
| `getCollateralInfos` | `()` | `Promise<CollateralInfo[]>` | All collateral information |
| `getDisabledTokensPrices` | `collateralInfos?: CollateralInfo[]` | `Promise<Map<Address, Decimal>>` | Prices for disabled tokens |

## Strategy Retrieval

### Get All Strategies

```typescript
// Get all strategies
const strategies = await kamino.getStrategies();

// Get strategies with addresses
const strategiesWithAddresses = await kamino.getStrategiesWithAddresses();

// Get by address
const strategy = await kamino.getStrategyByAddress(strategyAddress);

// Get by kToken mint
const strategyByMint = await kamino.getStrategyByKTokenMint(kTokenMint);
```

### Filtered Strategy Retrieval

```typescript
const filteredStrategies = await kamino.getAllStrategiesWithFilters({
  strategyType: "NON_PEGGED",  // Strategy type filter
  status: "LIVE",               // Status filter
  tokenA: tokenAMint,           // Token A filter
  tokenB: tokenBMint,           // Token B filter
  dex: "ORCA",                  // DEX filter
});
```

### Methods Reference

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getStrategies` | `strategies?: Address[]` | `Promise<(WhirlpoolStrategy \| null)[]>` | Get strategies |
| `getStrategiesWithAddresses` | `strategies?: Address[]` | `Promise<StrategyWithAddress[]>` | Get with addresses |
| `getStrategyByAddress` | `address: Address` | `Promise<WhirlpoolStrategy \| null>` | Get single strategy |
| `getStrategyByKTokenMint` | `kTokenMint: Address` | `Promise<StrategyWithAddress \| null>` | Get by kToken |
| `getAllStrategiesWithFilters` | `filters: StrategiesFilters` | `Promise<StrategyWithAddress[]>` | Filtered retrieval |

## Strategy Types & Filters

### StrategiesFilters Interface

```typescript
interface StrategiesFilters {
  strategyType?: StrategyType;
  status?: StrategyStatus;
  tokenA?: Address;
  tokenB?: Address;
  dex?: Dex;
  feeTier?: number;
}
```

### StrategyType Enum

```typescript
type StrategyType = "NON_PEGGED" | "PEGGED" | "STABLE";

// NON_PEGGED: Uncorrelated assets (SOL-BONK, SOL-USDC)
// PEGGED: Loosely correlated (BSOL-JitoSOL, mSOL-SOL)
// STABLE: Price-stable pairs (USDC-USDT, USDH-USDC)
```

### StrategyStatus Enum

```typescript
type StrategyStatus =
  | "LIVE"        // Active strategy
  | "STAGING"     // Testing phase
  | "DEPRECATED"  // Phased out
  | "SHADOW"      // Hidden strategy
  | "IGNORED";    // Excluded from lists
```

## Strategy Data Methods

### Share & Price Data

```typescript
// Get share price
const sharePrice = await kamino.getStrategySharePrice(strategy);

// Get detailed share data
const shareData = await kamino.getStrategyShareData(strategy, scopePrices);

// Get token amounts per share
const tokenAmounts = await kamino.getTokenAAndBPerShare(strategy);

// Get share data for multiple strategies
const allShareData = await kamino.getStrategiesShareData(filters, scopePrices);
```

### Methods Reference

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getStrategySharePrice` | `strategy: Address \| StrategyWithAddress` | `Promise<Decimal>` | Current share price |
| `getStrategyShareData` | `strategy, scopePrices?` | `Promise<ShareData>` | Detailed share data |
| `getTokenAAndBPerShare` | `strategy` | `Promise<TokenAmounts>` | Token amounts per share |
| `getStrategiesShareData` | `filters, scopePrices?` | `Promise<ShareDataWithAddress[]>` | Bulk share data |

### ShareData Interface

```typescript
interface ShareData {
  totalShares: Decimal;
  tokenAPerShare: Decimal;
  tokenBPerShare: Decimal;
  sharePrice: Decimal;
  tokenAAmount: Decimal;
  tokenBAmount: Decimal;
  tokenAMint: Address;
  tokenBMint: Address;
}

interface TokenAmounts {
  tokenA: Decimal;
  tokenB: Decimal;
}
```

### Position & Range Data

```typescript
// Get strategy price range
const range = await kamino.getStrategyRange(strategy);

// Get position range for specific DEX position
const positionRange = await kamino.getPositionRange(
  dex,
  positionAddress,
  decimalsA,
  decimalsB
);

// Get strategy holder info
const holder = await kamino.getStrategyHolder(strategy);
```

### PositionRange Interface

```typescript
interface PositionRange {
  lowerPrice: Decimal;
  upperPrice: Decimal;
  currentPrice: Decimal;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  isInRange: boolean;
  rangeWidth: Decimal;
}
```

## Deposit Operations

### Standard Deposit

```typescript
const depositIxs = await kamino.deposit(
  strategy,           // Strategy or address
  wallet,             // User wallet
  tokenAAmount,       // Amount of token A (Decimal)
  tokenBAmount,       // Amount of token B (Decimal)
  slippage           // Slippage tolerance (Decimal, e.g., 0.01 for 1%)
);
```

### Single Token Deposit

```typescript
const singleDepositIxs = await kamino.singleTokenDeposit(
  strategy,
  wallet,
  tokenAmount,
  isTokenA,   // true for Token A, false for Token B
  slippage
);
```

### Methods Reference

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `deposit` | `strategy, wallet, tokenAAmount, tokenBAmount, slippage` | `Promise<TransactionInstruction[]>` | Dual token deposit |
| `singleTokenDeposit` | `strategy, wallet, amount, isTokenA, slippage` | `Promise<TransactionInstruction[]>` | Single token deposit |
| `buildDepositTransaction` | `params` | `Promise<InstructionsWithLookupTables>` | Build with lookup tables |

## Withdrawal Operations

### Standard Withdrawal

```typescript
// Withdraw specific amount of shares
const withdrawIxs = await kamino.withdraw(
  strategy,
  wallet,
  shareAmount,    // Number of shares to withdraw
  slippage
);

// Withdraw all shares
const withdrawAllIxs = await kamino.withdrawAllShares(
  strategy,
  wallet,
  slippage
);
```

### Methods Reference

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `withdraw` | `strategy, wallet, shareAmount, slippage` | `Promise<TransactionInstruction[]>` | Partial withdrawal |
| `withdrawAllShares` | `strategy, wallet, slippage` | `Promise<TransactionInstruction[]>` | Full withdrawal |
| `buildWithdrawTransaction` | `params` | `Promise<InstructionsWithLookupTables>` | Build with lookup tables |

## Rebalancing

### Rebalance Methods

```typescript
// Get available rebalance methods
const methods = kamino.getRebalanceMethods();

// Get enabled methods
const enabledMethods = kamino.getEnabledRebalanceMethods();

// Get default method
const defaultMethod = kamino.getDefaultRebalanceMethod();

// Get rebalance type from fields
const rebalanceType = kamino.getRebalanceTypeFromRebalanceFields(fields);

// Execute rebalance
const rebalanceIxs = await kamino.rebalance(strategy, rebalanceParams);
```

### Read Rebalance Parameters

```typescript
// Read drift rebalance params
const driftParams = await kamino.readDriftRebalanceParams(strategy);

// Read periodic rebalance params
const periodicParams = await kamino.readPeriodicRebalanceParams(strategy);

// Read price percentage params
const priceParams = await kamino.readPricePercentageParams(strategy);
```

### RebalanceMethod Type

```typescript
type RebalanceMethod =
  | "MANUAL"           // Manual rebalancing
  | "DRIFT"            // Drift-based auto rebalance
  | "TAKE_PROFIT"      // Take profit triggers
  | "PERIODIC"         // Time-based rebalancing
  | "PRICE_PERCENTAGE" // Price deviation triggers
  | "EXPANDER"         // Range expansion
  | "AUTODRIFT";       // Automated drift
```

### Rebalance Field Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getRebalanceMethods` | `()` | `RebalanceMethod[]` | All rebalance methods |
| `getEnabledRebalanceMethods` | `()` | `RebalanceMethod[]` | Enabled methods |
| `getDefaultRebalanceMethod` | `()` | `RebalanceMethod` | Default method |
| `getFieldsForRebalanceMethod` | `method, dex, ...` | `Promise<RebalanceFieldInfo[]>` | Get field info |
| `getDefaultRebalanceFields` | `dex, tokenA, tokenB, ...` | `Promise<RebalanceFieldInfo[]>` | Default fields |

## Strategy Creation

### Create New Strategy

```typescript
const strategyKeypair = Keypair.generate();

// Create strategy account
const createAccountIx = await kamino.createStrategyAccount(
  strategyKeypair.publicKey
);

// Initialize strategy
const initIxs = await kamino.initializeStrategy(
  strategyKeypair.publicKey,
  adminWallet,
  {
    dex: "ORCA",
    tokenAMint,
    tokenBMint,
    feeTierBps: new Decimal(30),  // 0.3%
    rebalanceMethod: "DRIFT"
  }
);

// Close strategy
const closeIxs = await kamino.closeStrategy(strategy);

// Update config
const updateIxs = await kamino.updateStrategyConfig(strategy, newConfig);
```

### Methods Reference

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `createStrategy` | `params` | `Promise<CreateStrategyResult>` | Create strategy |
| `createStrategyAccount` | `address` | `Promise<TransactionInstruction>` | Create account |
| `initializeStrategy` | `address, admin, params` | `Promise<TransactionInstruction[]>` | Initialize |
| `closeStrategy` | `strategy` | `Promise<CloseStrategyResult>` | Close strategy |
| `updateStrategyConfig` | `strategy, config` | `Promise<UpdateConfigResult>` | Update config |

## Fee & Reward Operations

### Collect Fees

```typescript
// Collect fees and rewards
const collectIxs = await kamino.collectFeesAndRewards(strategy);

// Update reward mapping
const updateRewardIxs = await kamino.updateRewardMapping(strategy, mappings);
```

## DEX & Pool Operations

### Get Pool Information

```typescript
// Get fee tiers for DEX
const feeTiers = kamino.getFeeTiersForDex("ORCA");

// Get price for pair
const price = await kamino.getPriceForPair("ORCA", tokenAMint, tokenBMint);

// Check if pool is initialized
const poolAddress = await kamino.getPoolInitializedForDexPairTier(
  "ORCA",
  tokenAMint,
  tokenBMint,
  new Decimal(30)  // 0.3% fee tier
);

// Get existing pools for pair
const pools = await kamino.getExistentPoolsForPair("ORCA", tokenAMint, tokenBMint);
```

### DEX-Specific Pool Methods

```typescript
// Orca Whirlpool pools
const orcaPools = await kamino.getOrcaPoolsForTokens(tokenA, tokenB);

// Raydium CLMM pools
const raydiumPools = await kamino.getRaydiumPoolsForTokens(tokenA, tokenB);

// Meteora DLMM pools
const meteoraPools = await kamino.getMeteoraPoolsForTokens(tokenA, tokenB);
```

### GenericPoolInfo Interface

```typescript
interface GenericPoolInfo {
  address: Address;
  dex: Dex;
  tokenAMint: Address;
  tokenBMint: Address;
  feeBps: Decimal;
  tickSpacing: number;
  currentPrice: Decimal;
  tvl: Decimal;
}
```

## Pricing Methods

### Get All Prices

```typescript
// Get oracle prices for addresses
const oraclePrices = await kamino.getAllOraclePrices(priceAddresses);

// Get all Kamino prices
const allPrices = await kamino.getAllPrices(oraclePrices, options);
```

### Methods Reference

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getAllOraclePrices` | `prices: Address[]` | `Promise<[Address, OraclePrices][]>` | Oracle prices |
| `getAllPrices` | `oraclePrices?, options?` | `Promise<KaminoPrices>` | All token prices |

## Account & Balance Methods

### Token Balances

```typescript
// Get token account balance
const balance = await kamino.getTokenAccountBalance(tokenAccount);

// Get balance or zero if doesn't exist
const balanceOrZero = await kamino.getTokenAccountBalanceOrZero(tokenAccount);

// Get total tokens in strategies
const totals = await kamino.getTotalTokensInStrategies(tokenMint);
```

## Transaction Helpers

### Build Transactions

```typescript
// Create transaction with extra compute budget
const tx = kamino.createTransactionWithExtraBudget(computeUnits?);

// Assign block info to transaction
await kamino.assignBlockInfoToTransaction(tx);

// Get associated token address and data
const { address, exists } = await kamino.getAssociatedTokenAddressAndData(
  mint,
  owner
);

// Create ATA if needed
const createAtaIxs = await kamino.getCreateAssociatedTokenAccountInstructionsIfNotExist(
  mint,
  owner,
  payer
);
```

### Methods Reference

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `createTransactionWithExtraBudget` | `computeUnits?` | `Transaction` | Create transaction |
| `assignBlockInfoToTransaction` | `tx` | `Promise<void>` | Add blockhash |
| `getAssociatedTokenAddressAndData` | `mint, owner` | `Promise<{address, exists}>` | Get ATA info |
| `getCreateAssociatedTokenAccountInstructionsIfNotExist` | `mint, owner, payer` | `Promise<TransactionInstruction[]>` | Create ATA if needed |

## Price Reference Types

```typescript
// Get price reference types
const priceRefTypes = kamino.getPriceReferenceTypes();

// Get reference type for strategy
const refType = await kamino.getReferencePriceTypeForStrategy(strategy);
```

### PriceReferenceType Enum

```typescript
type PriceReferenceType =
  | "POOL"      // Pool spot price
  | "TWAP"      // Time-weighted average
  | "ORACLE";   // External oracle price
```

## Type Definitions

### StrategyWithAddress

```typescript
interface StrategyWithAddress {
  address: Address;
  strategy: WhirlpoolStrategy;
}
```

### WhirlpoolStrategy

```typescript
interface WhirlpoolStrategy {
  // Addresses
  adminAuthority: PublicKey;
  globalConfig: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  sharesMint: PublicKey;
  sharesMintAuthority: PublicKey;

  // Token info
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAMintDecimals: number;
  tokenBMintDecimals: number;

  // Position info
  positionTickLowerIndex: number;
  positionTickUpperIndex: number;

  // Status
  status: StrategyStatusKind;
  strategyType: StrategyTypeKind;

  // Rebalance
  rebalanceRaw: RebalanceRaw;

  // Timestamps
  creationTimestamp: BN;
  depositCap: BN;
  feesACumulative: BN;
  feesBCumulative: BN;
}
```

### Dex Type

```typescript
type Dex = "ORCA" | "RAYDIUM" | "METEORA";
```

### SolanaCluster Type

```typescript
type SolanaCluster = "mainnet-beta" | "devnet";
```

## Error Handling

```typescript
import { KaminoError } from "@kamino-finance/kliquidity-sdk";

try {
  await kamino.deposit(strategy, wallet, amountA, amountB, slippage);
} catch (error) {
  if (error instanceof KaminoError) {
    console.error("Kamino error:", error.code, error.message);
  } else {
    throw error;
  }
}
```

### Common Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | `InvalidStrategy` | Strategy not found or invalid |
| 6001 | `StrategyNotActive` | Strategy is not in LIVE status |
| 6002 | `InsufficientBalance` | Not enough tokens for operation |
| 6003 | `SlippageExceeded` | Price moved beyond slippage |
| 6004 | `PositionOutOfRange` | Position is out of price range |
| 6005 | `DepositCapExceeded` | Strategy deposit cap reached |
| 6010 | `InvalidPool` | Pool not found or not supported |
| 6011 | `InvalidDex` | DEX not supported |
| 6020 | `InvalidRebalance` | Rebalance parameters invalid |
| 6021 | `RebalanceNotNeeded` | No rebalance required |

## Constants

```typescript
import {
  KAMINO_LIQUIDITY_PROGRAM_ID,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  DEFAULT_SLIPPAGE,
  MAX_COMPUTE_UNITS,
  POSITION_SIZE,
  STRATEGY_SIZE
} from "@kamino-finance/kliquidity-sdk";
```
