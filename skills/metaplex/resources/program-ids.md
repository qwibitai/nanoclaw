# Metaplex Program IDs

Complete reference of all Metaplex program addresses on Solana.

## Core Programs

### MPL Core

| Program | Address | Description |
|---------|---------|-------------|
| **MPL Core** | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` | Next-gen NFT standard |

### Token Metadata

| Program | Address | Description |
|---------|---------|-------------|
| **Token Metadata** | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | Original NFT metadata program |

### Bubblegum (Compressed NFTs)

| Program | Address | Description |
|---------|---------|-------------|
| **Bubblegum** | `BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY` | Compressed NFT program |

### Candy Machine (Token Metadata NFTs)

| Program | Address | Description |
|---------|---------|-------------|
| **Candy Machine V3** | `CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR` | NFT minting machine |
| **Candy Guard** | `Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g` | Guard program for Candy Machine |

### Core Candy Machine (Core Assets)

| Program | Address | Description |
|---------|---------|-------------|
| **Core Candy Machine** | `CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J` | Candy Machine for Core assets |
| **Core Candy Guard** | `CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ` | Guard for Core Candy Machine |

### MPL-Hybrid (MPL-404)

| Program | Address | Description |
|---------|---------|-------------|
| **MPL Hybrid** | `MPL4o4wMzndgh8T1NVDxELQCj5UQfYTYEkabX3wNKtb` | Token/NFT swap program |

### Inscriptions

| Program | Address | Description |
|---------|---------|-------------|
| **Inscription** | `1NSCRfGeyo7wPUazGbaPBUsTM49e1k2aXewHGARfzSo` | On-chain data storage |

## SPL Programs (Required)

| Program | Address | Description |
|---------|---------|-------------|
| **SPL Token** | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | Original token program |
| **Token 2022** | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | Token Extensions program |
| **Associated Token** | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | ATA program |

## Compression Programs

| Program | Address | Description |
|---------|---------|-------------|
| **Account Compression** | `cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK` | Merkle tree compression |
| **SPL Noop** | `noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV` | No-op for logging |

## TypeScript Constants

```typescript
export const METAPLEX_PROGRAMS = {
  // Core Programs
  MPL_CORE: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  TOKEN_METADATA: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  BUBBLEGUM: 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY',

  // Candy Machine
  CANDY_MACHINE_V3: 'CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR',
  CANDY_GUARD: 'Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g',

  // Core Candy Machine
  CORE_CANDY_MACHINE: 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J',
  CORE_CANDY_GUARD: 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ',

  // Utilities
  MPL_HYBRID: 'MPL4o4wMzndgh8T1NVDxELQCj5UQfYTYEkabX3wNKtb',
  INSCRIPTION: '1NSCRfGeyo7wPUazGbaPBUsTM49e1k2aXewHGARfzSo',

  // SPL Programs
  SPL_TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ASSOCIATED_TOKEN: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',

  // Compression
  ACCOUNT_COMPRESSION: 'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK',
  SPL_NOOP: 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV',
} as const;

export type MetaplexProgram = keyof typeof METAPLEX_PROGRAMS;
```

## Python Constants

```python
METAPLEX_PROGRAMS = {
    # Core Programs
    "MPL_CORE": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
    "TOKEN_METADATA": "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    "BUBBLEGUM": "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY",

    # Candy Machine
    "CANDY_MACHINE_V3": "CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR",
    "CANDY_GUARD": "Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g",

    # Core Candy Machine
    "CORE_CANDY_MACHINE": "CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J",
    "CORE_CANDY_GUARD": "CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ",

    # Utilities
    "MPL_HYBRID": "MPL4o4wMzndgh8T1NVDxELQCj5UQfYTYEkabX3wNKtb",
    "INSCRIPTION": "1NSCRfGeyo7wPUazGbaPBUsTM49e1k2aXewHGARfzSo",

    # SPL Programs
    "SPL_TOKEN": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TOKEN_2022": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "ASSOCIATED_TOKEN": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",

    # Compression
    "ACCOUNT_COMPRESSION": "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK",
    "SPL_NOOP": "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",
}
```

## Verifying Program Addresses

You can verify program addresses on:

- [Solana Explorer](https://explorer.solana.com)
- [Solscan](https://solscan.io)
- [SolanaFM](https://solana.fm)

Example: View Token Metadata program:
```
https://solscan.io/account/metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
```
