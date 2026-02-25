# Ranger Finance TypeScript Types Reference

Complete type definitions for the Ranger SOR SDK.

## Trade Types

### TradeSide

```typescript
type TradeSide = 'Long' | 'Short';
```

### AdjustmentType

```typescript
type AdjustmentType =
  | 'Quote'           // Get a quote only, no transaction
  | 'Increase'        // Open or add to a position
  | 'DecreaseFlash'   // Reduce position via Flash Trade
  | 'DecreaseJupiter' // Reduce position via Jupiter Perps
  | 'DecreaseDrift'   // Reduce position via Drift Protocol
  | 'DecreaseAdrena'  // Reduce position via Adrena
  | 'CloseFlash'      // Close position via Flash Trade
  | 'CloseJupiter'    // Close position via Jupiter Perps
  | 'CloseDrift'      // Close position via Drift Protocol
  | 'CloseAdrena'     // Close position via Adrena
  | 'CloseAll';       // Close position across all venues
```

## Request Interfaces

### BaseRequest

```typescript
interface BaseRequest {
  fee_payer: string;              // Wallet public key
  symbol: string;                 // Trading pair (e.g., 'SOL', 'ETH', 'BTC')
  side: TradeSide;                // 'Long' or 'Short'
  size_denomination?: string;     // Unit for size (e.g., 'SOL')
  collateral_denomination?: string; // Unit for collateral (e.g., 'USDC')
}
```

### OrderMetadataRequest

Used for getting quotes:

```typescript
interface OrderMetadataRequest extends BaseRequest {
  size: number;                   // Position size in size_denomination
  collateral: number;             // Collateral amount in collateral_denomination
  size_denomination: string;
  collateral_denomination: string;
  adjustment_type: AdjustmentType;
}
```

### IncreasePositionRequest

Used for opening or adding to positions:

```typescript
interface IncreasePositionRequest extends BaseRequest {
  size: number;
  collateral: number;
  size_denomination: string;
  collateral_denomination: string;
  adjustment_type: 'Increase';
}
```

### DecreasePositionRequest

Used for reducing position size:

```typescript
interface DecreasePositionRequest extends BaseRequest {
  size: number;                   // Amount to reduce
  collateral: number;             // Collateral to withdraw
  size_denomination: string;
  collateral_denomination: string;
  adjustment_type: 'DecreaseFlash' | 'DecreaseJupiter' | 'DecreaseDrift' | 'DecreaseAdrena';
}
```

### ClosePositionRequest

Used for closing positions:

```typescript
interface ClosePositionRequest extends BaseRequest {
  adjustment_type: 'CloseFlash' | 'CloseJupiter' | 'CloseDrift' | 'CloseAdrena' | 'CloseAll';
}
```

## Response Interfaces

### Quote

```typescript
interface Quote {
  base: number;           // Base cost before fees
  fee: number;            // Total fee amount
  total: number;          // Total cost (base + fee)
  fee_breakdown: FeeBreakdown;
}
```

### FeeBreakdown

```typescript
interface FeeBreakdown {
  base_fee: number;       // Platform base fee
  spread_fee: number;     // Bid/ask spread cost
  volatility_fee: number; // Dynamic volatility fee
  margin_fee: number;     // Margin/borrowing fee
  close_fee: number;      // Position closing fee
  other_fees: number;     // Any additional fees
}
```

### VenueAllocation

```typescript
interface VenueAllocation {
  venue_name: string;              // 'DRIFT', 'FLASH', 'ADRENA', 'JUPITER'
  collateral: number;              // Allocated collateral
  size: number;                    // Allocated size
  quote: Quote;                    // Quote for this allocation
  order_available_liquidity: number;  // Liquidity for this order
  venue_available_liquidity: number;  // Total venue liquidity
}
```

### OrderMetadataResponse

```typescript
interface OrderMetadataResponse {
  venues: VenueAllocation[];  // Allocations across venues
  total_collateral: number;   // Sum of all collateral
  total_size: number;         // Sum of all size
}
```

### TransactionResponse

```typescript
interface TransactionResponse {
  message: string;            // Base64-encoded Solana transaction
  meta?: TransactionMeta;     // Optional execution metadata
}
```

### TransactionMeta

```typescript
interface TransactionMeta {
  executed_price?: number;       // Actual execution price
  executed_size?: number;        // Actual executed size
  executed_collateral?: number;  // Actual collateral used
  venues_used?: string[];        // Venues that filled the order
}
```

### Position

```typescript
interface Position {
  id: string;                  // Unique position identifier
  symbol: string;              // Trading pair
  side: TradeSide;             // 'Long' or 'Short'
  quantity: number;            // Position size
  entry_price: number;         // Average entry price
  liquidation_price: number;   // Liquidation trigger price
  position_leverage: number;   // Current leverage
  real_collateral: number;     // Deposited collateral
  unrealized_pnl: number;      // Current unrealized PnL
  borrow_fee: number;          // Accumulated borrow fees
  funding_fee: number;         // Accumulated funding fees
  open_fee: number;            // Fee paid on open
  close_fee: number;           // Estimated close fee
  created_at: string;          // ISO timestamp
  opened_at: string;           // ISO timestamp
  platform: string;            // 'DRIFT', 'FLASH', 'ADRENA', 'JUPITER'
}
```

### PositionsResponse

```typescript
interface PositionsResponse {
  positions: Position[];
}
```

### ApiError

```typescript
interface ApiError {
  message: string;      // Error description
  error_code: number;   // Numeric error code
}
```

## Configuration

### SorSdkConfig

```typescript
interface SorSdkConfig {
  apiKey: string;             // Required: Your Ranger API key
  sorApiBaseUrl?: string;     // Optional: Custom SOR API URL
  dataApiBaseUrl?: string;    // Optional: Custom Data API URL
  solanaRpcUrl?: string;      // Optional: Custom Solana RPC URL
}
```

## Usage Examples

### Creating a Quote Request

```typescript
const request: OrderMetadataRequest = {
  fee_payer: 'YOUR_WALLET_ADDRESS',
  symbol: 'SOL',
  side: 'Long',
  size: 1.0,
  collateral: 10.0,
  size_denomination: 'SOL',
  collateral_denomination: 'USDC',
  adjustment_type: 'Quote',
};
```

### Processing Quote Response

```typescript
const quote = await sorApi.getOrderMetadata(request);

// Find best venue by total cost
const bestVenue = quote.venues.reduce((best, current) =>
  current.quote.total < best.quote.total ? current : best
);

console.log(`Best venue: ${bestVenue.venue_name}`);
console.log(`Total cost: ${bestVenue.quote.total} USDC`);
```

### Working with Positions

```typescript
const positions = await sorApi.getPositions(walletAddress);

// Calculate total exposure
const totalExposure = positions.positions.reduce((sum, pos) => {
  const notional = pos.quantity * pos.entry_price;
  return sum + notional;
}, 0);

// Find profitable positions
const profitable = positions.positions.filter(pos => pos.unrealized_pnl > 0);
```
