/**
 * Drift Protocol Trading Bot Template
 *
 * A complete template for building trading bots on Drift Protocol.
 * Customize the strategy in the `executeStrategy` function.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  DriftClient,
  DriftEnv,
  BulkAccountLoader,
  User,
  OrderType,
  PositionDirection,
  MarketType,
  PostOnlyParams,
  QUOTE_PRECISION,
  BASE_PRECISION,
  PRICE_PRECISION,
  MARGIN_PRECISION,
  convertToNumber,
  initialize,
  BN,
} from '@drift-labs/sdk';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // RPC Configuration
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  ENV: (process.env.DRIFT_ENV || 'mainnet-beta') as DriftEnv,

  // Trading Parameters
  MARKET_INDEX: 0, // SOL-PERP
  MAX_POSITION_SIZE: 10, // Max position in base units
  DEFAULT_ORDER_SIZE: 1, // Default order size in base units
  SPREAD_BPS: 10, // Spread in basis points (0.1%)

  // Risk Parameters
  MAX_LEVERAGE: 3, // Maximum leverage
  MIN_FREE_COLLATERAL: 100, // Minimum free collateral in USDC
  STOP_LOSS_PCT: 5, // Stop loss percentage

  // Bot Settings
  LOOP_INTERVAL_MS: 5000, // Main loop interval
  LOG_LEVEL: 'info', // 'debug' | 'info' | 'warn' | 'error'
};

// ============================================================================
// TYPES
// ============================================================================

interface BotState {
  isRunning: boolean;
  lastLoopTime: number;
  errorCount: number;
  totalTrades: number;
}

interface MarketData {
  oraclePrice: number;
  bidPrice: number;
  askPrice: number;
  marketIndex: number;
}

interface AccountData {
  freeCollateral: number;
  totalCollateral: number;
  leverage: number;
  health: number;
  perpPositionSize: number;
  unrealizedPnl: number;
}

// ============================================================================
// LOGGING
// ============================================================================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: keyof typeof LOG_LEVELS, message: string, data?: any) {
  if (LOG_LEVELS[level] >= LOG_LEVELS[CONFIG.LOG_LEVEL as keyof typeof LOG_LEVELS]) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    if (data) console.log(JSON.stringify(data, null, 2));
  }
}

// ============================================================================
// DRIFT CLIENT SETUP
// ============================================================================

async function setupDriftClient(): Promise<DriftClient> {
  log('info', 'Setting up Drift client...');

  // Load wallet
  const secretKey = JSON.parse(
    fs.readFileSync(process.env.KEYPAIR_PATH || './keypair.json', 'utf-8')
  );
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const wallet = new Wallet(keypair);

  log('info', `Wallet: ${wallet.publicKey.toString()}`);

  // Create connection
  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  // Initialize SDK
  initialize({ env: CONFIG.ENV });

  // Create account loader
  const accountLoader = new BulkAccountLoader(connection, 'confirmed', 1000);

  // Create DriftClient
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: CONFIG.ENV,
    accountSubscription: {
      type: 'polling',
      accountLoader,
    },
  });

  // Subscribe
  const success = await driftClient.subscribe();
  if (!success) {
    throw new Error('Failed to subscribe to DriftClient');
  }

  log('info', 'Drift client setup complete');
  return driftClient;
}

// ============================================================================
// DATA FETCHING
// ============================================================================

function getMarketData(driftClient: DriftClient): MarketData {
  const oracleData = driftClient.getOracleDataForPerpMarket(CONFIG.MARKET_INDEX);
  const oraclePrice = convertToNumber(oracleData.price, PRICE_PRECISION);

  // Simple bid/ask from oracle (in production, use DLOB)
  const halfSpread = oraclePrice * (CONFIG.SPREAD_BPS / 10000) / 2;
  const bidPrice = oraclePrice - halfSpread;
  const askPrice = oraclePrice + halfSpread;

  return {
    oraclePrice,
    bidPrice,
    askPrice,
    marketIndex: CONFIG.MARKET_INDEX,
  };
}

function getAccountData(user: User): AccountData {
  const freeCollateral = convertToNumber(user.getFreeCollateral(), QUOTE_PRECISION);
  const totalCollateral = convertToNumber(user.getTotalCollateral(), QUOTE_PRECISION);
  const leverage = convertToNumber(user.getLeverage(), MARGIN_PRECISION);
  const health = user.getHealth();

  const perpPosition = user.getPerpPosition(CONFIG.MARKET_INDEX);
  const perpPositionSize = perpPosition
    ? convertToNumber(perpPosition.baseAssetAmount, BASE_PRECISION)
    : 0;

  const unrealizedPnl = convertToNumber(
    user.getUnrealizedPNL(false, CONFIG.MARKET_INDEX),
    QUOTE_PRECISION
  );

  return {
    freeCollateral,
    totalCollateral,
    leverage,
    health,
    perpPositionSize,
    unrealizedPnl,
  };
}

// ============================================================================
// TRADING FUNCTIONS
// ============================================================================

async function placeOrder(
  driftClient: DriftClient,
  direction: PositionDirection,
  size: number,
  price?: number,
  postOnly: boolean = true
) {
  const orderParams: any = {
    orderType: price ? OrderType.LIMIT : OrderType.MARKET,
    marketIndex: CONFIG.MARKET_INDEX,
    direction,
    baseAssetAmount: driftClient.convertToPerpPrecision(size),
  };

  if (price) {
    orderParams.price = driftClient.convertToPricePrecision(price);
  }

  if (postOnly && price) {
    orderParams.postOnly = PostOnlyParams.TRY_POST_ONLY;
  }

  const txSig = await driftClient.placePerpOrder(orderParams);
  log('info', `Order placed: ${direction === PositionDirection.LONG ? 'BUY' : 'SELL'} ${size} @ ${price || 'MARKET'}`, { txSig });
  return txSig;
}

async function cancelAllOrders(driftClient: DriftClient) {
  await driftClient.cancelOrders(MarketType.PERP, CONFIG.MARKET_INDEX);
  log('info', 'Cancelled all orders');
}

// ============================================================================
// RISK MANAGEMENT
// ============================================================================

function checkRiskLimits(accountData: AccountData): { canTrade: boolean; reason?: string } {
  // Check minimum collateral
  if (accountData.freeCollateral < CONFIG.MIN_FREE_COLLATERAL) {
    return { canTrade: false, reason: 'Insufficient free collateral' };
  }

  // Check leverage
  if (accountData.leverage > CONFIG.MAX_LEVERAGE) {
    return { canTrade: false, reason: 'Max leverage exceeded' };
  }

  // Check position size
  if (Math.abs(accountData.perpPositionSize) >= CONFIG.MAX_POSITION_SIZE) {
    return { canTrade: false, reason: 'Max position size reached' };
  }

  // Check health
  if (accountData.health < 20) {
    return { canTrade: false, reason: 'Account health too low' };
  }

  return { canTrade: true };
}

// ============================================================================
// STRATEGY
// ============================================================================

/**
 * CUSTOMIZE YOUR STRATEGY HERE
 *
 * This is a simple example strategy that:
 * 1. Places bid/ask around oracle price
 * 2. Adjusts based on current position
 *
 * Replace with your own logic!
 */
async function executeStrategy(
  driftClient: DriftClient,
  user: User,
  marketData: MarketData,
  accountData: AccountData,
  state: BotState
): Promise<void> {
  log('debug', 'Executing strategy', { marketData, accountData });

  // Check risk limits
  const riskCheck = checkRiskLimits(accountData);
  if (!riskCheck.canTrade) {
    log('warn', `Risk limit hit: ${riskCheck.reason}`);
    return;
  }

  // Cancel existing orders
  await cancelAllOrders(driftClient);

  // Simple market making strategy
  const { oraclePrice } = marketData;
  const { perpPositionSize } = accountData;

  // Adjust spread based on position
  let bidSpreadBps = CONFIG.SPREAD_BPS;
  let askSpreadBps = CONFIG.SPREAD_BPS;

  if (perpPositionSize > 0) {
    // Long position - widen bid, tighten ask to reduce
    bidSpreadBps = CONFIG.SPREAD_BPS * 1.5;
    askSpreadBps = CONFIG.SPREAD_BPS * 0.5;
  } else if (perpPositionSize < 0) {
    // Short position - tighten bid, widen ask to reduce
    bidSpreadBps = CONFIG.SPREAD_BPS * 0.5;
    askSpreadBps = CONFIG.SPREAD_BPS * 1.5;
  }

  const bidPrice = oraclePrice * (1 - bidSpreadBps / 10000);
  const askPrice = oraclePrice * (1 + askSpreadBps / 10000);

  // Calculate order size (reduce near position limit)
  const remainingCapacity = CONFIG.MAX_POSITION_SIZE - Math.abs(perpPositionSize);
  const orderSize = Math.min(CONFIG.DEFAULT_ORDER_SIZE, remainingCapacity);

  if (orderSize <= 0) {
    log('info', 'No capacity for new orders');
    return;
  }

  // Place orders
  try {
    // Place bid
    if (perpPositionSize < CONFIG.MAX_POSITION_SIZE) {
      await placeOrder(driftClient, PositionDirection.LONG, orderSize, bidPrice);
    }

    // Place ask
    if (perpPositionSize > -CONFIG.MAX_POSITION_SIZE) {
      await placeOrder(driftClient, PositionDirection.SHORT, orderSize, askPrice);
    }

    state.totalTrades += 2;
  } catch (error: any) {
    log('error', 'Failed to place orders', { error: error.message });
    state.errorCount++;
  }
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function mainLoop(driftClient: DriftClient, state: BotState) {
  while (state.isRunning) {
    try {
      const loopStart = Date.now();

      // Fetch latest data
      await driftClient.fetchAccounts();
      const user = driftClient.getUser();
      const marketData = getMarketData(driftClient);
      const accountData = getAccountData(user);

      // Log status
      log('info', 'Status', {
        price: marketData.oraclePrice.toFixed(2),
        position: accountData.perpPositionSize.toFixed(4),
        pnl: accountData.unrealizedPnl.toFixed(2),
        health: accountData.health,
        leverage: accountData.leverage.toFixed(2),
      });

      // Execute strategy
      await executeStrategy(driftClient, user, marketData, accountData, state);

      // Calculate sleep time
      const elapsed = Date.now() - loopStart;
      const sleepTime = Math.max(0, CONFIG.LOOP_INTERVAL_MS - elapsed);

      state.lastLoopTime = Date.now();
      state.errorCount = 0; // Reset on success

      await sleep(sleepTime);
    } catch (error: any) {
      log('error', 'Main loop error', { error: error.message });
      state.errorCount++;

      // Back off on repeated errors
      if (state.errorCount > 5) {
        log('error', 'Too many errors, stopping bot');
        state.isRunning = false;
      }

      await sleep(CONFIG.LOOP_INTERVAL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// SHUTDOWN
// ============================================================================

async function shutdown(driftClient: DriftClient, state: BotState) {
  log('info', 'Shutting down...');
  state.isRunning = false;

  try {
    // Cancel all orders
    await cancelAllOrders(driftClient);

    // Unsubscribe
    await driftClient.unsubscribe();

    log('info', 'Shutdown complete', {
      totalTrades: state.totalTrades,
      errorCount: state.errorCount,
    });
  } catch (error: any) {
    log('error', 'Error during shutdown', { error: error.message });
  }

  process.exit(0);
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  log('info', '=== Drift Trading Bot Starting ===');
  log('info', 'Config', CONFIG);

  const state: BotState = {
    isRunning: true,
    lastLoopTime: 0,
    errorCount: 0,
    totalTrades: 0,
  };

  let driftClient: DriftClient | null = null;

  try {
    // Setup
    driftClient = await setupDriftClient();

    // Check user account
    const user = driftClient.getUser();
    const exists = await user.exists();
    if (!exists) {
      log('error', 'User account does not exist. Please initialize first.');
      process.exit(1);
    }

    // Handle shutdown signals
    process.on('SIGINT', () => shutdown(driftClient!, state));
    process.on('SIGTERM', () => shutdown(driftClient!, state));

    // Start main loop
    log('info', '=== Bot Running ===');
    await mainLoop(driftClient, state);
  } catch (error: any) {
    log('error', 'Fatal error', { error: error.message });
    if (driftClient) {
      await driftClient.unsubscribe();
    }
    process.exit(1);
  }
}

main();
