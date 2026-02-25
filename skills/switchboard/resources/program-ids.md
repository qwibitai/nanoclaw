# Switchboard Program IDs and Addresses

Complete reference of all Switchboard program addresses, queues, and network configurations.

## Program IDs

### Mainnet Programs

| Program | Address | Description |
|---------|---------|-------------|
| Oracle Program | `SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f` | Core oracle program |
| Quote Program | `orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz` | Oracle quote verification |
| Attestation Program | `SbatTiBAVNQSudT7DJ8dCTBhXEvmtSsNmxxpwCDcmLE` | TEE attestation |

### Devnet Programs

| Program | Address | Description |
|---------|---------|-------------|
| Oracle Program | `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2` | Core oracle program (devnet) |

## Queue Addresses

Queues manage oracle networks and feed configurations.

### Mainnet Queue

| Property | Value |
|----------|-------|
| Address | `A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w` |
| Network | Mainnet-beta |
| Min Stake | Variable |

### Devnet Queue

| Property | Value |
|----------|-------|
| Address | `EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7` |
| Network | Devnet |
| Min Stake | 0 (testing) |

## SDK Constants

### TypeScript

```typescript
import {
  ON_DEMAND_MAINNET_PID,
  ON_DEMAND_DEVNET_PID,
  MAINNET_GENESIS_HASH,
  DEVNET_GENESIS_HASH,
} from "@switchboard-xyz/on-demand";

// Program IDs
console.log("Mainnet:", ON_DEMAND_MAINNET_PID.toBase58());
console.log("Devnet:", ON_DEMAND_DEVNET_PID.toBase58());
```

### Rust

```rust
use switchboard_on_demand::{QUOTE_PROGRAM_ID, default_queue};

// Get default queue for current network
let queue = default_queue();
```

## Crossbar Endpoints

Crossbar is the oracle communication service.

| Network | Endpoint |
|---------|----------|
| Mainnet | `https://crossbar.switchboard.xyz` |
| Devnet | `https://crossbar.switchboard.xyz` |

## Surge WebSocket Endpoints

For real-time price streaming:

| Network | Endpoint |
|---------|----------|
| Mainnet | `wss://surge.switchboard.xyz` |
| Devnet | `wss://surge-devnet.switchboard.xyz` |

## Feed Builder

| Environment | URL |
|-------------|-----|
| Production | `https://ondemand.switchboard.xyz` |

## Usage Examples

### Get Program ID by Network

```typescript
import { web3 } from "@coral-xyz/anchor";
import { ON_DEMAND_MAINNET_PID, ON_DEMAND_DEVNET_PID } from "@switchboard-xyz/on-demand";

function getProgramId(network: "mainnet" | "devnet"): web3.PublicKey {
  return network === "mainnet" ? ON_DEMAND_MAINNET_PID : ON_DEMAND_DEVNET_PID;
}

function getQueue(network: "mainnet" | "devnet"): web3.PublicKey {
  const queues = {
    mainnet: new web3.PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w"),
    devnet: new web3.PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7"),
  };
  return queues[network];
}
```

### Initialize with Correct Network

```typescript
const network = process.env.SOLANA_NETWORK as "mainnet" | "devnet" || "devnet";
const programId = getProgramId(network);
const queue = getQueue(network);

const sbProgram = await Program.at(programId, provider);
```

## Account Derivation

### Oracle Quote Account

```typescript
import { OracleQuote } from "@switchboard-xyz/on-demand";

// Derive canonical quote account from feed hashes
const feedHashes = ["0x...", "0x..."];
const queueKey = getQueue("mainnet");
const quotePubkey = OracleQuote.getCanonicalPubkey(queueKey, feedHashes);
```

### Feed Account

Feed accounts are created when deploying feeds via the Feed Builder or SDK.

```typescript
// Feed pubkey is returned when creating a feed
const feedPubkey = new web3.PublicKey("YOUR_FEED_PUBKEY");
```

## Network Detection

```typescript
import { web3 } from "@coral-xyz/anchor";

async function detectNetwork(connection: web3.Connection): Promise<"mainnet" | "devnet"> {
  const genesisHash = await connection.getGenesisHash();

  // Mainnet genesis hash
  if (genesisHash === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") {
    return "mainnet";
  }

  return "devnet";
}
```
