/**
 * Alpha Vault - Participation Example
 *
 * Demonstrates how to participate in token launches via Alpha Vault.
 *
 * Prerequisites:
 * - npm install @meteora-ag/alpha-vault @solana/web3.js
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { AlphaVault } from '@meteora-ag/alpha-vault';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const VAULT_ADDRESS = new PublicKey('YOUR_ALPHA_VAULT_ADDRESS');

async function participateInLaunch() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 2. Create Alpha Vault instance
  const alphaVault = await AlphaVault.create(connection, VAULT_ADDRESS);

  // 3. Get vault state
  const vaultState = await alphaVault.getVaultState();

  console.log('\n=== Alpha Vault Info ===');
  console.log('Pool:', vaultState.pool.toString());
  console.log('Quote Mint:', vaultState.quoteMint.toString());
  console.log('Base Mint:', vaultState.baseMint.toString());
  console.log('Total Deposited:', vaultState.totalDeposited.toString());
  console.log('Max Deposit:', vaultState.maxDeposit.toString());
  console.log('Max Per User:', vaultState.maxDepositPerUser.toString());
  console.log('Token Price:', vaultState.tokenPrice.toString());
  console.log('Total Tokens:', vaultState.totalTokens.toString());

  // 4. Check timing
  const now = Date.now() / 1000;
  const startTime = vaultState.startTime.toNumber();
  const endTime = vaultState.endTime.toNumber();
  const claimableTime = vaultState.claimableTime.toNumber();

  console.log('\n=== Timeline ===');
  console.log('Start:', new Date(startTime * 1000).toISOString());
  console.log('End:', new Date(endTime * 1000).toISOString());
  console.log('Claims Open:', new Date(claimableTime * 1000).toISOString());

  // Determine current phase
  let phase: string;
  if (now < startTime) {
    phase = 'NOT_STARTED';
    console.log('\nStatus: Deposit window not yet open');
    console.log('Opens in:', Math.floor((startTime - now) / 60), 'minutes');
  } else if (now < endTime) {
    phase = 'DEPOSIT_OPEN';
    console.log('\nStatus: DEPOSIT WINDOW OPEN');
    console.log('Closes in:', Math.floor((endTime - now) / 60), 'minutes');
  } else if (now < claimableTime) {
    phase = 'WAITING';
    console.log('\nStatus: Waiting for launch');
    console.log('Claims open in:', Math.floor((claimableTime - now) / 60), 'minutes');
  } else {
    phase = 'CLAIMS_OPEN';
    console.log('\nStatus: CLAIMS OPEN');
  }

  // 5. Check user's current allocation
  const allocation = await alphaVault.getUserAllocation(wallet.publicKey);

  console.log('\n=== Your Allocation ===');
  console.log('Deposited:', allocation.depositAmount.toString());
  console.log('Token Allocation:', allocation.tokenAllocation.toString());
  console.log('Claimed:', allocation.claimed);

  if (allocation.depositAmount.gt(new BN(0))) {
    // Calculate allocation percentage
    const percentage = allocation.depositAmount
      .mul(new BN(10000))
      .div(vaultState.totalDeposited);
    console.log('Your Share:', (percentage.toNumber() / 100).toFixed(2), '%');
  }

  // 6. Deposit (if window is open)
  if (phase === 'DEPOSIT_OPEN') {
    // Check remaining capacity
    const remaining = vaultState.maxDeposit.sub(vaultState.totalDeposited);
    console.log('\n=== Depositing ===');
    console.log('Remaining capacity:', remaining.toString());

    // Respect per-user limit
    const userRemaining = vaultState.maxDepositPerUser.sub(allocation.depositAmount);
    const depositAmount = BN.min(new BN(100_000_000), userRemaining); // 0.1 SOL or user limit

    if (depositAmount.lte(new BN(0))) {
      console.log('Already at max deposit limit');
      return;
    }

    console.log('Depositing:', depositAmount.toString());

    const depositTx = await alphaVault.deposit({
      payer: wallet.publicKey,
      amount: depositAmount,
    });

    const txHash = await sendAndConfirmTransaction(connection, depositTx, [wallet], {
      commitment: 'confirmed',
    });

    console.log('Deposit successful!');
    console.log('Transaction:', txHash);

    // Check new allocation
    const newAllocation = await alphaVault.getUserAllocation(wallet.publicKey);
    console.log('New deposit amount:', newAllocation.depositAmount.toString());
  }

  // 7. Claim tokens (if claims are open)
  if (phase === 'CLAIMS_OPEN') {
    if (allocation.claimed) {
      console.log('\nAlready claimed tokens');
      return;
    }

    if (allocation.tokenAllocation.eq(new BN(0))) {
      console.log('\nNo tokens to claim');
      return;
    }

    console.log('\n=== Claiming Tokens ===');
    console.log('Tokens to claim:', allocation.tokenAllocation.toString());

    const claimTx = await alphaVault.claimTokens({
      payer: wallet.publicKey,
    });

    const txHash = await sendAndConfirmTransaction(connection, claimTx, [wallet], {
      commitment: 'confirmed',
    });

    console.log('Claim successful!');
    console.log('Transaction:', txHash);
    console.log('Tokens received:', allocation.tokenAllocation.toString());
  }
}

// Withdraw before launch (if allowed)
async function withdrawFromVault() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const alphaVault = await AlphaVault.create(connection, VAULT_ADDRESS);
  const vaultState = await alphaVault.getVaultState();
  const allocation = await alphaVault.getUserAllocation(wallet.publicKey);

  const now = Date.now() / 1000;

  // Can only withdraw before claims open
  if (now >= vaultState.claimableTime.toNumber()) {
    console.log('Cannot withdraw after claims open');
    return;
  }

  if (allocation.depositAmount.eq(new BN(0))) {
    console.log('No deposit to withdraw');
    return;
  }

  console.log('=== Withdrawing ===');
  console.log('Amount:', allocation.depositAmount.toString());

  const withdrawTx = await alphaVault.withdraw({
    payer: wallet.publicKey,
    amount: allocation.depositAmount,
  });

  const txHash = await sendAndConfirmTransaction(connection, withdrawTx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('Withdrawal successful!');
  console.log('Transaction:', txHash);
}

// Monitor vault fill status
async function monitorVaultStatus() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const alphaVault = await AlphaVault.create(connection, VAULT_ADDRESS);

  console.log('=== Monitoring Alpha Vault ===\n');

  const poll = async () => {
    await alphaVault.refreshState();
    const state = await alphaVault.getVaultState();
    const now = Date.now() / 1000;

    console.clear();
    console.log('=== Alpha Vault Status ===');
    console.log('Time:', new Date().toISOString());
    console.log('');

    // Fill progress
    const fillPercent = state.totalDeposited
      .mul(new BN(10000))
      .div(state.maxDeposit)
      .toNumber() / 100;

    console.log(`Deposits: ${state.totalDeposited.toString()} / ${state.maxDeposit.toString()}`);
    console.log(`Fill: ${fillPercent.toFixed(2)}%`);

    // Progress bar
    const filled = Math.floor(fillPercent / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    console.log(`[${bar}]`);

    // Timing
    console.log('');
    if (now < state.startTime.toNumber()) {
      const countdown = state.startTime.toNumber() - now;
      console.log(`Opens in: ${Math.floor(countdown / 60)} minutes`);
    } else if (now < state.endTime.toNumber()) {
      const remaining = state.endTime.toNumber() - now;
      console.log(`OPEN - Closes in: ${Math.floor(remaining / 60)} minutes`);
    } else if (now < state.claimableTime.toNumber()) {
      const remaining = state.claimableTime.toNumber() - now;
      console.log(`CLOSED - Claims in: ${Math.floor(remaining / 60)} minutes`);
    } else {
      console.log('CLAIMS OPEN');
      console.log(`Claimed: ${state.claimed.toString()} / ${state.totalTokens.toString()}`);
    }
  };

  await poll();
  setInterval(poll, 5000);
}

// Calculate expected allocation
async function calculateExpectedAllocation(depositAmount: BN) {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const alphaVault = await AlphaVault.create(connection, VAULT_ADDRESS);
  const state = await alphaVault.getVaultState();

  console.log('=== Allocation Calculator ===\n');

  // Assuming pro-rata distribution
  const projectedTotal = state.totalDeposited.add(depositAmount);
  const expectedShare = depositAmount.mul(new BN(10000)).div(projectedTotal);
  const expectedTokens = state.totalTokens.mul(depositAmount).div(projectedTotal);

  console.log('Deposit Amount:', depositAmount.toString());
  console.log('Current Total Deposits:', state.totalDeposited.toString());
  console.log('Projected Total:', projectedTotal.toString());
  console.log('Expected Share:', (expectedShare.toNumber() / 100).toFixed(2), '%');
  console.log('Expected Tokens:', expectedTokens.toString());

  // Token value at launch price
  const tokenValue = expectedTokens.mul(state.tokenPrice).div(new BN(1e9));
  console.log('Expected Value at Launch:', tokenValue.toString(), 'lamports');
}

// Run
participateInLaunch()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
