# Switchboard GitHub Repositories

Official repositories for Switchboard Oracle Protocol.

## Core Repositories

### Main Repository

| Repository | Description | Language |
|------------|-------------|----------|
| [switchboard](https://github.com/switchboard-xyz/switchboard) | Main monorepo with SDKs, CLI, and documentation | TypeScript, Rust |

Contains:
- `@switchboard-xyz/cli` - Command-line interface
- `@switchboard-xyz/common` - Shared types and utilities
- `@switchboard-xyz/oracle` - Oracle wrapper

---

## SDKs

### TypeScript SDK

| Repository | Description | Package |
|------------|-------------|---------|
| [on-demand](https://github.com/switchboard-xyz/on-demand) | Solana On-Demand SDK | `@switchboard-xyz/on-demand` |

**Installation:**
```bash
npm install @switchboard-xyz/on-demand @switchboard-xyz/common
```

### Rust SDK

| Repository | Description | Crate |
|------------|-------------|-------|
| [solana-sdk](https://github.com/switchboard-xyz/solana-sdk) | Rust client for Solana | `switchboard-on-demand` |

**Installation:**
```toml
[dependencies]
switchboard-on-demand = "0.8.0"
```

### Multi-Chain SDKs

| Repository | Chain | Language |
|------------|-------|----------|
| [sui-sdk](https://github.com/switchboard-xyz/sui-sdk) | Sui | TypeScript |
| [on-demand-solidity](https://github.com/switchboard-xyz/on-demand-solidity) | EVM | Solidity |

---

## Examples

### Primary Examples Repository

| Repository | Description |
|------------|-------------|
| [sb-on-demand-examples](https://github.com/switchboard-xyz/sb-on-demand-examples) | Complete integration examples |

**Structure:**
```
sb-on-demand-examples/
├── solana/
│   ├── feeds/
│   │   ├── basic/          # Anchor framework examples
│   │   └── advanced/       # Pinocchio framework (optimized)
│   ├── randomness/
│   │   ├── coin-flip/      # VRF coin flip game
│   │   └── pancake-stacker/# VRF stacking game
│   ├── prediction-market/  # Kalshi integration
│   ├── x402/              # Paywalled data
│   └── surge/             # WebSocket streaming
├── sui/                   # Sui examples
├── evm/                   # EVM examples
└── common/                # Cross-chain utilities
```

---

## Documentation

| Repository | Description | URL |
|------------|-------------|-----|
| [gitbook-on-demand](https://github.com/switchboard-xyz/gitbook-on-demand) | Documentation source | docs.switchboard.xyz |

---

## Infrastructure

| Repository | Description |
|------------|-------------|
| [infra-external](https://github.com/switchboard-xyz/infra-external) | Infrastructure configuration |
| [trustee](https://github.com/switchboard-xyz/trustee) | Attestation and secrets |

---

## Getting Started

### Clone Examples

```bash
# Clone examples repository
git clone https://github.com/switchboard-xyz/sb-on-demand-examples.git
cd sb-on-demand-examples

# Navigate to Solana examples
cd solana

# Install dependencies
bun install
# or
npm install

# Run basic feed example
cd feeds/basic
npm run start
```

### Clone SDK

```bash
# TypeScript SDK
git clone https://github.com/switchboard-xyz/on-demand.git
cd on-demand
npm install

# Rust SDK
git clone https://github.com/switchboard-xyz/solana-sdk.git
cd solana-sdk
cargo build
```

---

## Documentation Resources

| Resource | URL |
|----------|-----|
| Official Docs | https://docs.switchboard.xyz |
| Rustdoc | https://docs.rs/switchboard-on-demand |
| Feed Builder | https://ondemand.switchboard.xyz |

---

## Community

| Platform | Link |
|----------|------|
| Discord | https://discord.gg/TJAv6ZYvPC |
| Twitter | https://twitter.com/switchboardxyz |
| GitHub Discussions | https://github.com/switchboard-xyz/switchboard/discussions |

---

## Quick Links

### For Solana Developers

1. **Start Here**: [sb-on-demand-examples/solana](https://github.com/switchboard-xyz/sb-on-demand-examples/tree/main/solana)
2. **TypeScript SDK**: [@switchboard-xyz/on-demand](https://github.com/switchboard-xyz/on-demand)
3. **Rust SDK**: [switchboard-on-demand](https://github.com/switchboard-xyz/solana-sdk)

### For Other Chains

- **Sui**: [switchboard-xyz/sui-sdk](https://github.com/switchboard-xyz/sui-sdk)
- **EVM**: [switchboard-xyz/on-demand-solidity](https://github.com/switchboard-xyz/on-demand-solidity)
