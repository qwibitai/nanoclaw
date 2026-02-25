# DFlow GitHub Tools & SDKs

Comprehensive documentation for DFlow's open-source tools available on GitHub.

**Organization:** [github.com/DFlowProtocol](https://github.com/DFlowProtocol)

---

## Core Libraries

### solana-agent-kit

**Repository:** [DFlowProtocol/solana-agent-kit](https://github.com/DFlowProtocol/solana-agent-kit)
**Language:** TypeScript
**License:** Apache-2.0

A toolkit enabling AI agents to connect to Solana protocols, including DFlow trading infrastructure.

#### Installation

```bash
npm install @dflow/solana-agent-kit
# or
yarn add @dflow/solana-agent-kit
```

#### Key Features

- AI agent integration with Solana protocols
- DFlow swap execution capabilities
- Prediction market trading support
- Wallet management for agents
- Transaction building and signing

#### Usage Example

```typescript
import { SolanaAgentKit } from "@dflow/solana-agent-kit";
import { Connection, Keypair } from "@solana/web3.js";

// Initialize the agent kit
const agentKit = new SolanaAgentKit({
  rpcUrl: process.env.SOLANA_RPC_URL,
  privateKey: process.env.AGENT_PRIVATE_KEY,
});

// Execute a swap through DFlow
async function executeAgentSwap() {
  const result = await agentKit.swap({
    inputMint: "So11111111111111111111111111111111111111112", // SOL
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    amount: 1_000_000_000, // 1 SOL
    slippageBps: 50,
  });

  console.log("Swap executed:", result.signature);
}

// Query prediction markets
async function queryPredictionMarkets() {
  const markets = await agentKit.getPredictionMarkets({
    category: "politics",
    status: "active",
  });

  for (const market of markets) {
    console.log(`${market.ticker}: ${market.yes_price}`);
  }
}

// Trade prediction market outcomes
async function tradeOutcome() {
  const result = await agentKit.tradePredictionMarket({
    marketTicker: "TRUMP-2024-WIN",
    outcome: "yes",
    amount: 100_000_000, // 100 USDC
    slippageBps: 100,
  });

  console.log("Trade executed:", result.signature);
}
```

#### Agent Capabilities

| Capability | Description |
|------------|-------------|
| `swap` | Execute token swaps via DFlow |
| `getQuote` | Get swap quotes |
| `getPredictionMarkets` | Query prediction markets |
| `tradePredictionMarket` | Trade outcome tokens |
| `getBalance` | Check token balances |
| `transfer` | Transfer tokens |

---

### clearpools

**Repository:** [DFlowProtocol/clearpools](https://github.com/DFlowProtocol/clearpools)
**Language:** TypeScript
**Description:** Orca Whirlpools with support for flow segmentation

#### Overview

ClearPools extends Orca's Whirlpool protocol with DFlow's routing capabilities, enabling:
- Flow segmentation for order flow routing
- Integration with DFlow's aggregation layer
- Enhanced liquidity provision strategies

#### Installation

```bash
npm install @dflow/clearpools
```

#### Usage Example

```typescript
import { ClearPoolsClient } from "@dflow/clearpools";
import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection(process.env.SOLANA_RPC_URL);

const client = new ClearPoolsClient({
  connection,
  programId: new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"),
});

// Initialize a pool with flow segmentation
async function initializePool() {
  const pool = await client.initializePool({
    tokenMintA: new PublicKey("So11..."),
    tokenMintB: new PublicKey("EPjF..."),
    tickSpacing: 64,
    initialPrice: 150.0,
    flowSegmentation: {
      enabled: true,
      segments: ["retail", "institutional"],
    },
  });

  return pool;
}

// Add liquidity with flow preferences
async function addLiquidity(poolAddress: PublicKey) {
  const position = await client.openPosition({
    pool: poolAddress,
    tickLowerIndex: -1000,
    tickUpperIndex: 1000,
    liquidityAmount: 1_000_000_000n,
    flowPreference: "retail", // Accept retail flow
  });

  return position;
}

// Get pool stats including flow metrics
async function getPoolStats(poolAddress: PublicKey) {
  const stats = await client.getPoolStats(poolAddress);

  console.log("TVL:", stats.tvl);
  console.log("Volume 24h:", stats.volume24h);
  console.log("Flow breakdown:", stats.flowBreakdown);
}
```

#### Key Concepts

**Flow Segmentation:**
- Separates order flow by source (retail, institutional, etc.)
- Enables targeted liquidity provision
- Reduces adverse selection for LPs

**Integration with DFlow:**
- ClearPools pools are routed through DFlow's aggregator
- LP positions can specify flow preferences
- Enhanced MEV protection through flow segmentation

---

### dflow-amm-interface

**Repository:** [DFlowProtocol/dflow-amm-interface](https://github.com/DFlowProtocol/dflow-amm-interface)
**Language:** Rust
**Description:** Trait definitions for DFlow's AMM implementation

#### Overview

Rust trait definitions for building custom AMMs that integrate with DFlow's routing and aggregation layer.

#### Installation

```toml
# Cargo.toml
[dependencies]
dflow-amm-interface = { git = "https://github.com/DFlowProtocol/dflow-amm-interface" }
```

#### Traits

```rust
use dflow_amm_interface::{Amm, Quote, SwapParams};

/// Core AMM trait for DFlow integration
pub trait Amm {
    /// Get a quote for a swap
    fn quote(&self, params: &QuoteParams) -> Result<Quote, AmmError>;

    /// Execute a swap
    fn swap(&self, params: &SwapParams) -> Result<SwapResult, AmmError>;

    /// Get current reserves
    fn get_reserves(&self) -> Result<Reserves, AmmError>;

    /// Calculate price impact
    fn price_impact(&self, amount: u64, direction: SwapDirection) -> Result<f64, AmmError>;
}

/// Routable AMM trait for aggregator integration
pub trait RoutableAmm: Amm {
    /// Get the AMM's identifier for routing
    fn venue_id(&self) -> VenueId;

    /// Check if the AMM supports a token pair
    fn supports_pair(&self, mint_a: &Pubkey, mint_b: &Pubkey) -> bool;

    /// Get routing metadata
    fn routing_metadata(&self) -> RoutingMetadata;
}

/// Flow-aware AMM trait
pub trait FlowAwareAmm: RoutableAmm {
    /// Set flow segmentation preferences
    fn set_flow_preferences(&mut self, preferences: FlowPreferences);

    /// Get flow metrics
    fn get_flow_metrics(&self) -> FlowMetrics;
}
```

#### Building a Custom AMM

```rust
use dflow_amm_interface::*;
use solana_program::pubkey::Pubkey;

pub struct MyCustomAmm {
    pool_address: Pubkey,
    reserves: Reserves,
    fee_bps: u16,
}

impl Amm for MyCustomAmm {
    fn quote(&self, params: &QuoteParams) -> Result<Quote, AmmError> {
        // Calculate output amount using constant product formula
        let output = calculate_output(
            params.input_amount,
            self.reserves.a,
            self.reserves.b,
            self.fee_bps,
        );

        Ok(Quote {
            input_amount: params.input_amount,
            output_amount: output,
            price_impact: self.price_impact(params.input_amount, params.direction)?,
            fee_amount: calculate_fee(params.input_amount, self.fee_bps),
        })
    }

    fn swap(&self, params: &SwapParams) -> Result<SwapResult, AmmError> {
        // Implement swap logic
        // ...
    }

    fn get_reserves(&self) -> Result<Reserves, AmmError> {
        Ok(self.reserves.clone())
    }

    fn price_impact(&self, amount: u64, direction: SwapDirection) -> Result<f64, AmmError> {
        // Calculate price impact
        // ...
    }
}

impl RoutableAmm for MyCustomAmm {
    fn venue_id(&self) -> VenueId {
        VenueId::Custom("my-custom-amm")
    }

    fn supports_pair(&self, mint_a: &Pubkey, mint_b: &Pubkey) -> bool {
        // Check if pool supports this pair
        true
    }

    fn routing_metadata(&self) -> RoutingMetadata {
        RoutingMetadata {
            priority: 100,
            gas_estimate: 200_000,
            supports_split_routes: true,
        }
    }
}
```

---

## Infrastructure Tools

### solana-accountsdb-plugin-bigtable

**Repository:** [DFlowProtocol/solana-accountsdb-plugin-bigtable](https://github.com/DFlowProtocol/solana-accountsdb-plugin-bigtable)
**Language:** Rust
**Fork of:** Solana Labs original

Enables AccountsDb plugin integration with Google Bigtable for Solana state management.

#### Use Cases

- Historical account state storage
- High-performance account lookups
- Analytics and data pipelines
- Archive node infrastructure

#### Configuration

```json
{
  "libpath": "/path/to/libsolana_accountsdb_plugin_bigtable.so",
  "bigtable_project_id": "your-gcp-project",
  "bigtable_instance_id": "solana-accounts",
  "bigtable_table_id": "accounts"
}
```

---

### solana-bigtable-connection

**Repository:** [DFlowProtocol/solana-bigtable-connection](https://github.com/DFlowProtocol/solana-bigtable-connection)
**Language:** Rust
**License:** Apache-2.0

Generic Bigtable connection library for Rust applications needing Solana data access.

#### Usage

```rust
use solana_bigtable_connection::BigtableConnection;

let connection = BigtableConnection::new(
    "your-project-id",
    "your-instance-id",
).await?;

// Read account data
let account = connection.get_account(&pubkey).await?;

// Read transaction
let tx = connection.get_transaction(&signature).await?;

// Read block
let block = connection.get_block(slot).await?;
```

---

### solana-bigtable-geyser-models

**Repository:** [DFlowProtocol/solana-bigtable-geyser-models](https://github.com/DFlowProtocol/solana-bigtable-geyser-models)
**Language:** Rust
**License:** Apache-2.0

Object models stored in Bigtable via the Geyser plugin for reading/writing operations.

#### Models

```rust
use solana_bigtable_geyser_models::{
    AccountUpdate,
    TransactionInfo,
    BlockMeta,
    SlotStatus,
};

// Account update model
let account_update = AccountUpdate {
    pubkey: account_key,
    lamports: 1_000_000,
    owner: program_id,
    executable: false,
    rent_epoch: 0,
    data: account_data,
    slot: current_slot,
    write_version: 1,
};

// Transaction info model
let tx_info = TransactionInfo {
    signature,
    slot,
    is_vote: false,
    message: tx_message,
    meta: tx_meta,
};
```

---

## wallet-app

**Repository:** [DFlowProtocol/wallet-app](https://github.com/DFlowProtocol/wallet-app)
**Language:** TypeScript
**License:** Apache-2.0
**Fork of:** Helium wallet

A wallet application interface with DFlow integration.

---

## Quick Reference

| Repository | Language | Purpose |
|------------|----------|---------|
| solana-agent-kit | TypeScript | AI agent toolkit for Solana/DFlow |
| clearpools | TypeScript | Orca Whirlpools with flow segmentation |
| dflow-amm-interface | Rust | AMM trait definitions for DFlow |
| solana-accountsdb-plugin-bigtable | Rust | Bigtable AccountsDb plugin |
| solana-bigtable-connection | Rust | Bigtable connection library |
| solana-bigtable-geyser-models | Rust | Geyser data models |
| wallet-app | TypeScript | Wallet interface |

---

## Contributing

All DFlow repositories accept contributions. See individual repository README files for contribution guidelines.

**General process:**
1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request

**Contact:** hello@dflow.net
