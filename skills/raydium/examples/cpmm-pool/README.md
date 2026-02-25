# CPMM Pool Operations

Create and manage constant product pools on Raydium.

## Create CPMM Pool

```typescript
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const owner = Keypair.fromSecretKey(bs58.decode('YOUR_SECRET_KEY'));

async function createCpmmPool() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // Token mints
  const mintA = new PublicKey('TOKEN_A_MINT');
  const mintB = new PublicKey('TOKEN_B_MINT');

  // Get token info
  const [tokenA, tokenB] = await raydium.api.getTokenInfo([
    mintA.toBase58(),
    mintB.toBase58(),
  ]);

  // Get fee configs
  const feeConfigs = await raydium.api.getCpmmConfigs();

  // Select fee tier (0.25% is standard)
  const feeConfig = feeConfigs.find((c) => c.tradeFeeRate === 2500);

  if (!feeConfig) {
    throw new Error('Fee config not found');
  }

  console.log('Creating CPMM pool...');
  console.log('Token A:', tokenA.symbol, tokenA.address);
  console.log('Token B:', tokenB.symbol, tokenB.address);
  console.log('Fee:', feeConfig.tradeFeeRate / 10000, '%');

  // Initial liquidity amounts
  const mintAAmount = new BN(1000000000); // 1 token (9 decimals)
  const mintBAmount = new BN(1000000); // 1 token (6 decimals)

  const { execute, extInfo } = await raydium.cpmm.createPool({
    mintA: tokenA,
    mintB: tokenB,
    mintAAmount,
    mintBAmount,
    startTime: new BN(0), // Start immediately
    feeConfig,
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 600000,
      microLamports: 100000,
    },
  });

  console.log('Pool ID:', extInfo.address.toBase58());
  console.log('LP Mint:', extInfo.lpMint.toBase58());

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Pool created:', `https://solscan.io/tx/${txId}`);

  return {
    poolId: extInfo.address,
    lpMint: extInfo.lpMint,
  };
}

createCpmmPool();
```

## Fetch Pool Info

```typescript
async function getPoolInfo(poolId: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // From API (mainnet)
  const apiPool = await raydium.api.fetchPoolById({ ids: poolId });

  // Or from RPC (any cluster)
  const rpcPool = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  console.log('Pool:', poolId);
  console.log('Token A:', rpcPool.mintA.symbol);
  console.log('Token B:', rpcPool.mintB.symbol);
  console.log('Reserve A:', rpcPool.vaultA.amount.toString());
  console.log('Reserve B:', rpcPool.vaultB.amount.toString());
  console.log('LP Supply:', rpcPool.lpAmount.toString());

  return rpcPool;
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

  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  // Amount to deposit (in token A)
  const inputAmount = new BN(100000000); // 0.1 token (9 decimals)

  const { execute, extInfo } = await raydium.cpmm.addLiquidity({
    poolInfo,
    inputAmount,
    baseIn: true, // inputAmount is for mintA
    slippage: 0.01, // 1%
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 400000,
      microLamports: 50000,
    },
  });

  console.log('LP tokens to receive:', extInfo.lpAmount.toString());

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Liquidity added:', `https://solscan.io/tx/${txId}`);
}
```

## Remove Liquidity

```typescript
async function removeLiquidity(poolId: string, lpAmount: BN) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  const { execute, extInfo } = await raydium.cpmm.withdrawLiquidity({
    poolInfo,
    lpAmount,
    slippage: 0.01, // 1%
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 400000,
      microLamports: 50000,
    },
  });

  console.log('Token A to receive:', extInfo.amountA.toString());
  console.log('Token B to receive:', extInfo.amountB.toString());

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Liquidity removed:', `https://solscan.io/tx/${txId}`);
}
```

## Lock Liquidity

Lock LP tokens to earn additional rewards and show commitment.

```typescript
async function lockLiquidity(poolId: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  // Get LP token balance
  const lpBalance = await raydium.account.getTokenAccount(poolInfo.lpMint);
  const lpAmount = new BN(lpBalance.amount.toString());

  if (lpAmount.isZero()) {
    console.log('No LP tokens to lock');
    return;
  }

  // Lock 50% of LP tokens
  const amountToLock = lpAmount.div(new BN(2));

  const { execute, extInfo } = await raydium.cpmm.lockLiquidity({
    poolInfo,
    lpAmount: amountToLock,
    txVersion: 'V0',
  });

  console.log('Lock info address:', extInfo.lockAddress.toBase58());

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Liquidity locked:', `https://solscan.io/tx/${txId}`);
}
```

## Harvest Locked Rewards

```typescript
async function harvestLockedRewards(poolId: string, lockInfoAddress: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  // Fetch lock info
  const lockInfo = await raydium.cpmm.getLockInfo(lockInfoAddress);

  const { execute } = await raydium.cpmm.harvestLockLiquidity({
    poolInfo,
    lockInfo,
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Rewards harvested:', `https://solscan.io/tx/${txId}`);
}
```

## Collect Creator Fees

If you created the pool, collect accumulated creator fees.

```typescript
async function collectCreatorFee(poolId: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  // Check if owner is creator
  if (poolInfo.creator.toBase58() !== owner.publicKey.toBase58()) {
    console.log('Not pool creator');
    return;
  }

  const { execute } = await raydium.cpmm.collectCreatorFee({
    poolInfo,
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Creator fees collected:', `https://solscan.io/tx/${txId}`);
}
```

## Collect All Creator Fees (Multiple Pools)

```typescript
async function collectAllCreatorFees(poolIds: string[]) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolInfos = await Promise.all(
    poolIds.map((id) => raydium.cpmm.getPoolInfoFromRpc(id))
  );

  // Filter pools where user is creator
  const creatorPools = poolInfos.filter(
    (p) => p.creator.toBase58() === owner.publicKey.toBase58()
  );

  if (creatorPools.length === 0) {
    console.log('No pools where you are creator');
    return;
  }

  const { execute } = await raydium.cpmm.collectAllCreatorFee({
    poolInfos: creatorPools,
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('All creator fees collected:', `https://solscan.io/tx/${txId}`);
}
```

## Token22 Pool Creation

CPMM supports Token22 tokens with extensions.

```typescript
async function createToken22Pool() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // Token22 mint (has transfer fee, etc.)
  const token22Mint = new PublicKey('TOKEN22_MINT');
  const regularMint = new PublicKey('USDC_MINT');

  // Get token info (SDK handles Token22 automatically)
  const [token22Info, usdcInfo] = await raydium.api.getTokenInfo([
    token22Mint.toBase58(),
    regularMint.toBase58(),
  ]);

  const feeConfigs = await raydium.api.getCpmmConfigs();
  const feeConfig = feeConfigs.find((c) => c.tradeFeeRate === 2500);

  const { execute, extInfo } = await raydium.cpmm.createPool({
    mintA: token22Info,
    mintB: usdcInfo,
    mintAAmount: new BN(1000000000),
    mintBAmount: new BN(1000000),
    startTime: new BN(0),
    feeConfig: feeConfig!,
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Token22 pool created:', `https://solscan.io/tx/${txId}`);
}
```

## Important Notes

1. **No OpenBook Required**: Unlike AMM V4, CPMM doesn't need an OpenBook market
2. **Token22 Support**: Full support for Token-2022 standard
3. **Creator Fees**: Pool creators can earn additional fees
4. **Locking**: Optional LP locking for rewards
5. **Pool Creation Cost**: ~0.5 SOL for rent
