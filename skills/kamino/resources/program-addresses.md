# Kamino Program Addresses

Reference for all Kamino program and account addresses.

## Mainnet Addresses

### Core Programs

| Program | Address | Description |
|---------|---------|-------------|
| Kamino Lending | `KLend2g3cP87ber41qQDzWpAFuqP2tCxDqC8S3k7L1U` | Main lending program |
| Kamino Liquidity | `6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc` | Liquidity management program |
| Scope Oracle | `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ` | Oracle aggregator |

### Lending Markets

| Market | Address | Description |
|--------|---------|-------------|
| Main Market | `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` | Primary lending market |
| JLP Market | `DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek` | JLP-focused market |
| Altcoin Market | `ByYiZxp8QrdN9qbdtaAiePN8AAr3qvTPppNJDpf5DVJ5` | Altcoin market |

### Reserve Addresses (Main Market)

| Token | Reserve Address | cToken Mint |
|-------|-----------------|-------------|
| SOL | `d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q` | Check on-chain |
| USDC | `D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59` | Check on-chain |
| USDT | `H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S` | Check on-chain |
| mSOL | `H6rHXmXoCQvq8Ue81MqNh4ovFYnWLCqF6Lpuqs1CY8qK` | Check on-chain |
| JitoSOL | `EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW` | Check on-chain |
| BONK | `CoFdsnQeCUyJefhKK6GQaAPT9PEx8Xcs2jejtp9jgn38` | Check on-chain |

### Scope Configuration

| Config | Address |
|--------|---------|
| Scope Config (Mainnet) | `3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C` |
| Oracle Prices Account | Check config for latest |

## Devnet Addresses

### Core Programs

| Program | Address |
|---------|---------|
| Kamino Lending | `KLend2g3cP87ber41qQDzWpAFuqP2tCxDqC8S3k7L1U` |
| Kamino Liquidity | `6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc` |

### Test Markets

| Market | Address |
|--------|---------|
| Devnet Test Market | Check Kamino Discord for latest |

## External Program Dependencies

### DEX Programs

| DEX | Program Address |
|-----|-----------------|
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |

### Oracle Programs

| Oracle | Program Address |
|--------|-----------------|
| Pyth | `FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH` |
| Switchboard | `SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f` |

### Token Programs

| Program | Address |
|---------|---------|
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Associated Token | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |

### System Programs

| Program | Address |
|---------|---------|
| System Program | `11111111111111111111111111111111` |
| Rent Sysvar | `SysvarRent111111111111111111111111111111111` |
| Clock Sysvar | `SysvarC1ock11111111111111111111111111111111` |

## Common Token Mints

| Token | Mint Address |
|-------|--------------|
| SOL (Wrapped) | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| mSOL | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` |
| JitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| JTO | `jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL` |
| RAY | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` |
| ORCA | `orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE` |

## PDA Seeds

### Lending PDAs

```typescript
// Obligation PDA
const [obligationPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("obligation"),
    lendingMarket.toBuffer(),
    owner.toBuffer(),
    obligationId.toBuffer(), // For vanilla: Buffer.alloc(1)
  ],
  LENDING_PROGRAM_ID
);

// Reserve Collateral Mint PDA
const [collateralMintPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("collateral_mint"),
    reserve.toBuffer(),
  ],
  LENDING_PROGRAM_ID
);

// Reserve Liquidity Supply PDA
const [liquiditySupplyPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("liquidity_supply"),
    reserve.toBuffer(),
  ],
  LENDING_PROGRAM_ID
);
```

### Liquidity PDAs

```typescript
// Strategy Account PDA
const [strategyPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("strategy"),
    globalConfig.toBuffer(),
    strategyId.toBuffer(),
  ],
  LIQUIDITY_PROGRAM_ID
);

// Position PDA
const [positionPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("position"),
    strategy.toBuffer(),
  ],
  LIQUIDITY_PROGRAM_ID
);
```

## Lookup Tables

Kamino uses Address Lookup Tables for transaction optimization:

| Purpose | Address |
|---------|---------|
| Main Lending LUT | Check market config |
| Liquidity LUT | Check strategy config |

### Using Lookup Tables

```typescript
// Fetch lookup table
const lookupTableAccount = await connection.getAddressLookupTable(lookupTableAddress);

// Create versioned transaction
const messageV0 = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: blockhash,
  instructions,
}).compileToV0Message([lookupTableAccount.value]);

const tx = new VersionedTransaction(messageV0);
```

## Verification

Always verify addresses on-chain:

```typescript
import { KaminoMarket } from "@kamino-finance/klend-sdk";

// Load and verify market
const market = await KaminoMarket.load(connection, MAIN_MARKET);
console.log("Market address:", market.address.toString());
console.log("Lending program:", PROGRAM_ID.toString());

// Check reserve addresses
for (const [key, reserve] of market.reserves) {
  console.log(`${reserve.stats.symbol}:`, key);
}
```
