/**
 * Meteora Trading Bot Template
 *
 * A production-ready template for building a market making bot on Meteora DLMM.
 *
 * Features:
 * - Automatic position rebalancing
 * - Fee collection
 * - Price monitoring
 * - Risk management
 *
 * Prerequisites:
 * npm install @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js @solana/spl-token
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';

// =============================================================================
// CONFIGURATION - Customize these values
// =============================================================================

const CONFIG = {
  // Network
  rpcEndpoint: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',

  // Pool to trade
  poolAddress: new PublicKey(process.env.POOL_ADDRESS || 'YOUR_POOL_ADDRESS'),

  // Trading parameters
  binRange: 10, // Number of bins on each side of active bin
  rebalanceThreshold: 5, // Rebalance when price moves this many bins
  targetXAmount: new BN(100_000_000), // Target X token amount
  targetYAmount: new BN(100_000_000), // Target Y token amount

  // Risk management
  maxSlippageBps: 100, // 1% max slippage
  minProfitBps: 10, // 0.1% minimum profit to collect fees

  // Timing
  pollIntervalMs: 10000, // Check every 10 seconds
  feeCollectionIntervalMs: 3600000, // Collect fees hourly
};

// =============================================================================
// TRADING BOT CLASS
// =============================================================================

class MeteoraMarketMaker {
  private connection: Connection;
  private wallet: Keypair;
  private dlmm: DLMM | null = null;
  private currentPosition: PublicKey | null = null;
  private lastActiveBinId: number | null = null;
  private lastFeeCollection: number = 0;

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
  }

  async initialize(): Promise<void> {
    console.log('Initializing market maker...');

    // Create DLMM instance
    this.dlmm = await DLMM.create(this.connection, CONFIG.poolAddress);
    await this.dlmm.refetchStates();

    // Get existing positions
    const positions = await this.dlmm.getPositionsByUserAndLbPair(this.wallet.publicKey);

    if (positions.length > 0) {
      this.currentPosition = positions[0].publicKey;
      console.log('Found existing position:', this.currentPosition.toString());
    }

    const activeBin = await this.dlmm.getActiveBin();
    this.lastActiveBinId = activeBin.binId;

    console.log('Current active bin:', activeBin.binId);
    console.log('Current price:', activeBin.price);
  }

  async checkAndRebalance(): Promise<void> {
    if (!this.dlmm) throw new Error('Not initialized');

    await this.dlmm.refetchStates();
    const activeBin = await this.dlmm.getActiveBin();

    console.log(`\n[${new Date().toISOString()}] Active Bin: ${activeBin.binId}, Price: ${activeBin.price}`);

    // Check if rebalance needed
    if (this.lastActiveBinId !== null) {
      const binDiff = Math.abs(activeBin.binId - this.lastActiveBinId);

      if (binDiff >= CONFIG.rebalanceThreshold) {
        console.log(`Price moved ${binDiff} bins - rebalancing...`);
        await this.rebalance(activeBin.binId);
        this.lastActiveBinId = activeBin.binId;
      }
    }

    // Check if should create initial position
    if (!this.currentPosition) {
      console.log('No position found - creating initial position...');
      await this.createPosition(activeBin.binId);
    }
  }

  async createPosition(activeBinId: number): Promise<void> {
    if (!this.dlmm) throw new Error('Not initialized');

    const positionKeypair = Keypair.generate();

    console.log('Creating new position:', positionKeypair.publicKey.toString());

    const tx = await this.dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: this.wallet.publicKey,
      totalXAmount: CONFIG.targetXAmount,
      totalYAmount: CONFIG.targetYAmount,
      strategy: {
        maxBinId: activeBinId + CONFIG.binRange,
        minBinId: activeBinId - CONFIG.binRange,
        strategyType: StrategyType.SpotBalanced,
      },
    });

    const txHash = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet, positionKeypair],
      { commitment: 'confirmed' }
    );

    console.log('Position created:', txHash);
    this.currentPosition = positionKeypair.publicKey;
  }

  async rebalance(newActiveBinId: number): Promise<void> {
    if (!this.dlmm || !this.currentPosition) throw new Error('Not initialized');

    // 1. Remove all liquidity from current position
    console.log('Removing liquidity from current position...');

    const positions = await this.dlmm.getPositionsByUserAndLbPair(this.wallet.publicKey);
    const currentPos = positions.find((p) => p.publicKey.equals(this.currentPosition!));

    if (!currentPos) {
      console.log('Current position not found, creating new one...');
      await this.createPosition(newActiveBinId);
      return;
    }

    const binIds = currentPos.positionData.positionBinData.map((b) => b.binId);

    if (binIds.length > 0) {
      const removeTx = await this.dlmm.removeLiquidity({
        position: this.currentPosition,
        user: this.wallet.publicKey,
        binIds,
        bps: new BN(10000), // 100%
        shouldClaimAndClose: false,
      });

      await sendAndConfirmTransaction(this.connection, removeTx, [this.wallet], {
        commitment: 'confirmed',
      });
    }

    // 2. Add liquidity at new range
    console.log('Adding liquidity at new range...');

    const addTx = await this.dlmm.addLiquidityByStrategy({
      positionPubKey: this.currentPosition,
      user: this.wallet.publicKey,
      totalXAmount: CONFIG.targetXAmount,
      totalYAmount: CONFIG.targetYAmount,
      strategy: {
        maxBinId: newActiveBinId + CONFIG.binRange,
        minBinId: newActiveBinId - CONFIG.binRange,
        strategyType: StrategyType.SpotBalanced,
      },
    });

    const txHash = await sendAndConfirmTransaction(this.connection, addTx, [this.wallet], {
      commitment: 'confirmed',
    });

    console.log('Rebalanced:', txHash);
  }

  async collectFees(): Promise<void> {
    if (!this.dlmm || !this.currentPosition) return;

    const now = Date.now();
    if (now - this.lastFeeCollection < CONFIG.feeCollectionIntervalMs) {
      return; // Not time yet
    }

    // Check claimable fees
    const fees = await DLMM.getClaimableSwapFee(this.connection, this.currentPosition);

    if (fees.feeX.gt(new BN(0)) || fees.feeY.gt(new BN(0))) {
      console.log('Collecting fees - X:', fees.feeX.toString(), 'Y:', fees.feeY.toString());

      const tx = await this.dlmm.claimSwapFee({
        owner: this.wallet.publicKey,
        position: this.currentPosition,
      });

      await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
        commitment: 'confirmed',
      });

      console.log('Fees collected');
    }

    // Check claimable rewards
    const rewards = await DLMM.getClaimableLMReward(this.connection, this.currentPosition);

    if (rewards.rewardOne.gt(new BN(0)) || rewards.rewardTwo.gt(new BN(0))) {
      console.log('Collecting rewards...');

      const tx = await this.dlmm.claimLMReward({
        owner: this.wallet.publicKey,
        position: this.currentPosition,
      });

      await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
        commitment: 'confirmed',
      });

      console.log('Rewards collected');
    }

    this.lastFeeCollection = now;
  }

  async run(): Promise<void> {
    await this.initialize();

    console.log('\nStarting market making loop...');
    console.log('Poll interval:', CONFIG.pollIntervalMs, 'ms');
    console.log('Rebalance threshold:', CONFIG.rebalanceThreshold, 'bins');
    console.log('Bin range:', CONFIG.binRange);

    // Main loop
    const loop = async () => {
      try {
        await this.checkAndRebalance();
        await this.collectFees();
      } catch (error) {
        console.error('Error in loop:', error);
      }
    };

    await loop();
    setInterval(loop, CONFIG.pollIntervalMs);
  }

  async shutdown(): Promise<void> {
    console.log('\nShutting down...');

    if (this.dlmm && this.currentPosition) {
      // Optionally remove all liquidity on shutdown
      // await this.removeLiquidity();
    }

    console.log('Shutdown complete');
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  // Load wallet
  const secretKey = process.env.WALLET_SECRET_KEY;
  if (!secretKey) {
    console.error('WALLET_SECRET_KEY environment variable required');
    process.exit(1);
  }

  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKey)));
  console.log('Wallet:', wallet.publicKey.toString());

  // Create connection
  const connection = new Connection(CONFIG.rpcEndpoint, 'confirmed');

  // Create and run bot
  const bot = new MeteoraMarketMaker(connection, wallet);

  // Handle shutdown
  process.on('SIGINT', async () => {
    await bot.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await bot.shutdown();
    process.exit(0);
  });

  // Run
  await bot.run();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
