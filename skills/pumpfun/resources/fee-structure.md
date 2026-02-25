# PumpFun Fee Structure Reference

Complete reference for PumpFun's dynamic fee system.

## Fee Program

- **Program ID**: `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`

## Fee Components

### Bonding Curve Fees

| Fee Type | Default | Description |
|----------|---------|-------------|
| Protocol Fee | 1% (100 bps) | Goes to fee recipient |
| Creator Fee | Variable | Goes to token creator |

### PumpSwap AMM Fees

| Fee Type | Default | Description |
|----------|---------|-------------|
| LP Fee | 0.2% (20 bps) | Goes to liquidity providers |
| Protocol Fee | 0.05% (5 bps) | Distributed to 8 recipients |
| Creator Fee | Variable | Goes to coin creator |

## Dynamic Fee Tiers

Fees are calculated based on market capitalization in lamports.

### Market Cap Calculation

**For Bonding Curves:**
```typescript
marketCap = (virtualSolReserves * mintSupply) / virtualTokenReserves
```

**For AMM Pools:**
```typescript
marketCap = (quoteReserve * baseMintSupply) / baseReserve
```

### Fee Tier Structure

```typescript
interface FeeTier {
  marketCapLamportsThreshold: u64;
  fees: {
    lpFeeBps: u16;
    protocolFeeBps: u16;
    creatorFeeBps: u16;
  };
}
```

### Getting Current Fees

```typescript
import { Connection, PublicKey } from '@solana/web3.js';

async function getCurrentFees(
  connection: Connection,
  poolOrBondingCurve: PublicKey,
  isPool: boolean
): Promise<Fees> {
  const PUMP_FEES_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

  // Fetch fee config
  const [feeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config')],
    PUMP_FEES_PROGRAM
  );

  // Calculate market cap and determine tier
  // ... implementation depends on account data
}
```

## Fee Sharing Configuration

### SharingConfig Account

```typescript
interface SharingConfig {
  bump: u8;
  status: ShareStatus;      // Active or Paused
  mint: PublicKey;          // Token mint
  admin: PublicKey;         // Config admin
  adminRevoked: boolean;    // Admin revoked flag
  shareholders: Shareholder[];
}

interface Shareholder {
  address: PublicKey;
  shareBps: u16;  // Share in basis points
}
```

**Note**: Total shareholder shares must equal 10,000 bps (100%)

### Creating Fee Sharing Config

```typescript
async function createFeeSharingConfig(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  shareholders: Array<{ address: PublicKey; shareBps: number }>
) {
  // Validate shares sum to 10000
  const totalShares = shareholders.reduce((sum, s) => sum + s.shareBps, 0);
  if (totalShares !== 10000) {
    throw new Error('Shares must sum to 10000 bps');
  }

  // Build create_fee_sharing_config instruction
  // ...
}
```

### Updating Fee Shares

```typescript
async function updateFeeShares(
  connection: Connection,
  admin: Keypair,
  mint: PublicKey,
  newShareholders: Shareholder[]
) {
  // Note: This will distribute any accumulated fees before updating
  // Build update_fee_shares instruction
  // ...
}
```

## Creator Fee Collection

### From Bonding Curve

Creator fees accumulate in a vault PDA:
```typescript
seeds: ["creator-vault", creator.toBuffer()]
```

**Collect fees:**
```typescript
async function collectBondingCurveCreatorFee(
  connection: Connection,
  creator: Keypair
): Promise<string> {
  const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

  const [creatorVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.publicKey.toBuffer()],
    PUMP_PROGRAM
  );

  // Build collect_creator_fee instruction
  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([/* collect_creator_fee discriminator */]),
  });

  // Send transaction
  // ...
}
```

### From PumpSwap Pool

Creator fees accumulate in a token account:
```typescript
// Creator vault authority PDA
seeds: ["creator_vault", coinCreator.toBuffer()]

// Creator vault ATA (for quote token, usually WSOL)
getAssociatedTokenAddress(quoteMint, creatorVaultAuthority, true)
```

**Collect fees:**
```typescript
async function collectPoolCreatorFee(
  connection: Connection,
  coinCreator: Keypair,
  pool: PublicKey
): Promise<string> {
  const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

  // Get pool data for quote mint
  const poolData = await fetchPoolData(connection, pool);

  const [creatorVaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), coinCreator.publicKey.toBuffer()],
    PUMP_AMM
  );

  const creatorVaultAta = getAssociatedTokenAddressSync(
    poolData.quoteMint,
    creatorVaultAuthority,
    true
  );

  // Build collect_coin_creator_fee instruction
  // ...
}
```

## Fee Distribution Flow

### Bonding Curve Trade
```
User pays SOL
    ↓
Protocol fee → Fee Recipient
Creator fee → Creator Vault
Net SOL → Bonding Curve reserves
```

### PumpSwap Trade
```
User pays quote tokens
    ↓
LP fee → Pool reserves (for LPs)
Protocol fee → 8 Protocol Recipients (load balanced)
Creator fee → Creator Vault ATA
Net amount → Swap output
```

## Mayhem Mode Fees

When `isMayhemMode = true`, fees go to special Mayhem fee recipients:

```typescript
const MAYHEM_FEE_RECIPIENTS = [
  'DzPPWKfYYMuHxR98xhPkYSp7KHsLpcLZU8tHCqXjC3HG',
  '5AbGBKS6NHKcTFyJaZCk3dbMRNFG3y6kkN4y7Rp3iHCk',
  'DWM9EuZ3e9cRYdHYRKwsCqXFKgn4jUNkUPEAyNE2Dxnc',
  '9BUPJ65gFVaGQKyXiR6xSE1DdLRqkUMv9HJvL8wGfJaL',
];

function getMayhemFeeRecipient(): PublicKey {
  const index = Math.floor(Math.random() * MAYHEM_FEE_RECIPIENTS.length);
  return new PublicKey(MAYHEM_FEE_RECIPIENTS[index]);
}
```

## Required Accounts for Trades

Since September 2025, all buy/sell operations require fee config accounts:

```typescript
// Required accounts at end of buy/sell instruction
{ pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
{ pubkey: feeConfigPDA, isSigner: false, isWritable: false },
```

## Best Practices

1. **Always include fee accounts** in buy/sell transactions
2. **Check Mayhem mode** before setting fee recipient
3. **Increase slippage** if fee tiers change frequently
4. **Collect fees regularly** to avoid large accumulated amounts
5. **Validate shareholder shares** sum to exactly 10,000 bps
