# Raydium Swap Examples

Complete examples for executing swaps on Raydium pools.

## CPMM Swap

```typescript
import { Raydium, CurveCalculator } from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const owner = Keypair.fromSecretKey(bs58.decode('YOUR_SECRET_KEY'));

async function swapCpmm() {
  // Initialize SDK
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // Pool ID for SOL-USDC CPMM
  const poolId = '7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny';

  // Fetch pool info
  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  // Input: 0.1 SOL
  const inputAmount = new BN(100000000); // 0.1 SOL in lamports
  const inputMint = poolInfo.mintA.address; // SOL

  // Calculate expected output
  const { amountOut, fee } = CurveCalculator.swapBaseInput({
    poolInfo,
    amountIn: inputAmount,
    mintIn: inputMint,
    mintOut: poolInfo.mintB.address,
  });

  console.log('Expected output:', amountOut.toString());
  console.log('Fee:', fee.toString());

  // Execute swap
  const { execute } = await raydium.cpmm.swap({
    poolInfo,
    inputAmount,
    inputMint,
    slippage: 0.01, // 1% slippage
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 400000,
      microLamports: 50000,
    },
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Swap TX:', `https://solscan.io/tx/${txId}`);
}

swapCpmm();
```

## CLMM Swap

```typescript
import { Raydium, TickUtils } from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair } from '@solana/web3.js';
import BN from 'bn.js';

async function swapClmm() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // RAY-USDC CLMM pool
  const poolId = 'DiwsGxJYoRZURvyCtMsJVyxR86yZBBbSYeeWNm7YCmT6';

  // Fetch pool info from API (mainnet) or RPC
  let poolInfo;
  if (raydium.cluster === 'mainnet') {
    const data = await raydium.api.fetchPoolById({ ids: poolId });
    poolInfo = data[0];
  } else {
    poolInfo = await raydium.clmm.getPoolInfoFromRpc(poolId);
  }

  // Fetch tick arrays for price calculation
  const tickArrays = await raydium.clmm.getPoolTickArrays({
    poolInfo,
  });

  // Calculate output
  const inputAmount = new BN(1000000); // 1 USDC (6 decimals)
  const inputMint = poolInfo.mintB.address; // USDC

  const { amountOut, remainingAccounts } = await raydium.clmm.computeAmountOut({
    poolInfo,
    tickArrays,
    amountIn: inputAmount,
    mintIn: inputMint,
    slippage: 0.01,
  });

  console.log('Expected RAY:', amountOut.toString());

  // Execute swap
  const { execute } = await raydium.clmm.swap({
    poolInfo,
    inputMint,
    amountIn: inputAmount,
    amountOutMin: amountOut,
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 600000,
      microLamports: 100000,
    },
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Swap TX:', `https://solscan.io/tx/${txId}`);
}
```

## AMM V4 Swap

```typescript
async function swapAmm() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // SOL-USDC AMM pool
  const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

  const { poolInfo } = await raydium.liquidity.getPoolInfoFromRpc({
    poolId,
  });

  const inputAmount = new BN(100000000); // 0.1 SOL
  const inputMint = poolInfo.mintA.address;

  // Calculate output
  const { amountOut } = raydium.liquidity.computeAmountOut({
    poolInfo,
    amountIn: inputAmount,
    mintIn: inputMint,
    slippage: 0.01,
  });

  // Execute swap
  const { execute } = await raydium.liquidity.swap({
    poolInfo,
    amountIn: inputAmount,
    amountOut,
    inputMint,
    fixedSide: 'in',
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Swap TX:', `https://solscan.io/tx/${txId}`);
}
```

## Swap with Exact Output (Base Out)

```typescript
async function swapBaseOut() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolId = '7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny';
  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  // Want exactly 10 USDC out
  const outputAmount = new BN(10000000); // 10 USDC
  const outputMint = poolInfo.mintB.address;

  // Calculate required input
  const { amountIn, fee } = CurveCalculator.swapBaseOutput({
    poolInfo,
    amountOut: outputAmount,
    mintIn: poolInfo.mintA.address,
    mintOut: outputMint,
  });

  console.log('Required SOL input:', amountIn.toString());

  // Execute swap
  const { execute } = await raydium.cpmm.swap({
    poolInfo,
    inputAmount: amountIn,
    inputMint: poolInfo.mintA.address,
    slippage: 0.01,
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Swap TX:', `https://solscan.io/tx/${txId}`);
}
```

## Multi-Hop Swap (Route)

```typescript
async function routeSwap() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const inputMint = 'So11111111111111111111111111111111111111112'; // SOL
  const outputMint = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'; // RAY
  const amount = new BN(100000000); // 0.1 SOL

  // Compute best route
  const routes = await raydium.tradeV2.computeRoutes({
    inputMint,
    outputMint,
    amount,
    slippage: 0.01,
    txVersion: 'V0',
  });

  if (routes.length === 0) {
    console.log('No route found');
    return;
  }

  const bestRoute = routes[0];
  console.log('Route:', bestRoute.routeType);
  console.log('Expected output:', bestRoute.amountOut.toString());

  // Execute route
  const { execute } = await raydium.tradeV2.swap({
    routeInfo: bestRoute,
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 600000,
      microLamports: 100000,
    },
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Route Swap TX:', `https://solscan.io/tx/${txId}`);
}
```

## Error Handling

```typescript
async function safeSwap() {
  try {
    const { execute } = await raydium.cpmm.swap({
      poolInfo,
      inputAmount,
      inputMint,
      slippage: 0.01,
    });

    const { txId } = await execute({
      sendAndConfirm: true,
      skipPreflight: false,
    });

    console.log('Success:', txId);
  } catch (error: any) {
    if (error.message.includes('insufficient')) {
      console.error('Insufficient balance');
    } else if (error.message.includes('slippage')) {
      console.error('Slippage exceeded - try higher slippage');
    } else {
      console.error('Swap failed:', error.message);
    }
  }
}
```

## Tips

1. **Slippage**: Use 0.5-1% for stable pairs, 1-3% for volatile pairs
2. **Priority Fees**: Increase `microLamports` during congestion
3. **Compute Units**: CLMM swaps need more (~600k), CPMM needs less (~400k)
4. **Pool Selection**: CLMM has better prices for large swaps
