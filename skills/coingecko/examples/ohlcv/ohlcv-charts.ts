/**
 * CoinGecko Solana API: OHLCV Chart Examples
 *
 * Demonstrates fetching OHLCV (Open, High, Low, Close, Volume)
 * candlestick data for technical analysis.
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

interface OHLCVResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      ohlcv_list: number[][]; // [timestamp, open, high, low, close, volume]
    };
  };
}

interface Candle {
  timestamp: number;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type Timeframe = 'day' | 'hour' | 'minute';
type Aggregation = 1 | 4 | 5 | 12 | 15;

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

function parseCandles(ohlcvList: number[][]): Candle[] {
  return ohlcvList.map((candle) => ({
    timestamp: candle[0],
    date: new Date(candle[0] * 1000),
    open: candle[1],
    high: candle[2],
    low: candle[3],
    close: candle[4],
    volume: candle[5],
  }));
}

// ============================================================================
// EXAMPLE 1: Get Pool OHLCV Data
// ============================================================================

async function getPoolOHLCV(
  poolAddress: string,
  timeframe: Timeframe = 'hour',
  aggregate: Aggregation = 1,
  limit: number = 100,
  currency: 'usd' | 'token' = 'usd'
): Promise<Candle[]> {
  const data = await fetchApi<OHLCVResponse>(
    `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`,
    {
      aggregate: aggregate.toString(),
      limit: limit.toString(),
      currency,
    }
  );

  return parseCandles(data.data?.attributes?.ohlcv_list || []);
}

// ============================================================================
// EXAMPLE 2: Get Token OHLCV Data
// ============================================================================

async function getTokenOHLCV(
  tokenAddress: string,
  timeframe: Timeframe = 'hour',
  aggregate: Aggregation = 1,
  limit: number = 100
): Promise<Candle[]> {
  const data = await fetchApi<OHLCVResponse>(
    `/networks/${NETWORK}/tokens/${tokenAddress}/ohlcv/${timeframe}`,
    {
      aggregate: aggregate.toString(),
      limit: limit.toString(),
      currency: 'usd',
    }
  );

  return parseCandles(data.data?.attributes?.ohlcv_list || []);
}

// ============================================================================
// EXAMPLE 3: Get Historical OHLCV (with pagination)
// ============================================================================

async function getHistoricalOHLCV(
  poolAddress: string,
  timeframe: Timeframe,
  aggregate: Aggregation,
  beforeTimestamp: number,
  limit: number = 1000
): Promise<Candle[]> {
  const data = await fetchApi<OHLCVResponse>(
    `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`,
    {
      aggregate: aggregate.toString(),
      before_timestamp: beforeTimestamp.toString(),
      limit: limit.toString(),
      currency: 'usd',
    }
  );

  return parseCandles(data.data?.attributes?.ohlcv_list || []);
}

// ============================================================================
// EXAMPLE 4: Calculate Simple Moving Average
// ============================================================================

function calculateSMA(candles: Candle[], period: number): (number | null)[] {
  const result: (number | null)[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const sum = candles
        .slice(i - period + 1, i + 1)
        .reduce((acc, c) => acc + c.close, 0);
      result.push(sum / period);
    }
  }

  return result;
}

// ============================================================================
// EXAMPLE 5: Detect Price Trends
// ============================================================================

interface TrendAnalysis {
  currentPrice: number;
  sma20: number | null;
  sma50: number | null;
  trend: 'bullish' | 'bearish' | 'neutral';
  priceChange24h: number;
  volatility: number;
}

async function analyzeTrend(poolAddress: string): Promise<TrendAnalysis> {
  // Get hourly candles for analysis
  const candles = await getPoolOHLCV(poolAddress, 'hour', 1, 50);

  if (candles.length < 2) {
    throw new Error('Insufficient data for analysis');
  }

  const currentPrice = candles[candles.length - 1].close;
  const sma20Values = calculateSMA(candles, 20);
  const sma50Values = calculateSMA(candles, 50);

  const sma20 = sma20Values[sma20Values.length - 1];
  const sma50 = sma50Values[sma50Values.length - 1];

  // Calculate 24h price change
  const price24hAgo = candles.length >= 24 ? candles[candles.length - 24].close : candles[0].close;
  const priceChange24h = ((currentPrice - price24hAgo) / price24hAgo) * 100;

  // Calculate volatility (standard deviation of returns)
  const returns = candles.slice(1).map((c, i) => (c.close - candles[i].close) / candles[i].close);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance) * 100;

  // Determine trend
  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (sma20 && sma50) {
    if (currentPrice > sma20 && sma20 > sma50) {
      trend = 'bullish';
    } else if (currentPrice < sma20 && sma20 < sma50) {
      trend = 'bearish';
    }
  }

  return {
    currentPrice,
    sma20,
    sma50,
    trend,
    priceChange24h,
    volatility,
  };
}

// ============================================================================
// EXAMPLE 6: Format Candles for Charting
// ============================================================================

interface ChartData {
  labels: string[];
  datasets: {
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
  };
}

function formatForChart(candles: Candle[]): ChartData {
  return {
    labels: candles.map((c) =>
      c.date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    ),
    datasets: {
      open: candles.map((c) => c.open),
      high: candles.map((c) => c.high),
      low: candles.map((c) => c.low),
      close: candles.map((c) => c.close),
      volume: candles.map((c) => c.volume),
    },
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('CoinGecko OHLCV Chart Examples\n');
  console.log(`API Type: ${API_TYPE}`);
  console.log(`Network: ${NETWORK}\n`);

  // Example pool address (SOL/USDC on Raydium)
  const poolAddress = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

  try {
    // Example 1: Get hourly candles
    console.log('--- Example 1: Hourly Candles ---');
    const hourlyCandles = await getPoolOHLCV(poolAddress, 'hour', 1, 24);
    console.log(`Fetched ${hourlyCandles.length} hourly candles`);
    if (hourlyCandles.length > 0) {
      const latest = hourlyCandles[hourlyCandles.length - 1];
      console.log(`Latest: O:${latest.open.toFixed(4)} H:${latest.high.toFixed(4)} L:${latest.low.toFixed(4)} C:${latest.close.toFixed(4)}`);
      console.log(`Volume: $${latest.volume.toLocaleString()}\n`);
    }

    // Example 2: Get 5-minute candles
    console.log('--- Example 2: 5-Minute Candles ---');
    const fiveMinCandles = await getPoolOHLCV(poolAddress, 'minute', 5, 12);
    console.log(`Fetched ${fiveMinCandles.length} 5-minute candles`);
    fiveMinCandles.slice(-3).forEach((c) => {
      console.log(
        `${c.date.toLocaleTimeString()}: $${c.close.toFixed(4)} (Vol: $${c.volume.toLocaleString()})`
      );
    });
    console.log();

    // Example 3: Get daily candles
    console.log('--- Example 3: Daily Candles ---');
    const dailyCandles = await getPoolOHLCV(poolAddress, 'day', 1, 7);
    console.log(`Fetched ${dailyCandles.length} daily candles`);
    dailyCandles.forEach((c) => {
      console.log(
        `${c.date.toLocaleDateString()}: $${c.close.toFixed(4)} (Vol: $${c.volume.toLocaleString()})`
      );
    });
    console.log();

    // Example 4: Trend analysis
    console.log('--- Example 4: Trend Analysis ---');
    const analysis = await analyzeTrend(poolAddress);
    console.log(`Current Price: $${analysis.currentPrice.toFixed(4)}`);
    console.log(`SMA(20): $${analysis.sma20?.toFixed(4) ?? 'N/A'}`);
    console.log(`SMA(50): $${analysis.sma50?.toFixed(4) ?? 'N/A'}`);
    console.log(`Trend: ${analysis.trend.toUpperCase()}`);
    console.log(`24h Change: ${analysis.priceChange24h.toFixed(2)}%`);
    console.log(`Volatility: ${analysis.volatility.toFixed(2)}%\n`);

    // Example 5: Format for charting
    console.log('--- Example 5: Chart Data Format ---');
    const chartData = formatForChart(hourlyCandles.slice(-5));
    console.log('Labels:', chartData.labels);
    console.log('Close prices:', chartData.datasets.close.map((p) => p.toFixed(4)));
  } catch (error) {
    console.error('Error:', error);
  }
}

main().catch(console.error);
