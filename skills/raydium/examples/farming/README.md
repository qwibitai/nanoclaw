# Raydium Farming Examples

Examples for farming, staking, and reward harvesting on Raydium.

## Overview

Raydium offers multiple farm types:
- **CLMM Farms** - Rewards for concentrated liquidity positions
- **CPMM Farms** - Rewards for CPMM LP tokens
- **Ecosystem Farms** - RAY staking and ecosystem rewards

## Prerequisites

```typescript
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// Initialize SDK
const connection = new Connection(process.env.RPC_URL!);
const owner = Keypair.fromSecretKey(/* your key */);

const raydium = await Raydium.load({
  connection,
  owner,
  cluster: "mainnet",
});
```

---

## CLMM Farm Operations

### Fetch CLMM Farms

```typescript
async function fetchClmmFarms() {
  // Get all CLMM farms
  const farms = await raydium.api.getFarmList();
  const clmmFarms = farms.filter((f) => f.programId === "CLMM_PROGRAM_ID");

  console.log(`Found ${clmmFarms.length} CLMM farms`);

  for (const farm of clmmFarms.slice(0, 5)) {
    console.log(`Farm: ${farm.id}`);
    console.log(`  Pool: ${farm.lpMint}`);
    console.log(`  Rewards: ${farm.rewardInfos.map((r) => r.mint).join(", ")}`);
    console.log(`  APR: ${farm.apr}%`);
  }

  return clmmFarms;
}
```

### Create CLMM Farm

```typescript
async function createClmmFarm(
  poolId: string,
  rewardInfos: Array<{
    mint: string;
    perSecond: BN;
    openTime: number;
    endTime: number;
  }>
) {
  // Fetch pool info
  const poolInfo = await raydium.clmm.getPoolInfoFromRpc(poolId);

  // Create farm
  const { execute, extInfo } = await raydium.clmm.createFarm({
    poolInfo,
    rewardInfos: rewardInfos.map((r) => ({
      mint: new PublicKey(r.mint),
      perSecond: r.perSecond,
      openTime: new BN(r.openTime),
      endTime: new BN(r.endTime),
    })),
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });

  console.log("Farm created!");
  console.log(`Transaction: ${txId}`);
  console.log(`Farm ID: ${extInfo.farmId.toBase58()}`);

  return extInfo;
}

// Usage
const oneWeek = 7 * 24 * 60 * 60;
const now = Math.floor(Date.now() / 1000);

await createClmmFarm("POOL_ID", [
  {
    mint: "RAY_MINT_ADDRESS",
    perSecond: new BN(1000000), // Reward rate per second
    openTime: now,
    endTime: now + oneWeek,
  },
]);
```

### Harvest CLMM Rewards

```typescript
async function harvestClmmRewards(poolId: string) {
  // Get pool and position info
  const poolInfo = await raydium.clmm.getPoolInfoFromRpc(poolId);

  // Get user positions
  const positions = await raydium.clmm.getOwnerPositionInfo({
    programId: poolInfo.programId,
  });

  const poolPositions = positions.filter(
    (p) => p.poolId.toBase58() === poolId
  );

  if (poolPositions.length === 0) {
    console.log("No positions found for this pool");
    return;
  }

  console.log(`Found ${poolPositions.length} positions`);

  // Harvest from all positions
  const { execute } = await raydium.clmm.harvestAllRewards({
    allPoolInfo: { [poolId]: poolInfo },
    allPositions: { [poolId]: poolPositions },
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });

  console.log(`Rewards harvested: ${txId}`);
}
```

### Harvest All CLMM Rewards (All Pools)

```typescript
async function harvestAllClmmRewards() {
  // Get all user positions across all pools
  const allPositions = await raydium.clmm.getOwnerPositionInfo({
    programId: new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
  });

  if (allPositions.length === 0) {
    console.log("No CLMM positions found");
    return;
  }

  // Group positions by pool
  const positionsByPool: Record<string, typeof allPositions> = {};
  const poolIds = new Set<string>();

  for (const position of allPositions) {
    const poolId = position.poolId.toBase58();
    poolIds.add(poolId);
    if (!positionsByPool[poolId]) {
      positionsByPool[poolId] = [];
    }
    positionsByPool[poolId].push(position);
  }

  // Fetch pool info for all pools
  const poolInfos: Record<string, any> = {};
  for (const poolId of poolIds) {
    poolInfos[poolId] = await raydium.clmm.getPoolInfoFromRpc(poolId);
  }

  // Harvest all rewards
  const { execute, transactions } = await raydium.clmm.harvestAllRewards({
    allPoolInfo: poolInfos,
    allPositions: positionsByPool,
    txVersion: "V0",
  });

  console.log(`Harvesting from ${poolIds.size} pools...`);

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`All rewards harvested: ${txId}`);
}
```

---

## CPMM Farm Operations

### Stake LP Tokens

```typescript
async function stakeCpmmLp(poolId: string, lpAmount: BN) {
  // Get pool info
  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  // Get farm info for this pool
  const farms = await raydium.api.getFarmInfo({
    ids: [poolInfo.farmIds[0]], // First associated farm
  });
  const farmInfo = farms[0];

  // Stake LP tokens
  const { execute } = await raydium.farm.deposit({
    farmInfo,
    amount: lpAmount,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`Staked ${lpAmount.toString()} LP tokens: ${txId}`);
}
```

### Unstake LP Tokens

```typescript
async function unstakeCpmmLp(farmId: string, lpAmount: BN) {
  // Get farm info
  const farms = await raydium.api.getFarmInfo({ ids: [farmId] });
  const farmInfo = farms[0];

  // Withdraw LP tokens
  const { execute } = await raydium.farm.withdraw({
    farmInfo,
    amount: lpAmount,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`Unstaked ${lpAmount.toString()} LP tokens: ${txId}`);
}
```

### Harvest CPMM Farm Rewards

```typescript
async function harvestCpmmFarmRewards(farmId: string) {
  // Get farm info
  const farms = await raydium.api.getFarmInfo({ ids: [farmId] });
  const farmInfo = farms[0];

  // Harvest rewards (withdraw with 0 amount)
  const { execute } = await raydium.farm.withdraw({
    farmInfo,
    amount: new BN(0), // 0 = harvest only
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`Rewards harvested: ${txId}`);
}
```

---

## Lock Liquidity for Rewards (CPMM)

### Lock LP Tokens

```typescript
async function lockLiquidity(poolId: string, lpAmount: BN) {
  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  const { execute, extInfo } = await raydium.cpmm.lockLiquidity({
    poolInfo,
    lpAmount,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });

  console.log("Liquidity locked!");
  console.log(`Transaction: ${txId}`);
  console.log(`Lock ID: ${extInfo.lockId}`);

  return extInfo;
}
```

### Harvest Locked Rewards

```typescript
async function harvestLockedRewards(poolId: string) {
  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  // Get user's lock info
  const lockInfo = await raydium.cpmm.getLockInfo({
    poolInfo,
    owner: raydium.owner.publicKey,
  });

  if (!lockInfo) {
    console.log("No locked liquidity found");
    return;
  }

  // Harvest rewards from locked position
  const { execute } = await raydium.cpmm.harvestLockLiquidity({
    poolInfo,
    lockInfo,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`Locked rewards harvested: ${txId}`);
}
```

---

## RAY Staking

### Stake RAY

```typescript
async function stakeRay(amount: BN) {
  const RAY_STAKING_POOL = "YOUR_RAY_STAKING_POOL_ID";

  const farms = await raydium.api.getFarmInfo({ ids: [RAY_STAKING_POOL] });
  const farmInfo = farms[0];

  const { execute } = await raydium.farm.deposit({
    farmInfo,
    amount,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`Staked ${amount.toString()} RAY: ${txId}`);
}
```

### Unstake RAY

```typescript
async function unstakeRay(amount: BN) {
  const RAY_STAKING_POOL = "YOUR_RAY_STAKING_POOL_ID";

  const farms = await raydium.api.getFarmInfo({ ids: [RAY_STAKING_POOL] });
  const farmInfo = farms[0];

  const { execute } = await raydium.farm.withdraw({
    farmInfo,
    amount,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`Unstaked ${amount.toString()} RAY: ${txId}`);
}
```

---

## Farm Information Queries

### Get User Farm Positions

```typescript
async function getUserFarmPositions() {
  // Get all farms
  const allFarms = await raydium.api.getFarmList();

  // Check user positions in each farm
  const userPositions = [];

  for (const farm of allFarms) {
    const userInfo = await raydium.farm.getUserFarmInfo({
      farmInfo: farm,
      owner: raydium.owner.publicKey,
    });

    if (userInfo && userInfo.depositedAmount.gt(new BN(0))) {
      userPositions.push({
        farmId: farm.id,
        lpMint: farm.lpMint,
        deposited: userInfo.depositedAmount.toString(),
        pendingRewards: userInfo.pendingRewards,
      });
    }
  }

  console.log(`Found ${userPositions.length} farm positions`);
  return userPositions;
}
```

### Calculate Farm APR

```typescript
async function calculateFarmApr(farmId: string) {
  const farms = await raydium.api.getFarmInfo({ ids: [farmId] });
  const farm = farms[0];

  // APR is typically pre-calculated by the API
  console.log(`Farm: ${farmId}`);
  console.log(`  Total APR: ${farm.apr}%`);

  for (const reward of farm.rewardInfos) {
    console.log(`  ${reward.mint}: ${reward.apr}% APR`);
  }

  return farm.apr;
}
```

---

## Complete Farming Workflow

```typescript
async function completeFarmingWorkflow() {
  const POOL_ID = "YOUR_CPMM_POOL_ID";

  // 1. Add liquidity to get LP tokens
  console.log("1. Adding liquidity...");
  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(POOL_ID);

  const { execute: addLiq, extInfo } = await raydium.cpmm.addLiquidity({
    poolInfo,
    inputAmount: new BN(1_000_000_000), // 1 SOL worth
    baseIn: true,
    slippage: 0.01,
    txVersion: "V0",
  });

  await addLiq({ sendAndConfirm: true });
  console.log(`   LP tokens received: ${extInfo.lpAmount.toString()}`);

  // 2. Stake LP tokens in farm
  console.log("2. Staking LP tokens...");
  if (poolInfo.farmIds && poolInfo.farmIds.length > 0) {
    const farms = await raydium.api.getFarmInfo({
      ids: [poolInfo.farmIds[0]],
    });

    const { execute: stake } = await raydium.farm.deposit({
      farmInfo: farms[0],
      amount: extInfo.lpAmount,
      txVersion: "V0",
    });

    await stake({ sendAndConfirm: true });
    console.log("   LP tokens staked!");
  }

  // 3. Wait and harvest rewards
  console.log("3. Waiting for rewards to accumulate...");
  await new Promise((r) => setTimeout(r, 60000)); // Wait 1 minute

  console.log("4. Harvesting rewards...");
  if (poolInfo.farmIds && poolInfo.farmIds.length > 0) {
    const farms = await raydium.api.getFarmInfo({
      ids: [poolInfo.farmIds[0]],
    });

    const { execute: harvest } = await raydium.farm.withdraw({
      farmInfo: farms[0],
      amount: new BN(0), // 0 = harvest only
      txVersion: "V0",
    });

    await harvest({ sendAndConfirm: true });
    console.log("   Rewards harvested!");
  }

  console.log("Farming workflow complete!");
}
```

---

## Tips

1. **Check Farm Status** - Ensure farms are active before depositing
2. **Monitor APR** - Farm rewards can change; monitor for best yields
3. **Gas Optimization** - Batch harvests when possible
4. **Impermanent Loss** - Remember LP positions are subject to IL
5. **Lock Duration** - Locked liquidity may have time restrictions

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Farm not found` | Invalid farm ID | Verify farm ID exists |
| `Insufficient LP balance` | Not enough LP tokens | Check LP token balance |
| `Farm ended` | Farm rewards period over | Check farm end time |
| `Already harvested` | No pending rewards | Wait for rewards to accumulate |
