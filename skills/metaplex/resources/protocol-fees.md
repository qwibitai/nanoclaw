# Metaplex Protocol Fees

Complete fee schedule for Metaplex programs on Solana.

## Fee Overview

All protocol fees support the Metaplex Foundation's nonprofit mission:
- **50%** converts to $MPLX tokens for DAO treasury
- **50%** supports long-term ecosystem sustainability

## Fee Schedule by Program

### MPL Core

| Operation | Fee |
|-----------|-----|
| Create Asset | 0.0015 SOL |
| Execute | 0.00004872 SOL |

### Token Metadata

| Operation | Fee |
|-----------|-----|
| Create | 0.01 SOL |

### Bubblegum v2

| Operation | Fee |
|-----------|-----|
| Create (Mint) | 0.00009 SOL |
| Transfer | 0.000006 SOL |

### Bubblegum v1 (Legacy)

| Operation | Fee |
|-----------|-----|
| Create | Free |

### Genesis (Token Launches)

| Launch Type | Operation | Fee |
|-------------|-----------|-----|
| **Launch Pool** | Deposit | 2% |
| **Launch Pool** | Withdraw | 2% |
| **Launch Pool** | Graduation | 5% |
| **Presale** | Deposit | 2% |
| **Presale** | Graduation | 5% |

### MPL-Hybrid

| Operation | Fee |
|-----------|-----|
| Swap (NFT ↔ Token) | 0.005 SOL |

### Fusion/Trifle

| Operation | Fee |
|-----------|-----|
| Combine | 0.002 SOL |
| Split | 0.002 SOL |
| Edit Constraint | 0.01 SOL |

## Cost Comparison by Standard

### Per-NFT Minting Cost

| Standard | Approximate Cost |
|----------|------------------|
| MPL Core | ~0.0029 SOL |
| Bubblegum v2 (cNFT) | ~0.00009 SOL |
| Token Metadata | ~0.022 SOL |
| Token Extensions | ~0.0046 SOL |

### Collection Cost Examples

| Collection Size | Core | Bubblegum | Token Metadata |
|-----------------|------|-----------|----------------|
| 100 NFTs | ~0.29 SOL | ~0.01 SOL | ~2.2 SOL |
| 1,000 NFTs | ~2.9 SOL | ~0.09 SOL | ~22 SOL |
| 10,000 NFTs | ~29 SOL | ~0.9 SOL | ~220 SOL |
| 100,000 NFTs | ~290 SOL | ~9 SOL | ~2,200 SOL |
| 1,000,000 NFTs | ~2,900 SOL | ~90 SOL | ~22,000 SOL |

### Bubblegum Tree Costs

Tree creation cost varies by max depth (capacity):

| Max Depth | Capacity | Approx. Tree Cost |
|-----------|----------|-------------------|
| 14 | 16,384 | ~1.1 SOL |
| 17 | 131,072 | ~4.5 SOL |
| 20 | 1,048,576 | ~36 SOL |
| 24 | 16,777,216 | ~145 SOL |
| 30 | 1,073,741,824 | ~2,300 SOL |

## Compute Unit Usage

| Operation | Compute Units |
|-----------|---------------|
| Core Create | ~17,000 CU |
| Token Metadata Create | ~205,000 CU |
| Bubblegum Mint | ~50,000 CU |

Lower CU = more transactions per block = faster confirmation.

## Fee Payment

Fees are automatically included in transactions. No separate payment required.

```typescript
// Fee is automatically deducted during create
await create(umi, {
  asset,
  name: 'My NFT',
  uri: metadataUri,
}).sendAndConfirm(umi);
// Protocol fee (0.0015 SOL for Core) is deducted
```

## Fee Changes

The Metaplex Foundation may adjust fees based on:
- Community feedback
- Network conditions
- Ecosystem growth needs

Always check current fees at [developers.metaplex.com/protocol-fees](https://developers.metaplex.com/protocol-fees).

## Rent Costs (Separate from Fees)

Account rent is separate from protocol fees:

| Account Type | Rent |
|--------------|------|
| Mint Account | ~0.00144 SOL |
| Token Account | ~0.00203 SOL |
| Metadata Account | ~0.005-0.01 SOL |
| Master Edition | ~0.00282 SOL |

Rent is refundable when accounts are closed.
