/**
 * Position Management Example for Ranger Finance SOR
 *
 * Demonstrates how to fetch, filter, and manage positions
 * across multiple perpetual protocols.
 */
import { SorApi, Position, TradeSide } from 'ranger-sor-sdk';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.RANGER_API_KEY!;
const WALLET_PUBLIC_KEY = process.env.WALLET_PUBLIC_KEY!;

const sorApi = new SorApi({
  apiKey: API_KEY,
});

/**
 * Fetch all positions for a wallet
 */
async function getAllPositions() {
  console.log('Fetching all positions...\n');

  const response = await sorApi.getPositions(WALLET_PUBLIC_KEY);

  if (response.positions.length === 0) {
    console.log('No open positions found.');
    return response;
  }

  console.log(`Found ${response.positions.length} positions:\n`);

  response.positions.forEach((pos, index) => {
    printPosition(pos, index + 1);
  });

  return response;
}

/**
 * Fetch positions from specific platforms
 */
async function getPositionsByPlatform(platforms: string[]) {
  console.log(`\nFetching positions from: ${platforms.join(', ')}...\n`);

  const response = await sorApi.getPositions(WALLET_PUBLIC_KEY, {
    platforms,
  });

  if (response.positions.length === 0) {
    console.log('No positions found on specified platforms.');
    return response;
  }

  response.positions.forEach((pos, index) => {
    printPosition(pos, index + 1);
  });

  return response;
}

/**
 * Fetch positions for specific symbols
 */
async function getPositionsBySymbol(symbols: string[]) {
  console.log(`\nFetching positions for: ${symbols.join(', ')}...\n`);

  const response = await sorApi.getPositions(WALLET_PUBLIC_KEY, {
    symbols,
  });

  if (response.positions.length === 0) {
    console.log('No positions found for specified symbols.');
    return response;
  }

  response.positions.forEach((pos, index) => {
    printPosition(pos, index + 1);
  });

  return response;
}

/**
 * Calculate total PnL across all positions
 */
async function calculateTotalPnL() {
  console.log('\nCalculating total PnL...\n');

  const response = await sorApi.getPositions(WALLET_PUBLIC_KEY);

  let totalPnL = 0;
  let totalCollateral = 0;

  response.positions.forEach((pos) => {
    totalPnL += pos.unrealized_pnl;
    totalCollateral += pos.real_collateral;
  });

  console.log('Portfolio Summary:');
  console.log('==================');
  console.log(`Total Positions: ${response.positions.length}`);
  console.log(`Total Collateral: $${totalCollateral.toFixed(2)}`);
  console.log(`Total Unrealized PnL: $${totalPnL.toFixed(2)}`);
  console.log(`PnL %: ${((totalPnL / totalCollateral) * 100).toFixed(2)}%`);

  return { totalPnL, totalCollateral, positions: response.positions };
}

/**
 * Find positions at risk of liquidation
 */
async function findRiskyPositions(threshold: number = 0.1) {
  console.log(`\nFinding positions within ${threshold * 100}% of liquidation...\n`);

  const response = await sorApi.getPositions(WALLET_PUBLIC_KEY);

  const riskyPositions = response.positions.filter((pos) => {
    const currentPrice = pos.entry_price; // Simplified - use oracle price in production
    const distanceToLiq = Math.abs(pos.liquidation_price - currentPrice) / currentPrice;
    return distanceToLiq < threshold;
  });

  if (riskyPositions.length === 0) {
    console.log('No positions at risk of liquidation.');
    return [];
  }

  console.log(`Found ${riskyPositions.length} risky positions:`);
  riskyPositions.forEach((pos, index) => {
    printPosition(pos, index + 1);
  });

  return riskyPositions;
}

/**
 * Decrease a specific position
 */
async function decreasePosition(
  symbol: string,
  side: TradeSide,
  decreaseSize: number,
  withdrawCollateral: number
) {
  console.log(`\nDecreasing ${symbol} ${side} position...\n`);

  const request = {
    fee_payer: WALLET_PUBLIC_KEY,
    symbol,
    side,
    size: decreaseSize,
    collateral: withdrawCollateral,
    size_denomination: symbol.replace('-PERP', ''),
    collateral_denomination: 'USDC',
    adjustment_type: 'DecreaseFlash' as const,
  };

  const response = await sorApi.decreasePosition(request);

  console.log('Decrease transaction prepared!');
  console.log('Transaction message ready for signing.');

  return response;
}

/**
 * Close all positions for a symbol
 */
async function closeAllPositionsForSymbol(symbol: string) {
  console.log(`\nClosing all ${symbol} positions...\n`);

  // Close long positions
  try {
    const longClose = await sorApi.closePosition({
      fee_payer: WALLET_PUBLIC_KEY,
      symbol,
      side: 'Long' as TradeSide,
      adjustment_type: 'CloseAll',
    });
    console.log('Long close transaction prepared.');
  } catch (e) {
    console.log('No long positions to close.');
  }

  // Close short positions
  try {
    const shortClose = await sorApi.closePosition({
      fee_payer: WALLET_PUBLIC_KEY,
      symbol,
      side: 'Short' as TradeSide,
      adjustment_type: 'CloseAll',
    });
    console.log('Short close transaction prepared.');
  } catch (e) {
    console.log('No short positions to close.');
  }
}

/**
 * Helper function to print position details
 */
function printPosition(pos: Position, index: number) {
  console.log(`Position #${index}:`);
  console.log(`  Symbol: ${pos.symbol}`);
  console.log(`  Side: ${pos.side}`);
  console.log(`  Size: ${pos.quantity}`);
  console.log(`  Entry Price: $${pos.entry_price.toFixed(2)}`);
  console.log(`  Liquidation Price: $${pos.liquidation_price.toFixed(2)}`);
  console.log(`  Leverage: ${pos.position_leverage.toFixed(1)}x`);
  console.log(`  Collateral: $${pos.real_collateral.toFixed(2)}`);
  console.log(`  Unrealized PnL: $${pos.unrealized_pnl.toFixed(2)}`);
  console.log(`  Platform: ${pos.platform}`);
  console.log(`  Fees:`);
  console.log(`    - Borrow: $${pos.borrow_fee.toFixed(4)}`);
  console.log(`    - Funding: $${pos.funding_fee.toFixed(4)}`);
  console.log('');
}

/**
 * Main function to run examples
 */
async function main() {
  try {
    // Fetch all positions
    await getAllPositions();

    // Fetch positions by platform
    await getPositionsByPlatform(['DRIFT', 'FLASH']);

    // Fetch positions by symbol
    await getPositionsBySymbol(['SOL-PERP']);

    // Calculate total PnL
    await calculateTotalPnL();

    // Find risky positions
    await findRiskyPositions(0.15);

    console.log('\nExamples completed successfully!');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
