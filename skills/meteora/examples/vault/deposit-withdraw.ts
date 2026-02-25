/**
 * Dynamic Vault - Deposit and Withdraw Example
 *
 * Demonstrates how to interact with Meteora Dynamic Vaults for yield farming.
 *
 * Prerequisites:
 * - npm install @meteora-ag/vault-sdk @coral-xyz/anchor @solana/web3.js @solana/spl-token
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { VaultImpl, getAmountByShare, getUnmintAmount } from '@meteora-ag/vault-sdk';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT = new PublicKey('YOUR_TOKEN_MINT'); // The token the vault accepts

async function vaultOperations() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 2. Create vault instance
  const vault = await VaultImpl.create(connection, TOKEN_MINT);

  // 3. Get vault info
  const lpSupply = await vault.getVaultSupply();
  const withdrawable = await vault.getWithdrawableAmount();

  console.log('\n=== Vault Info ===');
  console.log('Token Mint:', TOKEN_MINT.toString());
  console.log('Total LP Supply:', lpSupply.toString());
  console.log('Locked Amount:', withdrawable.locked.toString());
  console.log('Unlocked Amount:', withdrawable.unlocked.toString());

  // Calculate APY approximation
  if (lpSupply.gt(new BN(0))) {
    const totalValue = withdrawable.locked.add(withdrawable.unlocked);
    const lpValue = totalValue.mul(new BN(1e9)).div(lpSupply);
    console.log('Value per LP (scaled):', lpValue.toString());
  }

  // 4. Get user's current balance
  const userLpBalance = await vault.getUserBalance(wallet.publicKey);
  console.log('\n=== User Balance ===');
  console.log('LP Tokens:', userLpBalance.toString());

  if (userLpBalance.gt(new BN(0))) {
    const underlyingValue = getAmountByShare(userLpBalance, withdrawable.unlocked, lpSupply);
    console.log('Underlying Value:', underlyingValue.toString());
  }

  // 5. Deposit tokens
  const depositAmount = new BN(100_000_000); // 100 tokens (adjust decimals)

  console.log('\n=== Depositing ===');
  console.log('Amount:', depositAmount.toString());

  const depositTx = await vault.deposit(wallet.publicKey, depositAmount);
  let txHash = await sendAndConfirmTransaction(connection, depositTx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('Deposit successful!');
  console.log('Transaction:', txHash);

  // 6. Check new balance
  const newLpBalance = await vault.getUserBalance(wallet.publicKey);
  const lpReceived = newLpBalance.sub(userLpBalance);
  console.log('LP Tokens received:', lpReceived.toString());

  // 7. Wait and check for yield (in practice, yield accumulates over time)
  console.log('\n=== Checking Yield ===');

  // Refresh vault state
  await vault.getVaultSupply();
  const newWithdrawable = await vault.getWithdrawableAmount();

  const currentValue = getAmountByShare(newLpBalance, newWithdrawable.unlocked, vault.lpSupply);
  console.log('Current underlying value:', currentValue.toString());

  // 8. Withdraw tokens
  console.log('\n=== Withdrawing ===');

  // Calculate how much underlying we can withdraw
  const withdrawLpAmount = newLpBalance.div(new BN(2)); // Withdraw 50%
  const expectedUnderlying = getAmountByShare(
    withdrawLpAmount,
    newWithdrawable.unlocked,
    vault.lpSupply
  );

  console.log('LP to withdraw:', withdrawLpAmount.toString());
  console.log('Expected underlying:', expectedUnderlying.toString());

  const withdrawTx = await vault.withdraw(wallet.publicKey, withdrawLpAmount);
  txHash = await sendAndConfirmTransaction(connection, withdrawTx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('Withdrawal successful!');
  console.log('Transaction:', txHash);

  // 9. Final balance
  const finalLpBalance = await vault.getUserBalance(wallet.publicKey);
  console.log('\nFinal LP Balance:', finalLpBalance.toString());
}

// Vault with affiliate integration
async function vaultWithAffiliate() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  // Create vault with affiliate ID
  const affiliateId = new PublicKey('AFFILIATE_PUBLIC_KEY');
  const vault = await VaultImpl.create(connection, TOKEN_MINT, {
    affiliateId,
  });

  console.log('=== Vault with Affiliate ===');

  // Get affiliate info
  const affiliateInfo = await vault.getAffiliateInfo();
  console.log('Partner:', affiliateInfo.partner.toString());
  console.log('Fee Rate:', affiliateInfo.feeRate, '%');
  console.log('Outstanding Fee:', affiliateInfo.outstandingFee.toString());

  // Operations work the same - fees are tracked automatically
  const depositAmount = new BN(100_000_000);
  const depositTx = await vault.deposit(wallet.publicKey, depositAmount);
  await sendAndConfirmTransaction(connection, depositTx, [wallet]);

  console.log('Deposited with affiliate tracking');
}

// Monitor vault APY
async function monitorVaultYield() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const vault = await VaultImpl.create(connection, TOKEN_MINT);

  console.log('=== Monitoring Vault Yield ===\n');

  let previousLpValue: BN | null = null;
  let previousTime: number | null = null;

  const poll = async () => {
    const lpSupply = await vault.getVaultSupply();
    const withdrawable = await vault.getWithdrawableAmount();
    const currentTime = Date.now();

    // Calculate value per LP token
    const totalValue = withdrawable.unlocked;
    if (lpSupply.eq(new BN(0))) return;

    const lpValue = totalValue.mul(new BN(1e18)).div(lpSupply);

    console.log('Time:', new Date().toISOString());
    console.log('LP Supply:', lpSupply.toString());
    console.log('Total Value:', totalValue.toString());
    console.log('Value per LP:', lpValue.toString());

    if (previousLpValue && previousTime) {
      const timeDiffMs = currentTime - previousTime;
      const timeDiffDays = timeDiffMs / (1000 * 60 * 60 * 24);

      if (lpValue.gt(previousLpValue)) {
        const valueGrowth = lpValue.sub(previousLpValue);
        const growthPercent =
          valueGrowth.mul(new BN(10000)).div(previousLpValue).toNumber() / 100;

        // Annualize
        const annualizedAPY = (growthPercent / timeDiffDays) * 365;

        console.log('Period Growth:', growthPercent.toFixed(4), '%');
        console.log('Annualized APY:', annualizedAPY.toFixed(2), '%');
      }
    }

    previousLpValue = lpValue;
    previousTime = currentTime;
    console.log('---');
  };

  // Poll every minute
  await poll();
  setInterval(poll, 60000);
}

// Calculate optimal deposit/withdraw amounts
async function calculateOptimalAmounts() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const vault = await VaultImpl.create(connection, TOKEN_MINT);

  const lpSupply = await vault.getVaultSupply();
  const withdrawable = await vault.getWithdrawableAmount();

  console.log('=== Optimal Amount Calculator ===\n');

  // For a target deposit amount, calculate expected LP
  const targetDeposit = new BN(1_000_000_000); // 1000 tokens
  const expectedLp = targetDeposit.mul(lpSupply).div(withdrawable.unlocked);
  console.log(`Deposit ${targetDeposit.toString()} → Expected LP: ${expectedLp.toString()}`);

  // For target withdrawal amount, calculate LP needed
  const targetWithdraw = new BN(500_000_000); // 500 tokens
  const lpNeeded = getUnmintAmount(targetWithdraw, withdrawable.unlocked, lpSupply);
  console.log(`Withdraw ${targetWithdraw.toString()} → LP Needed: ${lpNeeded.toString()}`);

  // Calculate max withdrawable
  const userLpBalance = new BN(100_000_000); // Example user balance
  const maxWithdrawable = getAmountByShare(userLpBalance, withdrawable.unlocked, lpSupply);
  console.log(`Max withdrawable with ${userLpBalance.toString()} LP: ${maxWithdrawable.toString()}`);
}

// Run
vaultOperations()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
