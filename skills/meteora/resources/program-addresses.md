# Meteora Program Addresses

Quick reference for all Meteora program addresses and NPM packages.

## Program Addresses

| Program | Mainnet | Devnet |
|---------|---------|--------|
| **DLMM** | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| **DAMM v2 (CP-AMM)** | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| **Dynamic Bonding Curve** | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| **Dynamic Vault** | `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` | `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` |
| **Stake-for-Fee (M3M3)** | `FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP` | `FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP` |

## NPM Packages

| Package | Description | Version |
|---------|-------------|---------|
| `@meteora-ag/dlmm` | DLMM SDK | Latest |
| `@meteora-ag/cp-amm-sdk` | DAMM v2 SDK | Latest |
| `@meteora-ag/dynamic-bonding-curve-sdk` | Dynamic Bonding Curve SDK | Latest |
| `@meteora-ag/vault-sdk` | Dynamic Vault SDK | Latest |
| `@meteora-ag/alpha-vault` | Alpha Vault SDK | Latest |
| `@meteora-ag/m3m3` | Stake-for-Fee SDK | Latest |

## Installation Commands

### All SDKs

```bash
# DLMM
npm install @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js

# DAMM v2
npm install @meteora-ag/cp-amm-sdk @solana/web3.js

# Dynamic Bonding Curve
npm install @meteora-ag/dynamic-bonding-curve-sdk

# Vault
npm install @meteora-ag/vault-sdk @coral-xyz/anchor @solana/web3.js @solana/spl-token

# Alpha Vault
npm install @meteora-ag/alpha-vault

# Stake-for-Fee (M3M3)
npm install @meteora-ag/m3m3 @coral-xyz/anchor @solana/web3.js @solana/spl-token @solana/spl-token-registry
```

### Full Stack Installation

```bash
npm install \
  @meteora-ag/dlmm \
  @meteora-ag/cp-amm-sdk \
  @meteora-ag/dynamic-bonding-curve-sdk \
  @meteora-ag/vault-sdk \
  @meteora-ag/alpha-vault \
  @meteora-ag/m3m3 \
  @coral-xyz/anchor \
  @solana/web3.js \
  @solana/spl-token
```

## RPC Endpoints

| Network | HTTP | WebSocket |
|---------|------|-----------|
| Mainnet | `https://api.mainnet-beta.solana.com` | `wss://api.mainnet-beta.solana.com` |
| Devnet | `https://api.devnet.solana.com` | `wss://api.devnet.solana.com` |

**Recommended RPC Providers:**
- Helius: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`
- Triton: `https://YOUR_PROJECT.rpcpool.com`
- QuickNode: Your custom endpoint

## GitHub Repositories

| SDK | Repository |
|-----|------------|
| DLMM | https://github.com/MeteoraAg/dlmm-sdk |
| DAMM v2 | https://github.com/MeteoraAg/cp-amm-sdk |
| Dynamic Bonding Curve | https://github.com/MeteoraAg/dynamic-bonding-curve-sdk |
| Vault | https://github.com/MeteoraAg/vault-sdk |
| Alpha Vault | https://github.com/MeteoraAg/alpha-vault-sdk |
| Stake-for-Fee | https://github.com/MeteoraAg/stake-for-fee-sdk |

## Web Tools

| Tool | URL | Description |
|------|-----|-------------|
| Meteora App | https://app.meteora.ag | Main trading interface |
| Manual Migrator | https://migrator.meteora.ag | DBC pool migration |
| Documentation | https://docs.meteora.ag | Official docs |

## Common Token Addresses

| Token | Mainnet Address |
|-------|-----------------|
| SOL (Native Mint) | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

## TypeScript Imports

```typescript
// DLMM
import DLMM from '@meteora-ag/dlmm';
import { StrategyType } from '@meteora-ag/dlmm';

// DAMM v2
import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk';

// Dynamic Bonding Curve
import { DynamicBondingCurve } from '@meteora-ag/dynamic-bonding-curve-sdk';

// Vault
import { VaultImpl, getAmountByShare, getUnmintAmount } from '@meteora-ag/vault-sdk';

// Alpha Vault
import { AlphaVault } from '@meteora-ag/alpha-vault';

// Stake-for-Fee
import { StakeForFee } from '@meteora-ag/m3m3';
```

## Environment Setup

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

### Required Polyfills (Browser)

```javascript
// For browser environments
import { Buffer } from 'buffer';
window.Buffer = Buffer;

import process from 'process';
window.process = process;
```
