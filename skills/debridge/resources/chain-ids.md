# deBridge Chain ID Reference

Complete reference for all supported blockchain chain identifiers.

## Chain ID Format

deBridge uses 32-byte arrays for chain identifiers. For EVM chains, the chain ID is placed at the end of the array (big-endian). For Solana, a special ASCII identifier is used.

## Supported Chains

### Solana

```rust
use debridge_solana_sdk::chain_ids::SOLANA_CHAIN_ID;

// Solana mainnet - ASCII "sol" at bytes 29-31
pub const SOLANA_CHAIN_ID: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 115, 111, 108  // "sol"
];
```

### EVM Chains

| Chain | Constant | Chain ID | Bytes (end) |
|-------|----------|----------|-------------|
| Ethereum | `ETHEREUM_CHAIN_ID` | 1 | `[..., 0, 0, 0, 1]` |
| BNB Chain | `BNB_CHAIN_CHAIN_ID` | 56 | `[..., 0, 0, 0, 56]` |
| Polygon | `POLYGON_CHAIN_ID` | 137 | `[..., 0, 0, 0, 137]` |
| Heco | `HECO_CHAIN_ID` | 128 | `[..., 0, 0, 0, 128]` |
| Fantom | `FANTOM_CHAIN_ID` | 250 | `[..., 0, 0, 0, 250]` |
| Arbitrum | `ARBITRUM_CHAIN_ID` | 42161 | `[..., 0, 0, 164, 177]` |
| Avalanche | `AVALANCHE_CHAIN_ID` | 43114 | `[..., 0, 0, 168, 106]` |

### Full Constants

```rust
use debridge_solana_sdk::chain_ids::*;

// Ethereum Mainnet (Chain ID: 1)
pub const ETHEREUM_CHAIN_ID: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 1
];

// BNB Chain (Chain ID: 56)
pub const BNB_CHAIN_CHAIN_ID: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 56
];

// Polygon (Chain ID: 137)
pub const POLYGON_CHAIN_ID: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 137
];

// Heco (Chain ID: 128)
pub const HECO_CHAIN_ID: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 128
];

// Fantom (Chain ID: 250)
pub const FANTOM_CHAIN_ID: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 250
];

// Arbitrum One (Chain ID: 42161)
pub const ARBITRUM_CHAIN_ID: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 164, 177
];

// Avalanche C-Chain (Chain ID: 43114)
pub const AVALANCHE_CHAIN_ID: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 168, 106
];
```

## Helper Functions

### Convert EVM Chain ID to deBridge Format

```rust
fn evm_chain_id_to_bytes(chain_id: u64) -> [u8; 32] {
    let mut result = [0u8; 32];
    let bytes = chain_id.to_be_bytes();
    result[24..32].copy_from_slice(&bytes);
    result
}

// Usage
let optimism = evm_chain_id_to_bytes(10);       // Optimism
let base = evm_chain_id_to_bytes(8453);          // Base
let linea = evm_chain_id_to_bytes(59144);        // Linea
```

### Parse Chain ID from Bytes

```rust
fn bytes_to_chain_id(bytes: &[u8; 32]) -> u64 {
    u64::from_be_bytes(bytes[24..32].try_into().unwrap())
}

// Usage
let chain_id = bytes_to_chain_id(&ETHEREUM_CHAIN_ID);
assert_eq!(chain_id, 1);
```

### Check if Solana Chain

```rust
fn is_solana_chain(chain_id: &[u8; 32]) -> bool {
    chain_id == &SOLANA_CHAIN_ID
}
```

## TypeScript Utilities

```typescript
// Chain ID constants
const CHAIN_IDS = {
  SOLANA: new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 115, 111, 108
  ]),
  ETHEREUM: evmChainIdToBytes(1n),
  POLYGON: evmChainIdToBytes(137n),
  ARBITRUM: evmChainIdToBytes(42161n),
  BNB: evmChainIdToBytes(56n),
  AVALANCHE: evmChainIdToBytes(43114n),
};

// Convert EVM chain ID to 32-byte array
function evmChainIdToBytes(chainId: bigint): Uint8Array {
  const result = new Uint8Array(32);
  const bytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(chainId & 0xffn);
    chainId >>= 8n;
  }
  result.set(bytes, 24);
  return result;
}

// Parse chain ID from bytes
function bytesToChainId(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 24; i < 32; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}
```

## Additional Supported Chains

deBridge supports 20+ chains. Check chain availability before sending:

```rust
use debridge_solana_sdk::sending::is_chain_supported;

pub fn check_chain(
    ctx: Context<CheckChain>,
    target_chain_id: [u8; 32],
) -> Result<bool> {
    is_chain_supported(&target_chain_id, ctx.remaining_accounts)
}
```

For the complete list of supported chains, see:
- [deBridge Docs](https://docs.debridge.com/chains)
- [deBridge App](https://app.debridge.finance)

## Common Chain ID Mappings

| Network | Chain ID (Decimal) | Hex | deBridge Supported |
|---------|-------------------|-----|-------------------|
| Ethereum | 1 | 0x1 | Yes |
| Optimism | 10 | 0xa | Yes |
| BNB Chain | 56 | 0x38 | Yes |
| Polygon | 137 | 0x89 | Yes |
| Fantom | 250 | 0xfa | Yes |
| Arbitrum | 42161 | 0xa4b1 | Yes |
| Avalanche | 43114 | 0xa86a | Yes |
| Base | 8453 | 0x2105 | Yes |
| Linea | 59144 | 0xe708 | Yes |
| Solana | N/A | "sol" | Yes |
