/**
 * CoinGecko Solana API: Recent Trades Examples
 *
 * Demonstrates fetching recent trade history for pools
 * and analyzing trading activity.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  demo: {
    baseUrl: 'https://api.coingecko.com/api/v3/onchain',
    headerKey: 'x-cg-demo-api-key',
  },
  pro: {
    baseUrl: 'https://pro-api.coingecko.com/api/v3/onchain',
    headerKey: 'x-cg-pro-api-key',
  },
};

const API_TYPE = (process.env.COINGECKO_API_TYPE || 'demo') as 'demo' | 'pro';
const API_KEY = process.env.COINGECKO_API_KEY!;
const BASE_URL = CONFIG[API_TYPE].baseUrl;
const HEADER_KEY = CONFIG[API_TYPE].headerKey;
const NETWORK = 'solana';

// ============================================================================
// TYPES
// ============================================================================

interface TradeAttributes {
  block_number: number;
  block_timestamp: string;
  tx_hash: string;
  tx_from_address: string;
  from_token_amount: string;
  to_token_amount: string;
  price_from_in_currency_token: string;
  price_to_in_currency_token: string;
  price_from_in_usd: string;
  price_to_in_usd: string;
  kind: 'buy' | 'sell';
  volume_in_usd: string;
}

interface TradesResponse {
  data: Array<{
    id: string;
    type: string;
    attributes: TradeAttributes;
  }>;
}

interface Trade {
  txHash: string;
  timestamp: Date;
  type: 'buy' | 'sell';
  fromAmount: number;
  toAmount: number;
  priceUsd: number;
  volumeUsd: number;
  trader: string;
}

interface TradeAnalysis {
  totalTrades: number;
  buyCount: number;
  sellCount: number;
  totalVolumeUsd: number;
  avgTradeSize: number;
  largestTrade: Trade | null;
  buyPressure: number; // Percentage of buys
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function fetchApi<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    headers: {
      [HEADER_KEY]: API_KEY,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function parseTrade(item: TradesResponse['data'][0]): Trade {
  const attrs = item.attributes;
  return {
    txHash: attrs.tx_hash,
    timestamp: new Date(attrs.block_timestamp),
    type: attrs.kind,
    fromAmount: parseFloat(attrs.from_token_amount || '0'),
    toAmount: parseFloat(attrs.to_token_amount || '0'),
    priceUsd: parseFloat(attrs.price_to_in_usd || '0'),
    volumeUsd: parseFloat(attrs.volume_in_usd || '0'),
    trader: attrs.tx_from_address,
  };
}

// ============================================================================
// EXAMPLE 1: Get Recent Trades
// ============================================================================

async function getRecentTrades(poolAddress: string): Promise<Trade[]> {
  const data = await fetchApi<TradesResponse>(
    `/networks/${NETWORK}/pools/${poolAddress}/trades`
  );

  return data.data.map(parseTrade);
}

// ============================================================================
// EXAMPLE 2: Get Large Trades Only
// ============================================================================

async function getLargeTrades(
  poolAddress: string,
  minVolumeUsd: number = 1000
): Promise<Trade[]> {
  const data = await fetchApi<TradesResponse>(
    `/networks/${NETWORK}/pools/${poolAddress}/trades`,
    {
      trade_volume_in_usd_greater_than: minVolumeUsd.toString(),
    }
  );

  return data.data.map(parseTrade);
}

// ============================================================================
// EXAMPLE 3: Analyze Trading Activity
// ============================================================================

async function analyzeTrading(poolAddress: string): Promise<TradeAnalysis> {
  const trades = await getRecentTrades(poolAddress);

  if (trades.length === 0) {
    return {
      totalTrades: 0,
      buyCount: 0,
      sellCount: 0,
      totalVolumeUsd: 0,
      avgTradeSize: 0,
      largestTrade: null,
      buyPressure: 0,
    };
  }

  const buyCount = trades.filter((t) => t.type === 'buy').length;
  const sellCount = trades.filter((t) => t.type === 'sell').length;
  const totalVolumeUsd = trades.reduce((sum, t) => sum + t.volumeUsd, 0);
  const largestTrade = trades.reduce(
    (max, t) => (t.volumeUsd > (max?.volumeUsd || 0) ? t : max),
    null as Trade | null
  );

  return {
    totalTrades: trades.length,
    buyCount,
    sellCount,
    totalVolumeUsd,
    avgTradeSize: totalVolumeUsd / trades.length,
    largestTrade,
    buyPressure: (buyCount / trades.length) * 100,
  };
}

// ============================================================================
// EXAMPLE 4: Monitor Trades in Real-time
// ============================================================================

async function monitorTrades(
  poolAddress: string,
  intervalMs: number = 30000,
  onNewTrades: (trades: Trade[]) => void
): Promise<() => void> {
  let lastTxHash: string | null = null;
  let isRunning = true;

  const poll = async () => {
    while (isRunning) {
      try {
        const trades = await getRecentTrades(poolAddress);

        if (trades.length > 0) {
          if (lastTxHash) {
            const newTradeIndex = trades.findIndex((t) => t.txHash === lastTxHash);
            if (newTradeIndex > 0) {
              const newTrades = trades.slice(0, newTradeIndex);
              onNewTrades(newTrades);
            }
          }
          lastTxHash = trades[0].txHash;
        }
      } catch (error) {
        console.error('Trade monitoring error:', error);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  poll();

  return () => {
    isRunning = false;
  };
}

// ============================================================================
// EXAMPLE 5: Group Trades by Time Period
// ============================================================================

interface TradeGroup {
  period: string;
  trades: Trade[];
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

function groupTradesByHour(trades: Trade[]): TradeGroup[] {
  const groups = new Map<string, Trade[]>();

  trades.forEach((trade) => {
    const hour = trade.timestamp.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    if (!groups.has(hour)) {
      groups.set(hour, []);
    }
    groups.get(hour)!.push(trade);
  });

  return Array.from(groups.entries())
    .map(([period, periodTrades]) => {
      const buyVolume = periodTrades
        .filter((t) => t.type === 'buy')
        .reduce((sum, t) => sum + t.volumeUsd, 0);
      const sellVolume = periodTrades
        .filter((t) => t.type === 'sell')
        .reduce((sum, t) => sum + t.volumeUsd, 0);

      return {
        period,
        trades: periodTrades,
        volume: buyVolume + sellVolume,
        buyVolume,
        sellVolume,
      };
    })
    .sort((a, b) => b.period.localeCompare(a.period));
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('CoinGecko Recent Trades Examples\n');
  console.log(`API Type: ${API_TYPE}`);
  console.log(`Network: ${NETWORK}\n`);

  // Example pool address (SOL/USDC on Raydium)
  const poolAddress = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

  try {
    // Example 1: Get recent trades
    console.log('--- Example 1: Recent Trades ---');
    const trades = await getRecentTrades(poolAddress);
    console.log(`Fetched ${trades.length} recent trades`);
    trades.slice(0, 5).forEach((trade, i) => {
      console.log(
        `${i + 1}. ${trade.type.toUpperCase()} $${trade.volumeUsd.toFixed(2)} at ${trade.timestamp.toLocaleTimeString()}`
      );
    });
    console.log();

    // Example 2: Get large trades
    console.log('--- Example 2: Large Trades (>$5000) ---');
    const largeTrades = await getLargeTrades(poolAddress, 5000);
    console.log(`Found ${largeTrades.length} large trades`);
    largeTrades.slice(0, 5).forEach((trade, i) => {
      console.log(
        `${i + 1}. ${trade.type.toUpperCase()} $${trade.volumeUsd.toLocaleString()}`
      );
    });
    console.log();

    // Example 3: Trade analysis
    console.log('--- Example 3: Trade Analysis ---');
    const analysis = await analyzeTrading(poolAddress);
    console.log(`Total Trades: ${analysis.totalTrades}`);
    console.log(`Buys: ${analysis.buyCount} | Sells: ${analysis.sellCount}`);
    console.log(`Buy Pressure: ${analysis.buyPressure.toFixed(1)}%`);
    console.log(`Total Volume: $${analysis.totalVolumeUsd.toLocaleString()}`);
    console.log(`Avg Trade Size: $${analysis.avgTradeSize.toLocaleString()}`);
    if (analysis.largestTrade) {
      console.log(
        `Largest Trade: ${analysis.largestTrade.type.toUpperCase()} $${analysis.largestTrade.volumeUsd.toLocaleString()}`
      );
    }
    console.log();

    // Example 4: Group by hour
    console.log('--- Example 4: Trades Grouped by Hour ---');
    const grouped = groupTradesByHour(trades);
    grouped.slice(0, 3).forEach((group) => {
      const hour = new Date(group.period).toLocaleString();
      console.log(`${hour}: ${group.trades.length} trades, $${group.volume.toLocaleString()} volume`);
      console.log(`  Buy: $${group.buyVolume.toLocaleString()} | Sell: $${group.sellVolume.toLocaleString()}`);
    });

    // Example 5: Monitor trades (commented to avoid continuous polling)
    // console.log('\n--- Example 5: Trade Monitoring ---');
    // const stopMonitoring = await monitorTrades(poolAddress, 30000, (newTrades) => {
    //   newTrades.forEach((trade) => {
    //     console.log(`NEW ${trade.type.toUpperCase()}: $${trade.volumeUsd.toFixed(2)}`);
    //   });
    // });
    // setTimeout(stopMonitoring, 120000); // Stop after 2 minutes
  } catch (error) {
    console.error('Error:', error);
  }
}

main().catch(console.error);
