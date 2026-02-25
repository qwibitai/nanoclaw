# CLMM Pool Creation

Create concentrated liquidity pools on Raydium.

## Prerequisites

- SOL for transaction fees
- Both tokens to provide initial liquidity
- Fee config from API

## Create CLMM Pool

```typescript
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import BN from 'bn.js';
import bs58 from 'bs58';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const owner = Keypair.fromSecretKey(bs58.decode('YOUR_SECRET_KEY'));

async function createClmmPool() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // Token addresses
  const mint1 = new PublicKey('TOKEN_A_MINT');
  const mint2 = new PublicKey('TOKEN_B_MINT');

  // Get token info
  const [token1Info, token2Info] = await raydium.api.getTokenInfo([
    mint1.toBase58(),
    mint2.toBase58(),
  ]);

  // Get CLMM configs (fee tiers)
  const clmmConfigs = await raydium.api.getClmmConfigs();

  // Select fee tier (e.g., 0.25% for most pairs)
  const selectedConfig = clmmConfigs.find(
    (config) => config.tradeFeeRate === 2500 // 0.25%
  );

  if (!selectedConfig) {
    throw new Error('Fee config not found');
  }

  // Set initial price (token2 per token1)
  const initialPrice = new Decimal(1.5); // 1 token1 = 1.5 token2

  console.log('Creating CLMM pool...');
  console.log('Token A:', token1Info.symbol);
  console.log('Token B:', token2Info.symbol);
  console.log('Fee tier:', selectedConfig.tradeFeeRate / 10000, '%');
  console.log('Initial price:', initialPrice.toString());

  // Create pool
  const { execute, extInfo } = await raydium.clmm.createPool({
    mint1: token1Info,
    mint2: token2Info,
    ammConfig: {
      id: selectedConfig.id,
      fundOwner: selectedConfig.fundOwner,
      ...selectedConfig,
    },
    initialPrice,
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 600000,
      microLamports: 100000,
    },
  });

  console.log('Pool ID:', extInfo.address.toBase58());

  // Execute transaction
  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Pool created:', `https://solscan.io/tx/${txId}`);

  return extInfo.address;
}

createClmmPool();
```

## Fee Tier Selection

| Fee Tier | Trade Fee | Best For |
|----------|-----------|----------|
| 0.01% | 100 | Stablecoins (USDC-USDT) |
| 0.05% | 500 | Correlated pairs |
| 0.25% | 2500 | Most pairs |
| 1% | 10000 | Exotic/volatile pairs |

```typescript
// Get available fee tiers
const configs = await raydium.api.getClmmConfigs();

configs.forEach((config) => {
  console.log(`${config.tradeFeeRate / 10000}%:`, config.id);
});
```

## Initial Price Calculation

```typescript
// Price = token2 per token1
// Example: If token1 is worth $10 and token2 is worth $1
// Price = 10 (you get 10 token2 for 1 token1)

const token1PriceUsd = 10;
const token2PriceUsd = 1;
const initialPrice = new Decimal(token1PriceUsd / token2PriceUsd);
```

## Add Initial Liquidity After Pool Creation

```typescript
async function addInitialLiquidity(poolId: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // Fetch newly created pool
  const poolInfo = await raydium.clmm.getPoolInfoFromRpc(poolId);

  // Define price range (e.g., ±50% from current price)
  const currentPrice = poolInfo.price;
  const lowerPrice = currentPrice * 0.5;
  const upperPrice = currentPrice * 1.5;

  // Get ticks for price range
  const { tick: tickLower } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(lowerPrice),
    baseIn: true,
  });

  const { tick: tickUpper } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(upperPrice),
    baseIn: true,
  });

  // Calculate liquidity amounts
  const baseAmount = new BN(1000000000); // 1 token with 9 decimals

  const { liquidity, amountA, amountB } =
    PoolUtils.getLiquidityAmountOutFromAmountIn({
      poolInfo,
      tickLower,
      tickUpper,
      amount: baseAmount,
      slippage: 0.01,
      add: true,
      amountHasFee: true,
      token: poolInfo.mintA,
    });

  console.log('Liquidity:', liquidity.toString());
  console.log('Amount A:', amountA.toString());
  console.log('Amount B:', amountB.toString());

  // Open position
  const { execute } = await raydium.clmm.openPositionFromBase({
    poolInfo,
    tickLower,
    tickUpper,
    base: 'MintA',
    baseAmount,
    otherAmountMax: amountB.mul(new BN(101)).div(new BN(100)), // +1% buffer
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Position opened:', `https://solscan.io/tx/${txId}`);
}
```

## Devnet Testing

```typescript
async function createDevnetPool() {
  const connection = new Connection('https://api.devnet.solana.com');

  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'devnet',
  });

  // Use devnet tokens
  const mint1 = new PublicKey('DEVNET_TOKEN_A');
  const mint2 = new PublicKey('DEVNET_TOKEN_B');

  // Note: On devnet, fetch configs from RPC instead of API
  // Or use known devnet config IDs

  const { execute, extInfo } = await raydium.clmm.createPool({
    mint1: { address: mint1.toBase58(), decimals: 9, symbol: 'TESTA' },
    mint2: { address: mint2.toBase58(), decimals: 6, symbol: 'TESTB' },
    ammConfig: {
      id: 'DEVNET_CONFIG_ID',
      tradeFeeRate: 2500,
      protocolFeeRate: 12000,
      fundFeeRate: 0,
      fundOwner: '',
    },
    initialPrice: new Decimal(1),
    txVersion: 'V0',
  });

  console.log('Devnet Pool:', extInfo.address.toBase58());
}
```

## Important Notes

1. **Pool Creation Cost**: ~0.5-1 SOL for rent and fees
2. **Token Order**: SDK automatically orders tokens (lower address first)
3. **Price Direction**: Always token2/token1
4. **Tick Spacing**: Determined by fee tier, affects range precision
