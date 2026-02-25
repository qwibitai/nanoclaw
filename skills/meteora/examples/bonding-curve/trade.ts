/**
 * Dynamic Bonding Curve - Trading Example
 *
 * Demonstrates how to buy and sell tokens on a bonding curve.
 *
 * Prerequisites:
 * - npm install @meteora-ag/dynamic-bonding-curve-sdk @solana/web3.js
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { DynamicBondingCurve } from '@meteora-ag/dynamic-bonding-curve-sdk';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const POOL_ADDRESS = new PublicKey('YOUR_POOL_ADDRESS');

async function buyTokens() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 2. Initialize DBC
  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  // 3. Fetch pool state
  const poolState = await dbc.fetchPoolState(POOL_ADDRESS);

  console.log('\n=== Pool Info ===');
  console.log('Graduated:', poolState.graduated);
  console.log('Base Reserve:', poolState.baseReserve.toString());
  console.log('Quote Reserve:', poolState.quoteReserve.toString());

  if (poolState.graduated) {
    console.log('\nPool has graduated - trade on DAMM instead');
    return;
  }

  // 4. Get buy quote
  const quoteAmount = new BN(100_000_000); // 0.1 SOL (9 decimals)
  const slippageBps = 100; // 1% slippage

  const buyQuote = await dbc.getBuyQuote({
    pool: POOL_ADDRESS,
    quoteAmount,
  });

  console.log('\n=== Buy Quote ===');
  console.log('SOL to spend:', quoteAmount.toString(), '(0.1 SOL)');
  console.log('Tokens to receive:', buyQuote.baseAmount.toString());
  console.log('Price per token:', buyQuote.price.toString());
  console.log('Price Impact:', buyQuote.priceImpact.toString(), '%');
  console.log('Fee:', buyQuote.fee.toString());

  // 5. Calculate minimum tokens with slippage
  const minTokens = buyQuote.baseAmount
    .mul(new BN(10000 - slippageBps))
    .div(new BN(10000));

  console.log('Min tokens (with slippage):', minTokens.toString());

  // 6. Execute buy
  console.log('\nExecuting buy...');

  const buyTx = await dbc.buy({
    payer: wallet.publicKey,
    pool: POOL_ADDRESS,
    quoteAmount,
    minBaseAmount: minTokens,
  });

  const txHash = await sendAndConfirmTransaction(connection, buyTx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('Buy successful!');
  console.log('Transaction:', txHash);
  console.log(`Explorer: https://solscan.io/tx/${txHash}`);

  // 7. Check new pool state
  const newPoolState = await dbc.fetchPoolState(POOL_ADDRESS);
  console.log('\n=== Updated Pool ===');
  console.log('New Base Reserve:', newPoolState.baseReserve.toString());
  console.log('New Quote Reserve:', newPoolState.quoteReserve.toString());
  console.log('Market Cap:', newPoolState.currentMarketCap.toString());
}

async function sellTokens() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  // 2. Initialize DBC
  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  // 3. Fetch pool state
  const poolState = await dbc.fetchPoolState(POOL_ADDRESS);

  if (poolState.graduated) {
    console.log('Pool has graduated - trade on DAMM instead');
    return;
  }

  // 4. Get sell quote
  const baseAmount = new BN(1_000_000); // Tokens to sell (adjust decimals)
  const slippageBps = 100;

  const sellQuote = await dbc.getSellQuote({
    pool: POOL_ADDRESS,
    baseAmount,
  });

  console.log('=== Sell Quote ===');
  console.log('Tokens to sell:', baseAmount.toString());
  console.log('SOL to receive:', sellQuote.quoteAmount.toString());
  console.log('Price per token:', sellQuote.price.toString());
  console.log('Price Impact:', sellQuote.priceImpact.toString(), '%');

  // 5. Calculate minimum SOL with slippage
  const minQuote = sellQuote.quoteAmount
    .mul(new BN(10000 - slippageBps))
    .div(new BN(10000));

  // 6. Execute sell
  console.log('\nExecuting sell...');

  const sellTx = await dbc.sell({
    payer: wallet.publicKey,
    pool: POOL_ADDRESS,
    baseAmount,
    minQuoteAmount: minQuote,
  });

  const txHash = await sendAndConfirmTransaction(connection, sellTx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('Sell successful!');
  console.log('Transaction:', txHash);
}

// Analyze bonding curve
async function analyzeCurve() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const dbc = new DynamicBondingCurve(connection, 'confirmed');
  const poolState = await dbc.fetchPoolState(POOL_ADDRESS);

  console.log('=== Bonding Curve Analysis ===\n');

  // Simulate different buy amounts
  const buyAmounts = [
    new BN(10_000_000), // 0.01 SOL
    new BN(100_000_000), // 0.1 SOL
    new BN(1_000_000_000), // 1 SOL
    new BN(10_000_000_000), // 10 SOL
  ];

  console.log('Buy Amount (SOL) | Tokens Received | Price/Token | Impact');
  console.log('-'.repeat(65));

  for (const amount of buyAmounts) {
    try {
      const quote = await dbc.getBuyQuote({
        pool: POOL_ADDRESS,
        quoteAmount: amount,
      });

      const solAmount = amount.toNumber() / 1e9;
      const tokens = quote.baseAmount.toString();
      const price = quote.price.toString();
      const impact = quote.priceImpact.toString();

      console.log(
        `${solAmount.toFixed(2).padEnd(16)} | ${tokens.padEnd(15)} | ${price.padEnd(11)} | ${impact}%`
      );
    } catch (e) {
      console.log(`${(amount.toNumber() / 1e9).toFixed(2).padEnd(16)} | Error: ${e}`);
    }
  }

  // Graduation progress
  console.log('\n=== Graduation Progress ===');
  const progress = poolState.currentMarketCap
    .mul(new BN(100))
    .div(poolState.graduationThreshold);
  console.log('Current:', poolState.currentMarketCap.toString(), 'lamports');
  console.log('Target:', poolState.graduationThreshold.toString(), 'lamports');
  console.log('Progress:', progress.toString() + '%');

  // Calculate SOL needed to graduate
  const remaining = poolState.graduationThreshold.sub(poolState.currentMarketCap);
  console.log('\nSOL needed to graduate:', (remaining.toNumber() / 1e9).toFixed(2), 'SOL');
}

// Monitor price changes
async function monitorPrice(intervalMs: number = 5000) {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  let previousPrice: string | null = null;

  console.log('Monitoring bonding curve price...\n');

  setInterval(async () => {
    try {
      const quote = await dbc.getBuyQuote({
        pool: POOL_ADDRESS,
        quoteAmount: new BN(1_000_000), // Small amount for price check
      });

      const currentPrice = quote.price.toString();

      if (previousPrice) {
        const change = parseFloat(currentPrice) - parseFloat(previousPrice);
        const changePercent = (change / parseFloat(previousPrice)) * 100;
        const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';

        console.log(
          `Price: ${currentPrice} ${arrow} ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}%`
        );
      } else {
        console.log(`Price: ${currentPrice}`);
      }

      previousPrice = currentPrice;
    } catch (e) {
      console.log('Error fetching price:', e);
    }
  }, intervalMs);
}

// Run
buyTokens()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
