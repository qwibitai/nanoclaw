# MagicBlock Program IDs & Constants

Quick reference for all program IDs, RPC endpoints, and constants.

## Program IDs

### Core Programs

| Program | ID | Purpose |
|---------|-----|---------|
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | Account delegation |
| Magic Program | `Magic11111111111111111111111111111111111111` | ER operations |

### VRF Programs

| Program | ID | Purpose |
|---------|-----|---------|
| Ephemeral VRF | `EPHvrfnQ5RPLRaakdqLZwxbDyLcrMnhL7QNTNwE5pto` | VRF oracle |
| Default Queue | `EPHvrfnQ5RPLRaakdqLZwxbDyLcrMnhL7QNTNwE5pto` | VRF request queue |

---

## RPC Endpoints

### Devnet

| Layer | HTTP | WebSocket |
|-------|------|-----------|
| Solana Base | `https://api.devnet.solana.com` | `wss://api.devnet.solana.com` |
| Magic Router | `https://devnet-router.magicblock.app` | `wss://devnet-router.magicblock.app` |
| ER Direct | `https://devnet.magicblock.app` | `wss://devnet.magicblock.app` |

### Mainnet (Coming Soon)

| Layer | HTTP | WebSocket |
|-------|------|-----------|
| Solana Base | `https://api.mainnet-beta.solana.com` | `wss://api.mainnet-beta.solana.com` |
| Magic Router | TBA | TBA |

---

## Validator Identities (Devnet)

Use these for geographic routing:

| Region | Validator Identity |
|--------|-------------------|
| Asia | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` |
| Europe | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |
| United States | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| TEE (Secure) | `FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA` |

---

## TypeScript Constants

```typescript
import { PublicKey } from "@solana/web3.js";

// Program IDs
export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");

// VRF
export const EPHEMERAL_VRF_PROGRAM_ID = new PublicKey("EPHvrfnQ5RPLRaakdqLZwxbDyLcrMnhL7QNTNwE5pto");
export const DEFAULT_EPHEMERAL_QUEUE = new PublicKey("EPHvrfnQ5RPLRaakdqLZwxbDyLcrMnhL7QNTNwE5pto");

// RPC Endpoints
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
export const SOLANA_DEVNET_WS = "wss://api.devnet.solana.com";
export const ER_DEVNET_ROUTER = "https://devnet-router.magicblock.app";
export const ER_DEVNET_WS = "wss://devnet-router.magicblock.app";

// Validators
export const VALIDATORS = {
  ASIA: new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
  EU: new PublicKey("MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e"),
  US: new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd"),
  TEE: new PublicKey("FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA"),
};
```

---

## Rust Constants

```rust
use anchor_lang::prelude::*;

// Program IDs
pub const DELEGATION_PROGRAM_ID: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
pub const MAGIC_PROGRAM_ID: Pubkey = pubkey!("Magic11111111111111111111111111111111111111");

// VRF
pub const EPHEMERAL_VRF_PROGRAM_ID: Pubkey = pubkey!("EPHvrfnQ5RPLRaakdqLZwxbDyLcrMnhL7QNTNwE5pto");
pub const DEFAULT_EPHEMERAL_QUEUE: Pubkey = pubkey!("EPHvrfnQ5RPLRaakdqLZwxbDyLcrMnhL7QNTNwE5pto");

// Or use SDK imports
use ephemeral_rollups_sdk::consts::DELEGATION_PROGRAM_ID;
use ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE;
```

---

## SDK Package Versions

### Rust (Cargo.toml)

```toml
[dependencies]
anchor-lang = "0.32.1"
ephemeral-rollups-sdk = { version = "0.6.5", features = ["anchor", "disable-realloc"] }
ephemeral-vrf-sdk = { version = "0.3", features = ["anchor"] }
```

### TypeScript (package.json)

```json
{
  "dependencies": {
    "@coral-xyz/anchor": "^0.32.1",
    "@solana/web3.js": "^1.95.0",
    "@magicblock-labs/ephemeral-rollups-sdk": "^0.1.0",
    "@magicblock-labs/ephemeral-vrf-sdk": "^0.1.0"
  }
}
```

---

## Tool Versions

| Tool | Required Version |
|------|-----------------|
| Solana CLI | 2.3.13 |
| Rust | 1.85.0 |
| Anchor CLI | 0.32.1 |
| Node.js | 24.10.0 |

### Install Commands

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.13/install)"

# Rust
rustup update stable

# Anchor
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.32.1

# Verify
solana --version
anchor --version
```
