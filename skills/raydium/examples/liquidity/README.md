# AMM V4 Liquidity Management

Manage liquidity in classic AMM pools with OpenBook integration.

## Prerequisites

- Existing AMM V4 pool (requires OpenBook market)
- Both tokens for the pair
- SOL for transaction fees

## Fetch Pool Information

```typescript
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const owner = Keypair.fromSecretKey(bs58.decode('YOUR_SECRET_KEY'));

async function getAmmPoolInfo(poolId: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // Fetch from RPC
  const { poolInfo, poolKeys } = await raydium.liquidity.getPoolInfoFromRpc({
    poolId,
  });

  console.log('Pool:', poolId);
  console.log('Base Token:', poolInfo.mintA.symbol);
  console.log('Quote Token:', poolInfo.mintB.symbol);
  console.log('Base Reserve:', poolInfo.baseReserve.toString());
  console.log('Quote Reserve:', poolInfo.quoteReserve.toString());
  console.log('LP Supply:', poolInfo.lpSupply.toString());
  console.log('OpenBook Market:', poolKeys.marketId.toBase58());

  return { poolInfo, poolKeys };
}
```

## Add Liquidity

```typescript
async function addLiquidity(poolId: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const { poolInfo, poolKeys } = await raydium.liquidity.getPoolInfoFromRpc({
    poolId,
  });

  // Amounts to add
  const amountInA = new BN(100000000); // 0.1 base token
  const amountInB = new BN(0); // Will be calculated

  // Calculate required amount B
  const { maxAmountIn, anotherAmount, liquidity } =
    raydium.liquidity.computePairAmount({
      poolInfo,
      amount: amountInA,
      anotherToken: poolInfo.mintB,
      slippage: 0.01,
    });

  console.log('Amount A:', amountInA.toString());
  console.log('Amount B required:', anotherAmount.toString());
  console.log('LP to receive:', liquidity.toString());

  const { execute } = await raydium.liquidity.addLiquidity({
    poolInfo,
    poolKeys,
    amountInA,
    amountInB: anotherAmount,
    fixedSide: 'a', // Fix amount A, calculate B
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 400000,
      microLamports: 50000,
    },
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Liquidity added:', `https://solscan.io/tx/${txId}`);
}
```

## Remove Liquidity

```typescript
async function removeLiquidity(poolId: string, percentage: number) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const { poolInfo, poolKeys } = await raydium.liquidity.getPoolInfoFromRpc({
    poolId,
  });

  // Get LP token balance
  const lpTokenAccount = await raydium.account.getTokenAccount(poolInfo.lpMint);
  const lpBalance = new BN(lpTokenAccount.amount.toString());

  if (lpBalance.isZero()) {
    console.log('No LP tokens to remove');
    return;
  }

  // Calculate amount to remove
  const lpAmount = lpBalance.mul(new BN(percentage)).div(new BN(100));

  // Calculate tokens to receive
  const { amountA, amountB } = raydium.liquidity.computeAmountOut({
    poolInfo,
    lpAmount,
    slippage: 0.01,
  });

  console.log('LP to burn:', lpAmount.toString());
  console.log('Token A to receive:', amountA.toString());
  console.log('Token B to receive:', amountB.toString());

  const { execute } = await raydium.liquidity.removeLiquidity({
    poolInfo,
    poolKeys,
    lpAmount,
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 400000,
      microLamports: 50000,
    },
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Liquidity removed:', `https://solscan.io/tx/${txId}`);
}
```

## Create AMM Pool (with OpenBook Market)

Creating an AMM V4 pool requires first creating an OpenBook market.

```typescript
async function createAmmPool() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // First create OpenBook market
  const baseMint = new PublicKey('BASE_TOKEN_MINT');
  const quoteMint = new PublicKey('QUOTE_TOKEN_MINT'); // Usually USDC/SOL

  // Get token info
  const [baseToken, quoteToken] = await raydium.api.getTokenInfo([
    baseMint.toBase58(),
    quoteMint.toBase58(),
  ]);

  // Create market first
  console.log('Creating OpenBook market...');
  const { execute: createMarket, extInfo: marketInfo } =
    await raydium.marketV2.create({
      baseMint,
      quoteMint,
      lotSize: 1, // Min trade size
      tickSize: 0.0001, // Price increment
      txVersion: 'V0',
    });

  const { txId: marketTxId } = await createMarket({ sendAndConfirm: true });
  console.log('Market created:', marketInfo.marketId.toBase58());
  console.log('Market TX:', marketTxId);

  // Wait for market to be ready
  await new Promise((r) => setTimeout(r, 5000));

  // Now create AMM pool
  console.log('Creating AMM pool...');
  const { execute: createPool, extInfo: poolInfo } =
    await raydium.liquidity.createPoolV4({
      marketInfo: {
        marketId: marketInfo.marketId,
        programId: marketInfo.programId,
      },
      baseMintInfo: baseToken,
      quoteMintInfo: quoteToken,
      baseAmount: new BN(1000000000), // Initial base liquidity
      quoteAmount: new BN(1000000), // Initial quote liquidity
      startTime: new BN(0), // Start immediately
      txVersion: 'V0',
    });

  const { txId: poolTxId } = await createPool({ sendAndConfirm: true });
  console.log('Pool created:', poolInfo.poolId.toBase58());
  console.log('Pool TX:', poolTxId);

  return {
    marketId: marketInfo.marketId,
    poolId: poolInfo.poolId,
  };
}
```

## Swap in AMM Pool

```typescript
async function swapInAmm(poolId: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const { poolInfo, poolKeys } = await raydium.liquidity.getPoolInfoFromRpc({
    poolId,
  });

  const amountIn = new BN(100000000); // 0.1 SOL
  const inputMint = poolInfo.mintA.address; // SOL

  // Calculate output
  const { amountOut, minAmountOut, priceImpact } =
    raydium.liquidity.computeAmountOut({
      poolInfo,
      amountIn,
      mintIn: inputMint,
      slippage: 0.01,
    });

  console.log('Input:', amountIn.toString());
  console.log('Expected output:', amountOut.toString());
  console.log('Min output (with slippage):', minAmountOut.toString());
  console.log('Price impact:', priceImpact, '%');

  const { execute } = await raydium.liquidity.swap({
    poolInfo,
    poolKeys,
    amountIn,
    amountOut: minAmountOut,
    inputMint,
    fixedSide: 'in',
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Swap executed:', `https://solscan.io/tx/${txId}`);
}
```

## Popular AMM V4 Pools

| Pool | ID | Pair |
|------|-----|------|
| SOL-USDC | `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2` | SOL/USDC |
| RAY-USDC | `6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg` | RAY/USDC |
| RAY-SOL | `AVs9TA4nWDzfPJE9procDQoFjpcBUqZB7VBpRzaLMaat` | RAY/SOL |

## Costs

| Operation | Approximate Cost |
|-----------|-----------------|
| Create Market | ~3 SOL (rent) |
| Create Pool | ~0.5 SOL (rent) |
| Add Liquidity | ~0.01 SOL (fees) |
| Remove Liquidity | ~0.01 SOL (fees) |
| Swap | ~0.005 SOL (fees) |

## Important Notes

1. **OpenBook Required**: AMM V4 pools need an OpenBook market
2. **Higher Creation Cost**: More expensive than CPMM due to market rent
3. **Orderbook Integration**: Liquidity shared with OpenBook
4. **Legacy**: Consider CPMM for new pools unless orderbook needed
