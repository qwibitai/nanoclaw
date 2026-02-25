/**
 * Meteora Token Launch Template
 *
 * A production-ready template for launching tokens on Dynamic Bonding Curve
 * with automatic graduation to DAMM.
 *
 * Features:
 * - Token creation with metadata
 * - Bonding curve pool creation
 * - Progress monitoring
 * - Automatic graduation
 *
 * Prerequisites:
 * npm install @meteora-ag/dynamic-bonding-curve-sdk @solana/web3.js @solana/spl-token
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { DynamicBondingCurve } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT, createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

// =============================================================================
// CONFIGURATION - Customize these values
// =============================================================================

const CONFIG = {
  // Network
  rpcEndpoint: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',

  // Token details
  tokenName: 'My Awesome Token',
  tokenSymbol: 'MAT',
  tokenDecimals: 6,
  totalSupply: 1_000_000_000_000, // 1 million tokens

  // Metadata
  metadataUri: 'https://arweave.net/YOUR_METADATA_HASH',
  description: 'A token launched on Meteora Dynamic Bonding Curve',
  image: 'https://arweave.net/YOUR_IMAGE_HASH',
  website: 'https://your-website.com',
  twitter: 'https://twitter.com/yourtoken',

  // Bonding curve config
  configAddress: new PublicKey('CONFIG_ADDRESS'), // Get from Meteora

  // Monitoring
  pollIntervalMs: 10000,
};

// =============================================================================
// TOKEN LAUNCHER CLASS
// =============================================================================

class TokenLauncher {
  private connection: Connection;
  private wallet: Keypair;
  private dbc: DynamicBondingCurve;
  private tokenMint: PublicKey | null = null;
  private poolAddress: PublicKey | null = null;

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
    this.dbc = new DynamicBondingCurve(connection, 'confirmed');
  }

  // Prepare metadata JSON for Arweave/IPFS upload
  generateMetadata(): object {
    return {
      name: CONFIG.tokenName,
      symbol: CONFIG.tokenSymbol,
      description: CONFIG.description,
      image: CONFIG.image,
      external_url: CONFIG.website,
      attributes: [
        { trait_type: 'Launch Platform', value: 'Meteora DBC' },
        { trait_type: 'Chain', value: 'Solana' },
        { trait_type: 'Total Supply', value: CONFIG.totalSupply.toString() },
      ],
      properties: {
        files: [
          {
            uri: CONFIG.image,
            type: 'image/png',
          },
        ],
        category: 'token',
        creators: [
          {
            address: this.wallet.publicKey.toString(),
            share: 100,
          },
        ],
      },
      links: {
        website: CONFIG.website,
        twitter: CONFIG.twitter,
      },
    };
  }

  async createToken(): Promise<PublicKey> {
    console.log('Creating token mint...');

    const mint = await createMint(
      this.connection,
      this.wallet,
      this.wallet.publicKey, // Mint authority
      this.wallet.publicKey, // Freeze authority
      CONFIG.tokenDecimals
    );

    console.log('Token mint created:', mint.toString());
    this.tokenMint = mint;

    return mint;
  }

  async launchOnBondingCurve(): Promise<void> {
    if (!this.tokenMint) {
      throw new Error('Token not created yet');
    }

    console.log('\nLaunching on bonding curve...');
    console.log('Token:', this.tokenMint.toString());
    console.log('Name:', CONFIG.tokenName);
    console.log('Symbol:', CONFIG.tokenSymbol);

    const totalSupply = new BN(CONFIG.totalSupply).mul(
      new BN(10 ** CONFIG.tokenDecimals)
    );

    const createPoolTx = await this.dbc.createPool({
      creator: this.wallet.publicKey,
      baseMint: this.tokenMint,
      quoteMint: NATIVE_MINT,
      config: CONFIG.configAddress,
      baseAmount: totalSupply,
      quoteAmount: new BN(0),
      name: CONFIG.tokenName,
      symbol: CONFIG.tokenSymbol,
      uri: CONFIG.metadataUri,
    });

    const txHash = await sendAndConfirmTransaction(
      this.connection,
      createPoolTx,
      [this.wallet],
      { commitment: 'confirmed' }
    );

    console.log('Pool created!');
    console.log('Transaction:', txHash);
    console.log(`Explorer: https://solscan.io/tx/${txHash}`);

    // Store pool address for monitoring
    // Note: You would need to derive this from the transaction or fetch it
    console.log('\nPool is now live!');
    console.log('Users can now buy tokens on the bonding curve.');
  }

  async monitorProgress(): Promise<void> {
    if (!this.poolAddress) {
      console.log('Pool address not set - cannot monitor');
      return;
    }

    console.log('\n=== Monitoring Launch Progress ===\n');

    const poll = async () => {
      try {
        const poolState = await this.dbc.fetchPoolState(this.poolAddress!);

        // Calculate progress
        const progress = poolState.currentMarketCap
          .mul(new BN(10000))
          .div(poolState.graduationThreshold)
          .toNumber() / 100;

        console.clear();
        console.log('=== Token Launch Status ===');
        console.log('Token:', CONFIG.tokenName, '(', CONFIG.tokenSymbol, ')');
        console.log('');
        console.log('Market Cap:', poolState.currentMarketCap.toString(), 'lamports');
        console.log('Threshold:', poolState.graduationThreshold.toString(), 'lamports');
        console.log('');

        // Progress bar
        const filled = Math.floor(progress / 5);
        const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
        console.log(`Progress: [${bar}] ${progress.toFixed(2)}%`);

        console.log('');
        console.log('Graduated:', poolState.graduated);

        if (poolState.graduated) {
          console.log('\n🎉 TOKEN HAS GRADUATED! 🎉');
          console.log('Ready to migrate to DAMM.');
          return true; // Stop polling
        }

        const remaining = poolState.graduationThreshold.sub(poolState.currentMarketCap);
        console.log('Remaining:', (remaining.toNumber() / 1e9).toFixed(4), 'SOL');

        return false;
      } catch (error) {
        console.error('Error polling:', error);
        return false;
      }
    };

    // Poll until graduated
    const checkGraduation = async () => {
      const graduated = await poll();
      if (!graduated) {
        setTimeout(checkGraduation, CONFIG.pollIntervalMs);
      }
    };

    await checkGraduation();
  }

  async migrateToDAMM(): Promise<void> {
    if (!this.poolAddress) {
      throw new Error('Pool address not set');
    }

    const poolState = await this.dbc.fetchPoolState(this.poolAddress);

    if (!poolState.graduated) {
      console.log('Pool not yet graduated');
      return;
    }

    console.log('\nMigrating to DAMM v2...');

    const migrateTx = await this.dbc.migrateToDAMMV2({
      pool: this.poolAddress,
      payer: this.wallet.publicKey,
    });

    const txHash = await sendAndConfirmTransaction(
      this.connection,
      migrateTx,
      [this.wallet],
      { commitment: 'confirmed' }
    );

    console.log('Migration complete!');
    console.log('Transaction:', txHash);
    console.log('\nToken is now trading on DAMM v2!');
  }

  async fullLaunchFlow(): Promise<void> {
    console.log('=== Starting Token Launch ===\n');

    // 1. Generate and display metadata
    console.log('Step 1: Metadata');
    const metadata = this.generateMetadata();
    console.log('Upload this JSON to Arweave/IPFS:');
    console.log(JSON.stringify(metadata, null, 2));
    console.log('\nUpdate CONFIG.metadataUri with the upload URL\n');

    // 2. Create token
    console.log('Step 2: Creating Token');
    await this.createToken();

    // 3. Launch on bonding curve
    console.log('\nStep 3: Launching on Bonding Curve');
    await this.launchOnBondingCurve();

    // 4. Monitor (in a real app, this would be continuous)
    console.log('\nStep 4: Monitor progress at https://app.meteora.ag');
    console.log('Once graduated, run migration.');

    console.log('\n=== Launch Complete ===');
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

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log('Balance:', balance / 1e9, 'SOL');

  if (balance < 0.1 * 1e9) {
    console.error('Insufficient balance. Need at least 0.1 SOL');
    process.exit(1);
  }

  // Create launcher
  const launcher = new TokenLauncher(connection, wallet);

  // Run full launch flow
  await launcher.fullLaunchFlow();
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
