/**
 * Lulo Balance & Account Examples
 *
 * This file demonstrates how to query account data, balances,
 * interest earned, and APY information from Lulo.
 */

import { Connection, PublicKey } from '@solana/web3.js';

// Configuration
const LULO_API_URL = 'https://api.lulo.fi';

// Types
interface LuloPosition {
  mint: string;
  symbol: string;
  depositType: 'protected' | 'boosted' | 'regular';
  balance: number;
  interestEarned: number;
  apy: number;
  protocol?: string;
}

interface LuloReward {
  mint: string;
  symbol: string;
  amount: number;
  claimable: boolean;
}

interface LuloAccount {
  totalDeposited: number;
  totalInterestEarned: number;
  currentApy: number;
  positions: LuloPosition[];
  rewards: LuloReward[];
}

interface LuloPool {
  mint: string;
  symbol: string;
  decimals: number;
  protectedApy: number;
  boostedApy: number;
  customApy: number;
  totalDeposited: number;
  protectedDeposits: number;
  boostedDeposits: number;
  availableCapacity: number;
  coverageRatio: number;
  protocols: {
    name: string;
    apy: number;
    allocation: number;
  }[];
}

interface HistoryEvent {
  type: 'deposit' | 'withdraw' | 'rebalance';
  timestamp: number;
  mint: string;
  amount: number;
  depositType?: string;
  signature?: string;
  fromProtocol?: string;
  toProtocol?: string;
  reason?: string;
}

/**
 * Get account data including balances and positions
 */
async function getAccountData(walletAddress: string): Promise<LuloAccount> {
  const response = await fetch(
    `${LULO_API_URL}/v1/account/${walletAddress}`,
    {
      headers: {
        'x-api-key': process.env.LULO_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to fetch account: ${JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Get account transaction history
 */
async function getAccountHistory(
  walletAddress: string,
  options: {
    limit?: number;
    offset?: number;
    type?: 'deposit' | 'withdraw' | 'rebalance';
  } = {}
): Promise<{ events: HistoryEvent[]; total: number }> {
  const params = new URLSearchParams();
  if (options.limit) params.append('limit', options.limit.toString());
  if (options.offset) params.append('offset', options.offset.toString());
  if (options.type) params.append('type', options.type);

  const response = await fetch(
    `${LULO_API_URL}/v1/account/${walletAddress}/history?${params}`,
    {
      headers: {
        'x-api-key': process.env.LULO_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to fetch account history');
  }

  return response.json();
}

/**
 * Get current pool data and APY rates
 */
async function getPoolData(): Promise<{ pools: LuloPool[] }> {
  const response = await fetch(`${LULO_API_URL}/v1/pools`, {
    headers: {
      'x-api-key': process.env.LULO_API_KEY!,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch pool data');
  }

  return response.json();
}

/**
 * Get historical rates for a specific token
 */
async function getRatesHistory(
  mintAddress: string,
  period: '1h' | '24h' | '7d' | '30d' = '24h'
): Promise<any> {
  const response = await fetch(
    `${LULO_API_URL}/v1/rates?mint=${mintAddress}&period=${period}`,
    {
      headers: {
        'x-api-key': process.env.LULO_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to fetch rates history');
  }

  return response.json();
}

/**
 * Example 1: Display Account Summary
 */
async function displayAccountSummary(walletAddress: string): Promise<void> {
  const account = await getAccountData(walletAddress);

  console.log('\n=== Lulo Account Summary ===');
  console.log(`Total Deposited: $${formatAmount(account.totalDeposited, 6)}`);
  console.log(`Total Interest Earned: $${formatAmount(account.totalInterestEarned, 6)}`);
  console.log(`Current APY: ${account.currentApy.toFixed(2)}%`);

  console.log('\n--- Positions ---');
  for (const position of account.positions) {
    console.log(`\n${position.symbol} (${position.depositType}):`);
    console.log(`  Balance: ${formatAmount(position.balance, 6)}`);
    console.log(`  Interest Earned: ${formatAmount(position.interestEarned, 6)}`);
    console.log(`  APY: ${position.apy.toFixed(2)}%`);
    if (position.protocol) {
      console.log(`  Current Protocol: ${position.protocol}`);
    }
  }

  if (account.rewards && account.rewards.length > 0) {
    console.log('\n--- Claimable Rewards ---');
    for (const reward of account.rewards) {
      console.log(`${reward.symbol}: ${formatAmount(reward.amount, 6)} ${reward.claimable ? '(claimable)' : ''}`);
    }
  }
}

/**
 * Example 2: Display Current APY Rates
 */
async function displayCurrentRates(): Promise<void> {
  const { pools } = await getPoolData();

  console.log('\n=== Current Lulo APY Rates ===');
  console.log('Token\t\tProtected\tBoosted\t\tCustom');
  console.log('-'.repeat(60));

  for (const pool of pools) {
    console.log(
      `${pool.symbol.padEnd(8)}\t${pool.protectedApy.toFixed(2)}%\t\t${pool.boostedApy.toFixed(2)}%\t\t${pool.customApy.toFixed(2)}%`
    );
  }
}

/**
 * Example 3: Get Position for Specific Token
 */
async function getPositionByToken(
  walletAddress: string,
  mintAddress: string,
  depositType?: 'protected' | 'boosted' | 'regular'
): Promise<LuloPosition | null> {
  const account = await getAccountData(walletAddress);

  const position = account.positions.find(
    (p) =>
      p.mint === mintAddress &&
      (depositType ? p.depositType === depositType : true)
  );

  return position || null;
}

/**
 * Example 4: Calculate Earnings Over Time
 */
async function calculateEarnings(
  walletAddress: string,
  days: number
): Promise<{
  totalDeposited: number;
  totalEarned: number;
  dailyAverage: number;
  projectedAnnual: number;
}> {
  const account = await getAccountData(walletAddress);

  const dailyAverage = account.totalInterestEarned / days;
  const projectedAnnual = dailyAverage * 365;

  return {
    totalDeposited: account.totalDeposited,
    totalEarned: account.totalInterestEarned,
    dailyAverage,
    projectedAnnual,
  };
}

/**
 * Example 5: Compare Pool Rates
 */
async function findBestRate(
  depositType: 'protected' | 'boosted'
): Promise<LuloPool | null> {
  const { pools } = await getPoolData();

  let bestPool: LuloPool | null = null;
  let bestRate = 0;

  for (const pool of pools) {
    const rate = depositType === 'protected' ? pool.protectedApy : pool.boostedApy;
    if (rate > bestRate) {
      bestRate = rate;
      bestPool = pool;
    }
  }

  return bestPool;
}

/**
 * Example 6: Monitor Account Changes
 */
async function monitorAccount(
  walletAddress: string,
  interval: number = 60000 // 1 minute
): Promise<void> {
  console.log(`Monitoring account ${walletAddress}...`);

  let previousBalance = 0;

  const check = async () => {
    try {
      const account = await getAccountData(walletAddress);
      const currentBalance = account.totalDeposited + account.totalInterestEarned;

      if (previousBalance > 0) {
        const change = currentBalance - previousBalance;
        if (change !== 0) {
          console.log(
            `[${new Date().toISOString()}] Balance change: ${change > 0 ? '+' : ''}${formatAmount(change, 6)}`
          );
        }
      }

      previousBalance = currentBalance;
    } catch (error) {
      console.error('Error checking account:', error);
    }
  };

  // Initial check
  await check();

  // Set up interval
  setInterval(check, interval);
}

/**
 * Example 7: Get Protocol Allocation
 */
async function getProtocolAllocation(mintAddress: string): Promise<void> {
  const { pools } = await getPoolData();
  const pool = pools.find((p) => p.mint === mintAddress);

  if (!pool) {
    console.log('Pool not found for mint:', mintAddress);
    return;
  }

  console.log(`\n=== ${pool.symbol} Protocol Allocation ===`);
  console.log(`Total Deposited: $${formatAmount(pool.totalDeposited, 6)}`);
  console.log(`Coverage Ratio: ${(pool.coverageRatio * 100).toFixed(2)}%`);

  console.log('\nProtocol Breakdown:');
  for (const protocol of pool.protocols) {
    console.log(
      `  ${protocol.name}: ${(protocol.allocation * 100).toFixed(1)}% (${protocol.apy.toFixed(2)}% APY)`
    );
  }
}

/**
 * Example 8: Get Rebalancing History
 */
async function getRebalanceHistory(walletAddress: string): Promise<void> {
  const { events } = await getAccountHistory(walletAddress, {
    type: 'rebalance',
    limit: 10,
  });

  console.log('\n=== Recent Rebalancing Events ===');

  if (events.length === 0) {
    console.log('No rebalancing events found');
    return;
  }

  for (const event of events) {
    const date = new Date(event.timestamp * 1000).toLocaleString();
    console.log(
      `[${date}] ${event.fromProtocol} -> ${event.toProtocol} (${event.reason})`
    );
  }
}

/**
 * Helper: Format token amount with decimals
 */
function formatAmount(amount: number, decimals: number): string {
  return (amount / Math.pow(10, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Main execution
 */
async function main() {
  const walletAddress = process.env.WALLET_ADDRESS || '';

  if (!walletAddress) {
    console.error('Please set WALLET_ADDRESS environment variable');
    process.exit(1);
  }

  try {
    // Display account summary
    await displayAccountSummary(walletAddress);

    // Display current rates
    await displayCurrentRates();

    // Find best protected rate
    const bestProtected = await findBestRate('protected');
    if (bestProtected) {
      console.log(
        `\nBest Protected Rate: ${bestProtected.symbol} at ${bestProtected.protectedApy.toFixed(2)}%`
      );
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run if executed directly
main().catch(console.error);

export {
  getAccountData,
  getAccountHistory,
  getPoolData,
  getRatesHistory,
  displayAccountSummary,
  displayCurrentRates,
  getPositionByToken,
  calculateEarnings,
  findBestRate,
  monitorAccount,
  getProtocolAllocation,
  getRebalanceHistory,
  formatAmount,
};
