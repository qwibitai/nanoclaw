# Drift Protocol Precision Constants

All numerical values in Drift use BigNumber (BN.js) with designated precision levels for conversion.

## Precision Exponents

| Constant | Value | Description |
|----------|-------|-------------|
| `QUOTE_PRECISION_EXP` | 6 | Quote asset (USDC) exponent |
| `BASE_PRECISION_EXP` | 9 | Perp base asset exponent |
| `PRICE_PRECISION_EXP` | 6 | Price exponent |
| `PERCENTAGE_PRECISION_EXP` | 6 | Percentage exponent |
| `FUNDING_RATE_PRECISION_EXP` | 9 | Funding rate exponent |
| `FUNDING_RATE_BUFFER_PRECISION_EXP` | 3 | Funding buffer exponent |
| `PEG_PRECISION_EXP` | 6 | AMM peg exponent |
| `AMM_RESERVE_PRECISION_EXP` | 9 | AMM reserve exponent |
| `SPOT_MARKET_RATE_PRECISION_EXP` | 6 | Spot market rate exponent |
| `SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION_EXP` | 10 | Interest precision exponent |
| `SPOT_MARKET_UTILIZATION_PRECISION_EXP` | 6 | Utilization exponent |
| `SPOT_MARKET_BALANCE_PRECISION_EXP` | 9 | Spot balance exponent |
| `SPOT_MARKET_IMF_PRECISION_EXP` | 6 | IMF exponent |

## Precision Values (BN)

| Constant | Value | Use Case |
|----------|-------|----------|
| `QUOTE_PRECISION` | 10^6 (1,000,000) | USDC amounts, PnL |
| `BASE_PRECISION` | 10^9 (1,000,000,000) | Perp position sizes |
| `PRICE_PRECISION` | 10^6 (1,000,000) | All prices |
| `PERCENTAGE_PRECISION` | 10^6 (1,000,000) | Percentages |
| `FUNDING_RATE_PRECISION` | 10^9 (1,000,000,000) | Funding rates |
| `FUNDING_RATE_BUFFER_PRECISION` | 10^3 (1,000) | Funding buffer |
| `PEG_PRECISION` | 10^6 (1,000,000) | AMM peg multiplier |
| `AMM_RESERVE_PRECISION` | 10^9 (1,000,000,000) | AMM reserves |
| `SPOT_MARKET_WEIGHT_PRECISION` | 10,000 | Asset/liability weights |
| `SPOT_MARKET_BALANCE_PRECISION` | 10^9 (1,000,000,000) | Spot balances |
| `LIQUIDATION_FEE_PRECISION` | 1,000,000 | Liquidation fees |
| `MARGIN_PRECISION` | 10,000 | Margin ratios |
| `LAMPORTS_PRECISION` | 10^9 (1,000,000,000) | SOL lamports |

## Numeric Constants

| Constant | Value |
|----------|-------|
| `ZERO` | BN(0) |
| `ONE` | BN(1) |
| `TWO` | BN(2) |
| `THREE` | BN(3) |
| `FOUR` | BN(4) |
| `FIVE` | BN(5) |
| `SIX` | BN(6) |
| `SEVEN` | BN(7) |
| `EIGHT` | BN(8) |
| `NINE` | BN(9) |
| `TEN` | BN(10) |

## Other Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_LEVERAGE` | 5 | Default max leverage |
| `FUEL_WINDOW` | 2,419,200 | Fuel window in seconds (28 days) |
| `ACCOUNT_AGE_DELETION_CUTOFF_SECONDS` | 1,123,200 | Account deletion cutoff (13 days) |
| `MAX_I64` | 9,223,372,036,854,775,807 | Maximum i64 |
| `MIN_I64` | -9,223,372,036,854,775,808 | Minimum i64 |

## Conversion Examples

```typescript
import {
  BN,
  QUOTE_PRECISION,
  BASE_PRECISION,
  PRICE_PRECISION,
  convertToNumber
} from '@drift-labs/sdk';

// Convert human-readable to BN
const usdcAmount = new BN(100).mul(QUOTE_PRECISION);    // 100 USDC
const baseAmount = new BN(1).mul(BASE_PRECISION);       // 1 base unit
const price = new BN(150).mul(PRICE_PRECISION);         // $150

// Convert BN to human-readable
const humanUsdc = convertToNumber(usdcAmount, QUOTE_PRECISION);   // 100
const humanBase = convertToNumber(baseAmount, BASE_PRECISION);     // 1
const humanPrice = convertToNumber(price, PRICE_PRECISION);        // 150

// Using DriftClient helpers
const perpPrecision = driftClient.convertToPerpPrecision(1);      // 1 perp unit
const spotPrecision = driftClient.convertToSpotPrecision(0, 100); // 100 USDC
const pricePrecision = driftClient.convertToPricePrecision(150);  // $150

// Division with precision (use convertToNumber to avoid floor)
const ratio = convertToNumber(new BN(10500), new BN(1000)); // 10.5 (not 10)
```

## Market-Specific Decimals

Spot markets have varying decimals based on the underlying token:

| Market | Token | Decimals | Precision |
|--------|-------|----------|-----------|
| 0 | USDC | 6 | 10^6 |
| 1 | SOL | 9 | 10^9 |
| 2 | mSOL | 9 | 10^9 |
| 3 | wBTC | 8 | 10^8 |
| 4 | wETH | 8 | 10^8 |

Always use `driftClient.convertToSpotPrecision(marketIndex, amount)` for correct conversion.
