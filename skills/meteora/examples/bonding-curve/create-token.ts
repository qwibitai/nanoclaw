/**
 * Dynamic Bonding Curve - Token Launch Example
 *
 * Demonstrates how to launch a token on Meteora's Dynamic Bonding Curve.
 *
 * Prerequisites:
 * - npm install @meteora-ag/dynamic-bonding-curve-sdk @solana/web3.js @solana/spl-token
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { DynamicBondingCurve } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT } from '@solana/spl-token';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

async function launchToken() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 2. Initialize DBC
  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  // 3. Create token mint (you would typically do this separately)
  const tokenMint = Keypair.generate();
  console.log('\nNew Token Mint:', tokenMint.publicKey.toString());

  // 4. Token metadata
  const tokenName = 'My Awesome Token';
  const tokenSymbol = 'MAT';
  const tokenUri = 'https://arweave.net/your-metadata.json'; // Upload metadata to Arweave/IPFS

  // 5. Launch parameters
  const totalSupply = new BN(1_000_000_000_000); // 1 million tokens (6 decimals)
  const initialQuote = new BN(0); // Start with 0 SOL

  // Get config address (use appropriate config for your fee tier)
  const configAddress = new PublicKey('CONFIG_ADDRESS_FOR_YOUR_FEE_TIER');

  // 6. Create pool
  console.log('\n=== Launching Token ===');
  console.log('Name:', tokenName);
  console.log('Symbol:', tokenSymbol);
  console.log('Total Supply:', totalSupply.toString());
  console.log('Quote Token: SOL');

  const createPoolTx = await dbc.createPool({
    creator: wallet.publicKey,
    baseMint: tokenMint.publicKey,
    quoteMint: NATIVE_MINT, // SOL as quote
    config: configAddress,
    baseAmount: totalSupply,
    quoteAmount: initialQuote,
    name: tokenName,
    symbol: tokenSymbol,
    uri: tokenUri,
  });

  const txHash = await sendAndConfirmTransaction(
    connection,
    createPoolTx,
    [wallet, tokenMint],
    { commitment: 'confirmed' }
  );

  console.log('\nToken launched successfully!');
  console.log('Transaction:', txHash);
  console.log(`Explorer: https://solscan.io/tx/${txHash}`);

  // 7. Fetch pool state
  // Note: You would need to derive the pool address from the transaction
  console.log('\n=== Pool Created ===');
  console.log('Token Mint:', tokenMint.publicKey.toString());
  console.log('Quote: SOL (Native Mint)');

  // 8. Get initial price
  // Price starts very low and increases as people buy
  console.log('\nBonding curve is now active!');
  console.log('Price will increase as tokens are purchased');
  console.log('Pool will graduate to DAMM when threshold is reached');
}

// Launch with specific metadata structure
async function launchWithMetadata() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  // Metadata structure for Arweave/IPFS
  const metadata = {
    name: 'My Token',
    symbol: 'MTK',
    description: 'A token launched on Meteora Dynamic Bonding Curve',
    image: 'https://arweave.net/your-image-hash',
    external_url: 'https://your-website.com',
    attributes: [
      { trait_type: 'Launch Platform', value: 'Meteora DBC' },
      { trait_type: 'Chain', value: 'Solana' },
    ],
    properties: {
      files: [
        {
          uri: 'https://arweave.net/your-image-hash',
          type: 'image/png',
        },
      ],
      category: 'token',
    },
  };

  // Upload metadata to Arweave/IPFS first, then use the URI
  const metadataUri = 'https://arweave.net/YOUR_METADATA_HASH';

  // Continue with launch...
  console.log('Metadata prepared:', JSON.stringify(metadata, null, 2));
  console.log('Upload this to Arweave/IPFS and use the URI in createPool');
}

// Check pool status after launch
async function checkPoolStatus(poolAddress: PublicKey) {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  const poolState = await dbc.fetchPoolState(poolAddress);

  console.log('=== Pool Status ===');
  console.log('Base Reserve:', poolState.baseReserve.toString());
  console.log('Quote Reserve:', poolState.quoteReserve.toString());
  console.log('Graduated:', poolState.graduated);
  console.log('Current Market Cap:', poolState.currentMarketCap.toString());
  console.log('Graduation Threshold:', poolState.graduationThreshold.toString());

  const progress = poolState.currentMarketCap
    .mul(new BN(100))
    .div(poolState.graduationThreshold);
  console.log('Progress to Graduation:', progress.toString(), '%');

  if (poolState.graduated) {
    console.log('\nPool has graduated!');
    console.log('Graduated at:', new Date(poolState.graduatedAt!.toNumber() * 1000).toISOString());
  } else {
    const remaining = poolState.graduationThreshold.sub(poolState.currentMarketCap);
    console.log('\nRemaining to graduate:', remaining.toString(), 'lamports');
  }
}

// Run
launchToken()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
