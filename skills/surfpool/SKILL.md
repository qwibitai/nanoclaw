---
name: surfpool
creator: raunit-dev
description: Complete Surfpool development environment for Solana - drop-in replacement for solana-test-validator with mainnet forking, cheatcodes, Infrastructure as Code, and Surfpool Studio. The fastest way to develop and test Solana programs.
---

# Surfpool - Solana Development Environment

The definitive guide for Surfpool - where developers start their Solana journey. A drop-in replacement for `solana-test-validator` that enables local program simulation using Mainnet accounts fetched just-in-time.

## What is Surfpool?

Surfpool is a comprehensive development environment that combines local-first testing with real Mainnet data access:

- **Mainnet Forking** - Clone accounts, programs, and token balances from Mainnet instantly
- **Cheatcodes** - Special RPC methods for time travel, balance manipulation, and state control
- **Infrastructure as Code** - Reproducible, auditable deployments using txtx DSL
- **Surfpool Studio** - Embedded dashboard with transaction inspection and profiling
- **Universal Faucet** - Get SOL, USDC, USDT, BONK from a single interface

### Key Benefits

| Feature | Description |
|---------|-------------|
| **Instant Boot** | No 2TB snapshots, runs on Raspberry Pi |
| **Lazy Forking** | Copy-on-read strategy pulls mainnet data as needed |
| **Full Compatibility** | Works with solana-cli, Anchor, wallets, explorers |
| **Zero Config** | Auto-detects Anchor projects and deploys programs |

### Statistics
- 460+ GitHub stars
- 100+ forks
- Apache 2.0 license
- Current version: v1.0.0

## Installation

### Automated Installer (Recommended)

```bash
curl -sL https://run.surfpool.run/ | bash
```

### Homebrew (macOS)

```bash
brew install txtx/taps/surfpool
```

### From Source

```bash
git clone https://github.com/txtx/surfpool.git
cd surfpool
cargo surfpool-install
```

### Docker

```bash
docker pull surfpool/surfpool
docker run -p 8899:8899 -p 18488:18488 surfpool/surfpool
```

## Quick Start

### Start Local Network

```bash
# Start with default configuration
surfpool start

# Start with custom RPC source
surfpool start -u https://api.mainnet-beta.solana.com

# Start without terminal UI
surfpool start --no-tui

# Start with debug logging
surfpool start --debug
```

### Access Points

| Service | URL | Description |
|---------|-----|-------------|
| RPC Endpoint | `http://127.0.0.1:8899` | Standard Solana RPC |
| WebSocket | `ws://127.0.0.1:8900` | Real-time subscriptions |
| Surfpool Studio | `http://127.0.0.1:18488` | Web dashboard |

## CLI Commands

### surfpool start

Start the local Surfnet network.

```bash
surfpool start [OPTIONS]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-m, --manifest-file-path` | `./Surfpool.toml` | Path to manifest file |
| `-p, --port` | `8899` | RPC port |
| `-o, --host` | `127.0.0.1` | Host address |
| `-s, --slot-time` | `400` | Slot time in ms |
| `-u, --rpc-url` | `https://api.mainnet-beta.solana.com` | Source RPC URL |
| `--no-tui` | - | Disable terminal UI |
| `--debug` | - | Enable debug logs |
| `--no-deploy` | - | Disable auto deployments |
| `-r, --runbook` | `deployment` | Runbooks to execute |
| `-a, --airdrop` | - | Pubkeys to airdrop |
| `-q, --airdrop-amount` | `10000000000000` | Airdrop amount (lamports) |
| `-k, --airdrop-keypair-path` | - | Keypair path for airdrop |
| `--no-explorer` | - | Disable explorer |

### Example Usage

```bash
# Start with airdrop to specific address
surfpool start -a YOUR_PUBKEY -q 100000000000

# Start with custom slot time (faster blocks)
surfpool start -s 100

# Start with specific runbook
surfpool start -r deployment -r setup
```

## Surfpool.toml Configuration

Create a `Surfpool.toml` in your project root:

```toml
[network]
slot_time = 400
epoch_duration = 432000
rpc_url = "https://api.mainnet-beta.solana.com"

[behavior]
# Fork from mainnet genesis
genesis = false
# Fork from specific point
point_fork = true

[accounts]
# Pre-clone specific accounts
clone = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  # Token Program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", # ATA Program
]

[programs]
# Auto-deploy local programs
deploy = ["./target/deploy/my_program.so"]

[airdrop]
# Default airdrop recipients
addresses = ["YOUR_PUBKEY"]
amount = 10000000000000  # 10,000 SOL
```

## Cheatcodes

Surfpool provides special RPC methods for advanced state manipulation during testing.

### Account Manipulation

#### surfnet_setAccount

Set arbitrary account data:

```typescript
await connection.send("surfnet_setAccount", [
  {
    pubkey: "AccountPubkey...",
    lamports: 1000000000,
    data: "base64EncodedData",
    owner: "OwnerPubkey...",
    executable: false,
  },
]);
```

#### surfnet_setTokenAccount

Create or modify token accounts:

```typescript
await connection.send("surfnet_setTokenAccount", [
  {
    owner: "OwnerPubkey...",
    mint: "MintPubkey...",
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    update: {
      amount: "1000000000",
      delegate: null,
      state: "initialized",
    },
  },
]);
```

#### surfnet_cloneProgramAccount

Clone a program from mainnet:

```typescript
await connection.send("surfnet_cloneProgramAccount", [
  {
    source: "SourceProgramPubkey...",
    destination: "DestinationPubkey...",
  },
]);
```

#### surfnet_resetAccount

Reset account to mainnet state:

```typescript
await connection.send("surfnet_resetAccount", [
  {
    pubkey: "AccountPubkey...",
    includeOwnedAccounts: true,
  },
]);
```

### Time Control

#### surfnet_timeTravel

Advance network time:

```typescript
await connection.send("surfnet_timeTravel", [
  {
    epoch: 100,
    slot: 50000,
    timestamp: 1700000000,
  },
]);
```

#### surfnet_pauseClock / surfnet_resumeClock

Control block production:

```typescript
// Pause
await connection.send("surfnet_pauseClock", []);

// Resume
await connection.send("surfnet_resumeClock", []);
```

#### surfnet_advanceClock

Advance clock incrementally:

```typescript
await connection.send("surfnet_advanceClock", [
  { slots: 100 },
]);
```

### Transaction Profiling

#### surfnet_profileTransaction

Profile transaction execution:

```typescript
const result = await connection.send("surfnet_profileTransaction", [
  {
    transaction: "base64EncodedTx",
    tag: "my-test-tag",
  },
]);

console.log("Compute units:", result.computeUnits);
console.log("Account changes:", result.accountChanges);
```

#### surfnet_getProfileResults

Get profiling results by tag:

```typescript
const results = await connection.send("surfnet_getProfileResults", [
  { tag: "my-test-tag" },
]);
```

### Network Control

#### surfnet_resetNetwork

Reset entire network to initial state:

```typescript
await connection.send("surfnet_resetNetwork", []);
```

#### surfnet_getClock

Get current network time:

```typescript
const clock = await connection.send("surfnet_getClock", []);
console.log("Slot:", clock.slot);
console.log("Epoch:", clock.epoch);
console.log("Timestamp:", clock.timestamp);
```

## Surfpool Studio

Access the web dashboard at `http://127.0.0.1:18488` for:

- **Transaction Inspector** - View transaction details with byte-level diffs
- **Account Browser** - Explore account state and history
- **Compute Profiler** - Analyze compute unit usage per instruction
- **Universal Faucet** - Request SOL and tokens
- **Network Status** - Monitor slots, epochs, and block production

## Infrastructure as Code

Surfpool integrates txtx DSL for reproducible deployments.

### Runbook Structure

```hcl
# deployment.tx

// Define signers
signer "deployer" "svm::secret_key" {
  secret_key = env.DEPLOYER_KEY
}

// Deploy program
action "deploy_program" "svm::deploy_program" {
  program_path = "./target/deploy/my_program.so"
  signer = signer.deployer
}

// Initialize program
action "initialize" "svm::send_transaction" {
  transaction {
    instruction {
      program_id = action.deploy_program.program_id
      data = encode_instruction("initialize", {})
    }
  }
  signers = [signer.deployer]
}
```

### Running Runbooks

```bash
# Run specific runbook
surfpool start -r deployment

# Run in unsupervised mode
surfpool start -r deployment --unsupervised
```

## Scenarios and Fixtures

### Scenarios

Define account state sequences for testing:

```typescript
await connection.send("surfnet_registerScenario", [
  {
    name: "high-volume-trading",
    slots: [
      {
        slot: 100,
        accounts: {
          "PoolPubkey...": { lamports: 1000000000000 },
        },
      },
      {
        slot: 200,
        accounts: {
          "PoolPubkey...": { lamports: 500000000000 },
        },
      },
    ],
  },
]);
```

### Fixtures

Export transaction fixtures for reproducible tests:

```typescript
const fixture = await connection.send("surfnet_exportSnapshot", [
  {
    transaction: "txSignature...",
    format: "json",
  },
]);

// Save fixture for CI/CD
fs.writeFileSync("fixtures/my-test.json", JSON.stringify(fixture));
```

## Integration with Anchor

Surfpool auto-detects Anchor projects and handles deployment:

```bash
# In an Anchor project directory
surfpool start
# Programs in target/deploy/ are automatically deployed
```

### Testing with Anchor

```typescript
import * as anchor from "@coral-xyz/anchor";

describe("My Program", () => {
  // Use local Surfnet
  const provider = anchor.AnchorProvider.local("http://127.0.0.1:8899");
  anchor.setProvider(provider);

  it("works with mainnet state", async () => {
    // Your tests automatically have access to mainnet accounts
  });
});
```

## Best Practices

### 1. Use Cheatcodes for Setup

```typescript
// Set up test state before each test
beforeEach(async () => {
  await connection.send("surfnet_resetNetwork", []);
  await connection.send("surfnet_setTokenAccount", [...]);
});
```

### 2. Profile Critical Paths

```typescript
// Tag transactions for profiling
const result = await connection.send("surfnet_profileTransaction", [
  { transaction: tx, tag: "swap-operation" },
]);

expect(result.computeUnits).toBeLessThan(200000);
```

### 3. Use Scenarios for Edge Cases

```typescript
// Test with specific mainnet conditions
await connection.send("surfnet_registerScenario", [
  { name: "low-liquidity", slots: [...] },
]);
```

### 4. Export Fixtures for CI

```typescript
// Create reproducible test fixtures
const fixture = await connection.send("surfnet_exportSnapshot", [...]);
```

## Resources

### Official Links
- **Website**: https://surfpool.run
- **Documentation**: https://docs.surfpool.run
- **GitHub**: https://github.com/txtx/surfpool

### Community
- **Discord**: https://discord.gg/surfpool
- **Twitter**: @surfaboratory
- **Telegram**: Announcements channel

### Tutorials
- [Surfpool 101 - Blueshift](https://learn.blueshift.gg/en/courses/testing-with-surfpool/surfpool-101)
- [Helius Blog - Introducing Surfpool](https://www.helius.dev/blog/surfpool)

## Skill Structure

```
surfpool/
├── SKILL.md                    # This file
├── resources/
│   ├── cheatcodes.md           # Complete cheatcodes reference
│   ├── cli-reference.md        # CLI commands reference
│   └── github-repos.md         # Repository links
├── examples/
│   ├── basic/
│   │   └── getting-started.ts  # Basic setup example
│   ├── cheatcodes/
│   │   └── state-manipulation.ts # Cheatcode examples
│   └── iac/
│       └── deployment.tx       # Infrastructure as Code example
├── templates/
│   ├── Surfpool.toml           # Configuration template
│   └── test-setup.ts           # Test setup template
└── docs/
    └── troubleshooting.md      # Common issues
```
