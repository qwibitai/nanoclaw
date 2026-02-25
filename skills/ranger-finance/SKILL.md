---
name: ranger-finance
description: Ranger Finance SDK for building perpetual futures trading applications on Solana. The first Solana Perps Aggregator - aggregates liquidity across multiple perp protocols (Drift, Flash, Adrena, Jupiter). Use when integrating perps trading, smart order routing, position management, or building AI trading agents.
---

# Ranger Finance SDK Development Guide

A comprehensive guide for building Solana applications with Ranger Finance - the first perpetual futures aggregator on Solana.

## Overview

Ranger Finance is a Smart Order Router (SOR) that aggregates perpetual futures trading across multiple Solana protocols:

- **Drift Protocol**: Leading perps DEX on Solana
- **Flash Trade**: High-performance perpetuals
- **Adrena**: Leverage trading protocol
- **Jupiter Perps**: Jupiter's perpetuals platform

### Key Benefits

- **Best Execution**: Automatically routes orders to venues with best pricing
- **Unified API**: Single interface for all supported perp protocols
- **Position Aggregation**: View and manage positions across all venues
- **AI Agent Support**: Built-in MCP server for AI trading agents

## Quick Start

### Installation (TypeScript)

```bash
# Clone the SDK demo
git clone https://github.com/ranger-finance/sor-ts-demo.git
cd sor-ts-demo
npm install
```

### Environment Setup

Create a `.env` file:

```bash
RANGER_API_KEY=your_api_key_here
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
WALLET_PRIVATE_KEY=your_base58_private_key  # Optional, for signing
```

### Basic Setup

```typescript
import { SorApi, TradeSide } from 'ranger-sor-sdk';
import dotenv from 'dotenv';

dotenv.config();

// Initialize the SOR API client
const sorApi = new SorApi({
  apiKey: process.env.RANGER_API_KEY!,
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
});

// Your wallet public key
const walletAddress = 'YOUR_WALLET_PUBLIC_KEY';
```

## Core Concepts

### 1. Trade Sides

```typescript
type TradeSide = 'Long' | 'Short';
```

### 2. Adjustment Types

```typescript
type AdjustmentType =
  | 'Quote'           // Get a quote only
  | 'Increase'        // Open or increase position
  | 'DecreaseFlash'   // Decrease via Flash
  | 'DecreaseJupiter' // Decrease via Jupiter
  | 'DecreaseDrift'   // Decrease via Drift
  | 'DecreaseAdrena'  // Decrease via Adrena
  | 'CloseFlash'      // Close via Flash
  | 'CloseJupiter'    // Close via Jupiter
  | 'CloseDrift'      // Close via Drift
  | 'CloseAdrena'     // Close via Adrena
  | 'CloseAll';       // Close entire position
```

### 3. Position Interface

```typescript
interface Position {
  id: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  entry_price: number;
  liquidation_price: number;
  position_leverage: number;
  real_collateral: number;
  unrealized_pnl: number;
  borrow_fee: number;
  funding_fee: number;
  open_fee: number;
  close_fee: number;
  created_at: string;
  opened_at: string;
  platform: string;  // 'DRIFT', 'FLASH', 'ADRENA', 'JUPITER'
}
```

### 4. Quote Response

```typescript
interface Quote {
  base: number;
  fee: number;
  total: number;
  fee_breakdown: {
    base_fee: number;
    spread_fee: number;
    volatility_fee: number;
    margin_fee: number;
    close_fee: number;
    other_fees: number;
  };
}

interface VenueAllocation {
  venue_name: string;
  collateral: number;
  size: number;
  quote: Quote;
  order_available_liquidity: number;
  venue_available_liquidity: number;
}

interface OrderMetadataResponse {
  venues: VenueAllocation[];
  total_collateral: number;
  total_size: number;
}
```

## Trading Operations

### Get a Quote

Before executing a trade, get a quote to see pricing across venues:

```typescript
import { SorApi, OrderMetadataRequest, TradeSide } from 'ranger-sor-sdk';

const sorApi = new SorApi({ apiKey: process.env.RANGER_API_KEY! });

async function getQuote() {
  const request: OrderMetadataRequest = {
    fee_payer: walletAddress,
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    size: 1.0,                        // 1 SOL position size
    collateral: 10.0,                 // 10 USDC collateral (10x leverage)
    size_denomination: 'SOL',
    collateral_denomination: 'USDC',
    adjustment_type: 'Quote',
  };

  const quote = await sorApi.getOrderMetadata(request);

  console.log('Available venues:');
  quote.venues.forEach(venue => {
    console.log(`  ${venue.venue_name}: ${venue.quote.total} USDC`);
  });

  return quote;
}
```

### Open/Increase a Position

```typescript
async function openLongPosition() {
  const request = {
    fee_payer: walletAddress,
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    size: 1.0,
    collateral: 10.0,
    size_denomination: 'SOL',
    collateral_denomination: 'USDC',
    adjustment_type: 'Increase' as const,
  };

  // Get transaction instructions
  const response = await sorApi.increasePosition(request);

  console.log('Transaction message (base64):', response.message);

  if (response.meta) {
    console.log('Executed price:', response.meta.executed_price);
    console.log('Venues used:', response.meta.venues_used);
  }

  return response;
}

// Open a short position
async function openShortPosition() {
  const request = {
    fee_payer: walletAddress,
    symbol: 'ETH',
    side: 'Short' as TradeSide,
    size: 0.5,
    collateral: 100.0,
    size_denomination: 'ETH',
    collateral_denomination: 'USDC',
    adjustment_type: 'Increase' as const,
  };

  return await sorApi.increasePosition(request);
}
```

### Decrease a Position

```typescript
async function decreasePosition() {
  const request = {
    fee_payer: walletAddress,
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    size: 0.5,                        // Decrease by 0.5 SOL
    collateral: 5.0,                  // Withdraw 5 USDC collateral
    size_denomination: 'SOL',
    collateral_denomination: 'USDC',
    adjustment_type: 'DecreaseFlash' as const,  // Route through Flash
  };

  return await sorApi.decreasePosition(request);
}
```

### Close a Position

```typescript
// Close entire position on a specific venue
async function closePosition() {
  const request = {
    fee_payer: walletAddress,
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    adjustment_type: 'CloseFlash' as const,
  };

  return await sorApi.closePosition(request);
}

// Close all positions across all venues
async function closeAllPositions() {
  const request = {
    fee_payer: walletAddress,
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    adjustment_type: 'CloseAll' as const,
  };

  return await sorApi.closePosition(request);
}
```

### Sign and Execute Transaction

```typescript
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

async function executeTradeWithSigning() {
  // Get transaction instructions
  const txResponse = await sorApi.increasePosition({
    fee_payer: walletAddress,
    symbol: 'SOL',
    side: 'Long',
    size: 1.0,
    collateral: 10.0,
    size_denomination: 'SOL',
    collateral_denomination: 'USDC',
    adjustment_type: 'Increase',
  });

  // Create keypair from private key
  const privateKeyBytes = bs58.decode(process.env.WALLET_PRIVATE_KEY!);
  const keypair = Keypair.fromSecretKey(privateKeyBytes);

  // Define signing function
  const signTransaction = async (tx: VersionedTransaction) => {
    tx.sign([keypair]);
    return tx;
  };

  // Execute the transaction
  const result = await sorApi.executeTransaction(txResponse, signTransaction);

  console.log('Transaction signature:', result.signature);
  return result;
}
```

## Position Management

### Fetch All Positions

```typescript
async function getAllPositions() {
  const positions = await sorApi.getPositions(walletAddress);

  positions.positions.forEach(pos => {
    console.log(`${pos.symbol} ${pos.side}: ${pos.quantity} @ ${pos.entry_price}`);
    console.log(`  Platform: ${pos.platform}`);
    console.log(`  PnL: ${pos.unrealized_pnl}`);
    console.log(`  Liquidation: ${pos.liquidation_price}`);
  });

  return positions;
}
```

### Filter Positions by Platform

```typescript
async function getDriftPositions() {
  const positions = await sorApi.getPositions(walletAddress, {
    platforms: ['DRIFT'],
  });

  return positions;
}

async function getFlashAndAdrenaPositions() {
  const positions = await sorApi.getPositions(walletAddress, {
    platforms: ['FLASH', 'ADRENA'],
  });

  return positions;
}
```

### Filter Positions by Symbol

```typescript
async function getSolPositions() {
  const positions = await sorApi.getPositions(walletAddress, {
    symbols: ['SOL-PERP'],
  });

  return positions;
}
```

## AI Agent Integration

Ranger provides an MCP (Model Context Protocol) server for AI agent integration.

### Installation (Python)

```bash
pip install mcp-agent numpy
```

### MCP Server Tools

The Ranger MCP server exposes these tools:

**SOR Tools:**
- `sor_get_trade_quote` - Get pricing quotes
- `sor_increase_position` - Open/increase positions
- `sor_decrease_position` - Reduce positions
- `sor_close_position` - Close positions

**Data API Tools:**
- `data_get_positions` - Fetch current positions
- `data_get_trade_history` - Trading history
- `data_get_liquidations` - Liquidation data and signals
- `data_get_funding_rates` - Funding rate analytics

### Example: Mean Reversion Agent

```python
import asyncio
from ranger_mcp_agent.examples.mean_reversion_agent import run_mean_reversion_agent

async def main():
    # Run a mean reversion trading strategy
    await run_mean_reversion_agent()

if __name__ == "__main__":
    asyncio.run(main())
```

### Starting the MCP Server

```bash
cd ranger-agent-kit/perps-mcp
cp .env.example .env
# Edit .env with your API credentials
python -m ranger_mcp
```

## API Reference

### SorApi Class

```typescript
class SorApi {
  constructor(config: SorSdkConfig);

  // Get quote for a trade
  getOrderMetadata(request: OrderMetadataRequest): Promise<OrderMetadataResponse>;

  // Open or increase a position
  increasePosition(request: IncreasePositionRequest): Promise<TransactionResponse>;

  // Reduce a position
  decreasePosition(request: DecreasePositionRequest): Promise<TransactionResponse>;

  // Close a position
  closePosition(request: ClosePositionRequest): Promise<TransactionResponse>;

  // Get positions for a wallet
  getPositions(
    publicKey: string,
    options?: {
      platforms?: string[];
      symbols?: string[];
      startDate?: string;
      endDate?: string;
    }
  ): Promise<PositionsResponse>;

  // Execute a signed transaction
  executeTransaction(
    transactionResponse: TransactionResponse,
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
  ): Promise<{ signature: string }>;

  // Get Solana connection
  getConnection(): Connection;
}
```

### Configuration

```typescript
interface SorSdkConfig {
  apiKey: string;
  sorApiBaseUrl?: string;   // Default: Ranger SOR API
  dataApiBaseUrl?: string;  // Default: Ranger Data API
  solanaRpcUrl?: string;    // Default: Mainnet RPC
}
```

### Request Types

```typescript
interface BaseRequest {
  fee_payer: string;
  symbol: string;
  side: TradeSide;
  size_denomination?: string;
  collateral_denomination?: string;
}

interface IncreasePositionRequest extends BaseRequest {
  size: number;
  collateral: number;
  size_denomination: string;
  collateral_denomination: string;
  adjustment_type: 'Increase';
}

interface DecreasePositionRequest extends BaseRequest {
  size: number;
  collateral: number;
  size_denomination: string;
  collateral_denomination: string;
  adjustment_type: 'DecreaseFlash' | 'DecreaseJupiter' | 'DecreaseDrift' | 'DecreaseAdrena';
}

interface ClosePositionRequest extends BaseRequest {
  adjustment_type: 'CloseFlash' | 'CloseJupiter' | 'CloseDrift' | 'CloseAdrena' | 'CloseAll';
}
```

### Response Types

```typescript
interface TransactionResponse {
  message: string;  // Base64-encoded transaction
  meta?: {
    executed_price?: number;
    executed_size?: number;
    executed_collateral?: number;
    venues_used?: string[];
  };
}

interface PositionsResponse {
  positions: Position[];
}
```

## Supported Markets

Ranger aggregates perpetual markets across:

| Protocol | Markets |
|----------|---------|
| Drift | SOL, BTC, ETH, and 20+ assets |
| Flash | SOL, BTC, ETH |
| Adrena | SOL, BTC, ETH |
| Jupiter | SOL, BTC, ETH |

## Error Handling

```typescript
try {
  const response = await sorApi.increasePosition(request);
} catch (error) {
  if (error.error_code) {
    // API error
    console.error('API Error:', error.message);
    console.error('Error code:', error.error_code);
  } else {
    // Network or other error
    throw error;
  }
}
```

## Best Practices

1. **Always Get Quotes First**: Before executing trades, use `getOrderMetadata` to compare pricing across venues.

2. **Handle Transaction Signing Securely**: Never hardcode private keys. Use environment variables or secure key management.

3. **Monitor Positions**: Regularly fetch positions to track PnL and liquidation prices.

4. **Use Appropriate Venue**: When decreasing/closing, choose the venue where your position exists.

5. **Set Appropriate Collateral**: Consider leverage when setting collateral. Higher collateral = lower liquidation risk.

## Resources

- [Ranger Finance Website](https://ranger.finance)
- [TypeScript SDK (sor-ts-demo)](https://github.com/ranger-finance/sor-ts-demo)
- [AI Agent Kit](https://github.com/ranger-finance/ranger-agent-kit)
- [GitHub Organization](https://github.com/ranger-finance)

## Skill Structure

```
ranger-finance/
├── SKILL.md                           # This file
├── resources/
│   ├── api-reference.md               # API endpoint reference
│   └── types-reference.md             # Complete TypeScript types
├── examples/
│   ├── basic/
│   │   └── example.ts                 # Basic trade operations
│   ├── positions/
│   │   └── example.ts                 # Position queries and management
│   └── transactions/
│       └── example.ts                 # Transaction signing flow
├── templates/
│   └── setup.ts                       # Ready-to-use setup template
└── docs/
    ├── troubleshooting.md             # Common issues and solutions
    └── ai-agent-integration.md        # AI agent setup guide
```
