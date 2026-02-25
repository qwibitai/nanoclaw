# Marginfi Program Addresses

Reference for Marginfi program and account addresses.

## Environment Configurations

### Production (Mainnet)

| Type | Address | Description |
|------|---------|-------------|
| Program | `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` | Marginfi lending program |
| Group | `4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8` | Production lending group |

### Alpha (Mainnet)

| Type | Address | Description |
|------|---------|-------------|
| Program | `yyyxaNHJP5FiDhmQW8RkBkp1jTL2cyxJmhMdWpJfsiy` | Alpha program |
| Group | `7xNRPf4qqgDAkvDEgkRuC4SevR1RUxzosoRb7GsaVsqa` | Alpha lending group |

### Staging

| Type | Address | Description |
|------|---------|-------------|
| Program | `stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct` | Staging program |
| Group | `FCPfpHA69EbS8f9KKSreTRkXbzFpunsKuYf5qNmnJjpo` | Staging lending group |

### Dev

| Type | Address | Description |
|------|---------|-------------|
| Program | `A7vUDErNPCTt9qrB6SSM4F6GkxzUe9d8P3cXSmRg4eY4` | Development program |
| Group | `52NC7T3NTPFFwoxJDFk9mbKcA7675DJ39H1iPNz5RjSV` | Development lending group |

## SDK Constants

### PDA Seeds

| Constant | Value | Description |
|----------|-------|-------------|
| `PDA_BANK_LIQUIDITY_VAULT_AUTH_SEED` | `"liquidity_vault_auth"` | Seed for liquidity vault authority PDA |
| `PDA_BANK_INSURANCE_VAULT_AUTH_SEED` | `"insurance_vault_auth"` | Seed for insurance vault authority PDA |
| `PDA_BANK_FEE_VAULT_AUTH_SEED` | `"fee_vault_auth"` | Seed for fee vault authority PDA |
| `PDA_BANK_LIQUIDITY_VAULT_SEED` | `Buffer.from("liquidity_vault")` | Seed for liquidity vault PDA |
| `PDA_BANK_INSURANCE_VAULT_SEED` | `Buffer.from("insurance_vault")` | Seed for insurance vault PDA |
| `PDA_BANK_FEE_VAULT_SEED` | `Buffer.from("fee_vault")` | Seed for fee vault PDA |
### Address Lookup Tables

The SDK maintains address lookup tables for each group to optimize transaction size:

```typescript
import { ADDRESS_LOOKUP_TABLE_FOR_GROUP } from "@mrgnlabs/marginfi-client-v2";

const ADDRESS_LOOKUP_TABLE_FOR_GROUP: { [key: string]: PublicKey[] } = {
  "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8": [ // Marginfi production group
    new PublicKey("BrWF8J3CEuHaXsWk3kqGZ6VHvRp4SJuG9AzvB6ei2kbV"),
    new PublicKey("8GLUprtyzv6HGrgox7F43EQM5GqE2uKrAHLs69r8DgRj"),
  ], // Main pool
  FCPfpHA69EbS8f9KKSreTRkXbzFpunsKuYf5qNmnJjpo: [new PublicKey("HxPy7b58KLKSU7w4LUW9xwYQ1NPyRNQkYYk2f7SmYAip")], // staging
};
```

## Looking Up Bank Addresses

Banks are dynamically created and managed per group. Use the SDK to discover them:

```typescript
import { MarginfiClient, getConfig } from "@mrgnlabs/marginfi-client-v2";

const client = await MarginfiClient.fetch(config, wallet, connection);

// Get bank by token symbol
const solBank = client.getBankByTokenSymbol("SOL");
console.log("SOL Bank:", solBank?.address.toBase58());

// Get bank by mint address
const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const usdcBank = client.getBankByMint(usdcMint);

// Get bank by public key
const bankPk = new PublicKey("...");
const bank = client.getBankByPk(bankPk);

// Iterate all banks
for (const [address, bank] of client.banks) {
  console.log(`${bank.tokenSymbol}: ${address}`);
}
```

## Oracle Program IDs

| Oracle | Program ID | Description |
|--------|------------|-------------|
| Pyth Push Oracle | `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` | Pyth push oracle program |

## Common Token Mints

These are common tokens supported by Marginfi banks:

| Token | Mint | Decimals |
|-------|------|----------|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| Wrapped SOL | `So11111111111111111111111111111111111111112` | 9 |
| JitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` | 9 |
| mSOL | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` | 9 |