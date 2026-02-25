# Raydium Program IDs & Constants

All program addresses and constants for Raydium protocol integration.

## Program IDs

### Mainnet

| Program | Address |
|---------|---------|
| AMM V4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` |
| CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` |
| CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` |
| Farm V3 | `9KEPoZmtHUrBbhWN1v1KWLMkkvwY6WLtAVUCPRtRjP4z` |
| Farm V5 | `FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG` |
| Farm V6 | `FarmNgYzMUpP4hK8Efmp83d5EB8oNS4sNhCNgEUxuPHX` |
| Router | `routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS` |
| OpenBook | `srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX` |

### Devnet

| Program | Address |
|---------|---------|
| AMM V4 | `DRaya7Kj3aMWQSy19kSjvmuwq9docCHofyP9kanQGaav` |
| CLMM | `devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH` |
| CPMM | `CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW` |

---

## API Endpoints

### Mainnet

```typescript
const MAINNET_API = {
  base: 'https://api-v3.raydium.io',
  tokenList: '/mint/list',
  tokenInfo: '/mint/ids',
  poolList: '/pools/info/list',
  poolById: '/pools/info/ids',
  poolByMints: '/pools/info/mint',
  farmList: '/farms/info/list',
  farmById: '/farms/info/ids',
  clmmConfigs: '/clmm/configs',
  cpmmConfigs: '/cpmm/configs',
  priceList: '/mint/price',
};
```

### Devnet

```typescript
const DEVNET_API = {
  base: 'https://api-v3.raydium.io',
  // Same endpoints, different cluster param
};
```

---

## TypeScript Constants

```typescript
import { PublicKey } from '@solana/web3.js';

// Mainnet Program IDs
export const RAYDIUM_PROGRAMS = {
  AMM_V4: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  CLMM: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
  CPMM: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
  FARM_V3: new PublicKey('9KEPoZmtHUrBbhWN1v1KWLMkkvwY6WLtAVUCPRtRjP4z'),
  FARM_V5: new PublicKey('FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG'),
  FARM_V6: new PublicKey('FarmNgYzMUpP4hK8Efmp83d5EB8oNS4sNhCNgEUxuPHX'),
  ROUTER: new PublicKey('routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS'),
};

// Devnet Program IDs
export const RAYDIUM_DEVNET_PROGRAMS = {
  AMM_V4: new PublicKey('DRaya7Kj3aMWQSy19kSjvmuwq9docCHofyP9kanQGaav'),
  CLMM: new PublicKey('devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH'),
  CPMM: new PublicKey('CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW'),
};

// Common tokens (Mainnet)
export const TOKENS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  RAY: new PublicKey('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'),
  WSOL: new PublicKey('So11111111111111111111111111111111111111112'),
};

// Popular Pool IDs (Mainnet)
export const POOLS = {
  // CLMM Pools
  SOL_USDC_CLMM: 'DnmohzP5x6hJGDpTAEXPwcDnwJoZKjTrfcXKaWG99XYh',
  RAY_USDC_CLMM: 'DiwsGxJYoRZURvyCtMsJVyxR86yZBBbSYeeWNm7YCmT6',

  // CPMM Pools
  SOL_USDC_CPMM: '7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny',

  // AMM V4 Pools
  SOL_USDC_AMM: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
  RAY_USDC_AMM: '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg',
};
```

---

## Fee Configurations

### CLMM Fee Tiers

| Tier | Trade Fee | Protocol Fee | Fund Fee |
|------|-----------|--------------|----------|
| 0.01% | 100 | 12000 | 0 |
| 0.05% | 500 | 12000 | 0 |
| 0.25% | 2500 | 12000 | 0 |
| 1% | 10000 | 12000 | 0 |

### CPMM Fee Config

```typescript
// Fetch available fee configs
const feeConfigs = await raydium.api.getCpmmConfigs();

// Common config structure
interface FeeConfig {
  id: string;
  tradeFeeRate: number;      // e.g., 2500 = 0.25%
  protocolFeeRate: number;
  fundFeeRate: number;
  createPoolFee: string;     // Lamports required
}
```

---

## RPC Requirements

```typescript
// Recommended RPC providers for Raydium
const RPC_ENDPOINTS = {
  // Free (rate limited)
  SOLANA_MAINNET: 'https://api.mainnet-beta.solana.com',
  SOLANA_DEVNET: 'https://api.devnet.solana.com',

  // Paid (recommended for production)
  HELIUS: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
  QUICKNODE: 'https://YOUR_ENDPOINT.solana-mainnet.quiknode.pro/YOUR_KEY',
  TRITON: 'https://YOUR_PROJECT.triton.one',
};

// Connection config
const connection = new Connection(RPC_ENDPOINT, {
  commitment: 'confirmed',
  wsEndpoint: WS_ENDPOINT, // Optional for subscriptions
});
```

---

## IDL Package

```bash
yarn add @raydium-io/raydium-idl
```

```typescript
import { IDL as AmmIdl } from '@raydium-io/raydium-idl/amm';
import { IDL as ClmmIdl } from '@raydium-io/raydium-idl/clmm';
import { IDL as CpmmIdl } from '@raydium-io/raydium-idl/cpmm';
```

---

## Version Requirements

| Package | Version |
|---------|---------|
| `@raydium-io/raydium-sdk-v2` | Latest |
| `@solana/web3.js` | ^1.95.0 |
| `@coral-xyz/anchor` | ^0.29.0 |
| Node.js | 18+ |

```json
{
  "dependencies": {
    "@raydium-io/raydium-sdk-v2": "latest",
    "@solana/web3.js": "^1.95.0",
    "@coral-xyz/anchor": "^0.29.0",
    "decimal.js": "^10.4.3",
    "bn.js": "^5.2.1"
  }
}
```
