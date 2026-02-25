# Light Protocol Program Addresses & Endpoints

## Program IDs

### Core Programs (Mainnet & Devnet)

| Program | Address | Description |
|---------|---------|-------------|
| Light System Program | `SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7` | Core system program for ZK Compression |
| Light Token Program | `cTokenmWW8bLPjZEBAUgYy3zKxQZW6VKi7bqNFEVv3m` | Compressed token operations |
| Account Compression | `compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq` | Account compression program |

## RPC Endpoints

Light Protocol requires a ZK Compression-enabled RPC endpoint. Currently, Helius provides the required infrastructure.

### Mainnet

| Service | Endpoint |
|---------|----------|
| Network RPC | `https://mainnet.helius-rpc.com?api-key=<YOUR_API_KEY>` |
| Photon RPC API | `https://mainnet.helius-rpc.com?api-key=<YOUR_API_KEY>` |

### Devnet

| Service | Endpoint |
|---------|----------|
| Network RPC | `https://devnet.helius-rpc.com?api-key=<YOUR_API_KEY>` |
| Photon RPC API | `https://devnet.helius-rpc.com?api-key=<YOUR_API_KEY>` |

### Getting a Helius API Key

1. Visit [helius.dev](https://helius.dev)
2. Create a free account
3. Generate an API key from the dashboard
4. Free tier includes ZK Compression support

## State Trees (V2)

State trees store compressed account data in Merkle tree format. V2 trees are the current default.

### Mainnet State Trees

| Tree | Address |
|------|---------|
| State Tree #1 | `bmt1LryLZUMmF7ZtqESaw7wifBXLfXHQYoE4GAmrahU` |
| State Tree #2 | `BMT2CEQWP5gA5CYubx9hoSxKsqcGE3rxw4qNfEFh8fh7` |
| State Tree #3 | `BMT3EjJSLbHi5mKqCMDxuqMG3nvjcRoJEu85RMhYaRhh` |
| State Tree #4 | `BMT4cNagXZpCx3AvD1VEH6FN1D8XXP4oNyT1HVzKUUdX` |
| State Tree #5 | `BMT5d7HqppEBHGJLSUVekcmXmtGW4xFzsiVTznnY7Ga2` |

### Output Queues

Each state tree has a corresponding output queue for pending state updates:

| Queue | Address |
|-------|---------|
| Output Queue #1 | `oq1m2YZHNxLtxzCLK7FkHXdDvjYcNGwuE7hhccxsLRW` |
| Output Queue #2 | `oq2BDeTxJCvTrXXCV1bS9BknMC4vKp8mCDU7VPz7izq` |
| Output Queue #3 | `oq3h7n86DTn8D3F7PUgyBMG5BXJrLdrJtL9x28xKH9H` |
| Output Queue #4 | `oq4ftkJ5TiD7oNu4JJaCKrE2GU6h9d6Mx4p2gM5xWuA` |
| Output Queue #5 | `oq5S5JY6VPKCxrVVDuFGDvb5Kp6xGYnXFxVJmxJMxhc` |

## Lookup Tables

Address Lookup Tables (ALTs) for efficient transaction building:

| Network | Address |
|---------|---------|
| Mainnet | `9NYFyEqPkyXUhkerbGHXUXkvb4qpzeEdHuGpgbgpH1NJ` |
| Devnet | `qAJZMgnQJ8G6vA3WRcjD9Jan1wtKkaCFWLWskxJrR5V` |

## Interface PDA

The Interface PDA is used for format conversion between compressed and regular accounts:

| Purpose | Address |
|---------|---------|
| Interface PDA | `GXtd2izAiMJPwMEjfgTRH3d7k9mjn4Jq3JrWFv9gySYy` |

## CPI Context Accounts

For Cross-Program Invocation (CPI) with compressed accounts:

| Context | Address |
|---------|---------|
| CPI Context #1 | `cpi1uHzrEhBG733DoEJNgHCyRS3XmmyVNZx5fonubE4` |
| CPI Context #2 | `cpi2JXVyAkLKnLCW4vCCheWSAuD8WrK7LPmHN7Q1t6V` |
| CPI Context #3 | `cpi3VHKUy8NKyX4V7u7VXLb8dZMHwPZ1Rd4QZxJJNjN` |
| CPI Context #4 | `cpi4MKoWAhVBJQFuDLZVXLGZR5VbJJQrL7p9p1t3d5L` |
| CPI Context #5 | `cpi5bEXMmqABRTqKWjK8nGLKhqJJWJKxBZXYBrwYzAk` |

## Usage Example

```typescript
import { PublicKey } from "@solana/web3.js";

// Program IDs
const LIGHT_SYSTEM_PROGRAM = new PublicKey("SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7");
const LIGHT_TOKEN_PROGRAM = new PublicKey("cTokenmWW8bLPjZEBAUgYy3zKxQZW6VKi7bqNFEVv3m");
const ACCOUNT_COMPRESSION = new PublicKey("compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq");

// Lookup Tables
const MAINNET_LOOKUP_TABLE = new PublicKey("9NYFyEqPkyXUhkerbGHXUXkvb4qpzeEdHuGpgbgpH1NJ");
const DEVNET_LOOKUP_TABLE = new PublicKey("qAJZMgnQJ8G6vA3WRcjD9Jan1wtKkaCFWLWskxJrR5V");

// Interface PDA
const INTERFACE_PDA = new PublicKey("GXtd2izAiMJPwMEjfgTRH3d7k9mjn4Jq3JrWFv9gySYy");
```

## Environment Configuration

```bash
# .env file
RPC_ENDPOINT=https://mainnet.helius-rpc.com?api-key=YOUR_API_KEY
PHOTON_ENDPOINT=https://mainnet.helius-rpc.com?api-key=YOUR_API_KEY
WALLET_KEYPAIR_PATH=./keypair.json

# For devnet
# RPC_ENDPOINT=https://devnet.helius-rpc.com?api-key=YOUR_API_KEY
# PHOTON_ENDPOINT=https://devnet.helius-rpc.com?api-key=YOUR_API_KEY
```
