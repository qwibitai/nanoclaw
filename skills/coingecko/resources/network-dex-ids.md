# Solana Network and DEX Identifiers

Reference for CoinGecko network and DEX identifiers used in API requests.

## Network ID

| Network | ID | Description |
|---------|-----|-------------|
| Solana | `solana` | Main Solana network |

## Solana DEX Identifiers

| DEX | ID | Description |
|-----|-----|-------------|
| Raydium | `raydium` | Leading AMM and liquidity protocol |
| Raydium V3 | `raydium-clmm` | Concentrated liquidity AMM |
| Orca | `orca` | User-friendly DEX with Whirlpools |
| Orca Whirlpools | `orca-whirlpools` | Concentrated liquidity pools |
| Jupiter | `jupiter` | DEX aggregator with pools |
| Meteora | `meteora` | Dynamic AMM protocol |
| Meteora DLMM | `meteora-dlmm` | Dynamic liquidity market maker |
| Pump.fun | `pump-fun` | Memecoin launchpad |
| OpenBook | `openbook` | On-chain order book (Serum successor) |
| Lifinity | `lifinity` | Proactive market maker |
| Phoenix | `phoenix` | On-chain order book DEX |
| GooseFX | `goosefx` | DeFi suite with AMM |
| Saber | `saber` | Stablecoin AMM |
| Aldrin | `aldrin` | AMM with yield farming |
| Crema | `crema` | Concentrated liquidity protocol |
| Cropper | `cropper` | AMM and yield optimizer |
| Dooar | `dooar` | Stepn ecosystem DEX |
| FluxBeam | `fluxbeam` | Token launchpad |
| Invariant | `invariant` | Concentrated liquidity DEX |
| Marinade | `marinade` | Liquid staking DEX pools |
| Obric | `obric` | AMM protocol |
| Penguin | `penguin` | DEX protocol |
| Perps | `perps` | Perpetuals DEX |
| Saros | `saros` | DeFi super-app AMM |
| Sentre | `sentre` | Open liquidity protocol |
| Step | `step` | Portfolio tracker DEX |
| Symmetry | `symmetry` | Index fund protocol |

## Common DEX Combinations

### High Volume DEXes
```typescript
const HIGH_VOLUME_DEXES = ['raydium', 'orca', 'jupiter', 'meteora'];
```

### Memecoin/Launchpad DEXes
```typescript
const MEMECOIN_DEXES = ['pump-fun', 'raydium'];
```

### Concentrated Liquidity DEXes
```typescript
const CL_DEXES = ['raydium-clmm', 'orca-whirlpools', 'meteora-dlmm'];
```

### Order Book DEXes
```typescript
const ORDERBOOK_DEXES = ['openbook', 'phoenix'];
```

## Usage Example

```typescript
// Filter pools by DEX
const url = `${BASE_URL}/pools/megafilter?networks=solana&dexes=raydium,orca`;

// Get all DEXes on Solana
const dexesUrl = `${BASE_URL}/networks/solana/dexes`;
```

## Notes

- DEX IDs are case-sensitive and lowercase
- New DEXes are added as they gain traction
- Some DEXes have multiple versions (e.g., Raydium, Raydium CLMM)
- Use the `/networks/{network}/dexes` endpoint for the latest list
