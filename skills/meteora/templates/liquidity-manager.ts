/**
 * Meteora Liquidity Manager Template
 *
 * A production-ready template for managing liquidity across multiple
 * Meteora pools and strategies.
 *
 * Features:
 * - Multi-pool management
 * - Automated fee collection
 * - Portfolio tracking
 * - Risk monitoring
 *
 * Prerequisites:
 * npm install @meteora-ag/dlmm @meteora-ag/cp-amm-sdk @coral-xyz/anchor @solana/web3.js
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';

// =============================================================================
// CONFIGURATION
// =============================================================================

interface PoolConfig {
  address: PublicKey;
  type: 'dlmm' | 'damm';
  targetAllocation: number; // Percentage of portfolio
  strategy?: StrategyType;
  binRange?: number;
}

const CONFIG = {
  rpcEndpoint: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',

  // Pools to manage
  pools: [
    {
      address: new PublicKey('POOL_1_ADDRESS'),
      type: 'dlmm' as const,
      targetAllocation: 40,
      strategy: StrategyType.SpotBalanced,
      binRange: 10,
    },
    {
      address: new PublicKey('POOL_2_ADDRESS'),
      type: 'dlmm' as const,
      targetAllocation: 30,
      strategy: StrategyType.CurveBalanced,
      binRange: 15,
    },
    {
      address: new PublicKey('POOL_3_ADDRESS'),
      type: 'damm' as const,
      targetAllocation: 30,
    },
  ] as PoolConfig[],

  // Management settings
  rebalanceThresholdPercent: 5, // Rebalance if allocation drifts by 5%
  feeCollectionIntervalMs: 3600000, // Hourly
  pollIntervalMs: 60000, // Every minute
};

// =============================================================================
// TYPES
// =============================================================================

interface PoolState {
  config: PoolConfig;
  dlmm?: DLMM;
  cpAmm?: CpAmm;
  positions: PublicKey[];
  currentValue: BN;
  fees: {
    feeX: BN;
    feeY: BN;
  };
  rewards: BN;
}

interface PortfolioSnapshot {
  totalValue: BN;
  pools: {
    address: string;
    value: BN;
    allocation: number;
    targetAllocation: number;
    drift: number;
  }[];
  totalFees: BN;
  totalRewards: BN;
  timestamp: number;
}

// =============================================================================
// LIQUIDITY MANAGER CLASS
// =============================================================================

class LiquidityManager {
  private connection: Connection;
  private wallet: Keypair;
  private pools: Map<string, PoolState> = new Map();
  private lastFeeCollection: number = 0;
  private snapshots: PortfolioSnapshot[] = [];

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
  }

  async initialize(): Promise<void> {
    console.log('Initializing Liquidity Manager...');
    console.log('Pools to manage:', CONFIG.pools.length);

    for (const poolConfig of CONFIG.pools) {
      const state: PoolState = {
        config: poolConfig,
        positions: [],
        currentValue: new BN(0),
        fees: { feeX: new BN(0), feeY: new BN(0) },
        rewards: new BN(0),
      };

      if (poolConfig.type === 'dlmm') {
        state.dlmm = await DLMM.create(this.connection, poolConfig.address);

        // Get positions
        const positions = await state.dlmm.getPositionsByUserAndLbPair(
          this.wallet.publicKey
        );
        state.positions = positions.map((p) => p.publicKey);
        console.log(`DLMM Pool ${poolConfig.address.toString().slice(0, 8)}...: ${state.positions.length} positions`);
      } else if (poolConfig.type === 'damm') {
        state.cpAmm = new CpAmm(this.connection);

        // Get positions
        const positions = await state.cpAmm.getUserPositionByPool(
          this.wallet.publicKey,
          poolConfig.address
        );
        state.positions = positions.map((p) => p.owner);
        console.log(`DAMM Pool ${poolConfig.address.toString().slice(0, 8)}...: ${state.positions.length} positions`);
      }

      this.pools.set(poolConfig.address.toString(), state);
    }

    console.log('Initialization complete\n');
  }

  async updateValues(): Promise<void> {
    for (const [address, state] of this.pools) {
      if (state.config.type === 'dlmm' && state.dlmm) {
        await state.dlmm.refetchStates();

        // Calculate total value from positions
        let totalX = new BN(0);
        let totalY = new BN(0);

        for (const posKey of state.positions) {
          const positions = await state.dlmm.getPositionsByUserAndLbPair(
            this.wallet.publicKey
          );
          const pos = positions.find((p) => p.publicKey.equals(posKey));

          if (pos) {
            totalX = totalX.add(pos.positionData.totalXAmount);
            totalY = totalY.add(pos.positionData.totalYAmount);

            // Get fees
            const fees = await DLMM.getClaimableSwapFee(this.connection, posKey);
            state.fees.feeX = state.fees.feeX.add(fees.feeX);
            state.fees.feeY = state.fees.feeY.add(fees.feeY);

            // Get rewards
            const rewards = await DLMM.getClaimableLMReward(this.connection, posKey);
            state.rewards = state.rewards.add(rewards.rewardOne).add(rewards.rewardTwo);
          }
        }

        // Simple value calculation (would need oracle price for accurate USD value)
        state.currentValue = totalX.add(totalY);
      } else if (state.config.type === 'damm' && state.cpAmm) {
        let totalLiquidity = new BN(0);

        for (const posKey of state.positions) {
          const posState = await state.cpAmm.fetchPositionState(posKey);
          totalLiquidity = totalLiquidity.add(posState.liquidity);
          state.fees.feeX = posState.feeOwedA;
          state.fees.feeY = posState.feeOwedB;
        }

        state.currentValue = totalLiquidity;
      }
    }
  }

  async getPortfolioSnapshot(): Promise<PortfolioSnapshot> {
    await this.updateValues();

    let totalValue = new BN(0);
    let totalFees = new BN(0);
    let totalRewards = new BN(0);

    const poolStats: PortfolioSnapshot['pools'] = [];

    for (const [address, state] of this.pools) {
      totalValue = totalValue.add(state.currentValue);
      totalFees = totalFees.add(state.fees.feeX).add(state.fees.feeY);
      totalRewards = totalRewards.add(state.rewards);
    }

    for (const [address, state] of this.pools) {
      const allocation = totalValue.gt(new BN(0))
        ? state.currentValue.mul(new BN(100)).div(totalValue).toNumber()
        : 0;

      poolStats.push({
        address,
        value: state.currentValue,
        allocation,
        targetAllocation: state.config.targetAllocation,
        drift: allocation - state.config.targetAllocation,
      });
    }

    const snapshot: PortfolioSnapshot = {
      totalValue,
      pools: poolStats,
      totalFees,
      totalRewards,
      timestamp: Date.now(),
    };

    this.snapshots.push(snapshot);
    return snapshot;
  }

  async collectAllFees(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFeeCollection < CONFIG.feeCollectionIntervalMs) {
      return;
    }

    console.log('\n=== Collecting Fees ===');

    for (const [address, state] of this.pools) {
      if (state.config.type === 'dlmm' && state.dlmm && state.positions.length > 0) {
        if (state.fees.feeX.gt(new BN(0)) || state.fees.feeY.gt(new BN(0))) {
          try {
            const tx = await state.dlmm.claimAllSwapFee({
              owner: this.wallet.publicKey,
              positions: state.positions,
            });

            await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
              commitment: 'confirmed',
            });

            console.log(`Collected fees from DLMM ${address.slice(0, 8)}...`);
          } catch (error) {
            console.error(`Error collecting from ${address}:`, error);
          }
        }

        if (state.rewards.gt(new BN(0))) {
          try {
            const tx = await state.dlmm.claimAllLMRewards({
              owner: this.wallet.publicKey,
              positions: state.positions,
            });

            await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
              commitment: 'confirmed',
            });

            console.log(`Collected rewards from DLMM ${address.slice(0, 8)}...`);
          } catch (error) {
            console.error(`Error collecting rewards from ${address}:`, error);
          }
        }
      } else if (state.config.type === 'damm' && state.cpAmm) {
        for (const posKey of state.positions) {
          if (state.fees.feeX.gt(new BN(0)) || state.fees.feeY.gt(new BN(0))) {
            try {
              const tx = await state.cpAmm.claimPositionFee({
                owner: this.wallet.publicKey,
                pool: state.config.address,
                position: posKey,
              });

              const builtTx = await tx.build();
              await sendAndConfirmTransaction(this.connection, builtTx, [this.wallet]);

              console.log(`Collected fees from DAMM ${address.slice(0, 8)}...`);
            } catch (error) {
              console.error(`Error collecting from ${address}:`, error);
            }
          }
        }
      }
    }

    this.lastFeeCollection = now;
  }

  async checkRebalance(): Promise<void> {
    const snapshot = await this.getPortfolioSnapshot();

    const needsRebalance = snapshot.pools.some(
      (p) => Math.abs(p.drift) > CONFIG.rebalanceThresholdPercent
    );

    if (needsRebalance) {
      console.log('\n=== Rebalance Needed ===');

      for (const pool of snapshot.pools) {
        console.log(`${pool.address.slice(0, 8)}...: ${pool.allocation.toFixed(1)}% (target: ${pool.targetAllocation}%, drift: ${pool.drift > 0 ? '+' : ''}${pool.drift.toFixed(1)}%)`);
      }

      // In a full implementation, you would:
      // 1. Calculate amounts to move
      // 2. Remove liquidity from overweight pools
      // 3. Add liquidity to underweight pools
      console.log('\nManual rebalancing recommended.');
    }
  }

  displayStatus(): void {
    if (this.snapshots.length === 0) return;

    const latest = this.snapshots[this.snapshots.length - 1];

    console.clear();
    console.log('=== Liquidity Manager Status ===');
    console.log('Time:', new Date(latest.timestamp).toISOString());
    console.log('');
    console.log('Total Value:', latest.totalValue.toString());
    console.log('Pending Fees:', latest.totalFees.toString());
    console.log('Pending Rewards:', latest.totalRewards.toString());
    console.log('');
    console.log('Pool Allocations:');
    console.log('-'.repeat(60));

    for (const pool of latest.pools) {
      const status = Math.abs(pool.drift) > CONFIG.rebalanceThresholdPercent ? '⚠️' : '✓';
      console.log(
        `${status} ${pool.address.slice(0, 8)}...: ${pool.allocation.toFixed(1)}% (target: ${pool.targetAllocation}%)`
      );
    }

    console.log('-'.repeat(60));

    // Show historical performance if we have enough data
    if (this.snapshots.length > 1) {
      const first = this.snapshots[0];
      const growth = latest.totalValue.sub(first.totalValue);
      const growthPercent = first.totalValue.gt(new BN(0))
        ? growth.mul(new BN(10000)).div(first.totalValue).toNumber() / 100
        : 0;

      console.log('');
      console.log(`Growth since start: ${growthPercent > 0 ? '+' : ''}${growthPercent.toFixed(2)}%`);
    }
  }

  async run(): Promise<void> {
    await this.initialize();

    console.log('Starting management loop...\n');

    const loop = async () => {
      try {
        await this.checkRebalance();
        await this.collectAllFees();
        this.displayStatus();
      } catch (error) {
        console.error('Error in loop:', error);
      }
    };

    await loop();
    setInterval(loop, CONFIG.pollIntervalMs);
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const secretKey = process.env.WALLET_SECRET_KEY;
  if (!secretKey) {
    console.error('WALLET_SECRET_KEY environment variable required');
    process.exit(1);
  }

  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKey)));
  const connection = new Connection(CONFIG.rpcEndpoint, 'confirmed');

  console.log('Wallet:', wallet.publicKey.toString());

  const manager = new LiquidityManager(connection, wallet);

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
  });

  await manager.run();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
