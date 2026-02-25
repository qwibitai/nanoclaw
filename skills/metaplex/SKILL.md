---
name: metaplex
description: Complete Metaplex Protocol guide for Solana NFTs and digital assets. Covers Core (next-gen NFTs), Token Metadata, Bubblegum (compressed NFTs), Candy Machine, Genesis (token launches), MPL-Hybrid, Inscriptions, DAS API, and the Umi framework. The single source of truth for all Metaplex integrations.
---

# Metaplex Protocol Development Guide

A comprehensive guide for building NFTs, digital assets, and token launches on Solana using the Metaplex Protocol - the industry standard powering 99% of Solana NFTs and tokens.

## What is Metaplex?

Metaplex is the leading tokenization protocol on Solana, providing smart contracts and tools for creating, selling, and managing digital assets. From simple NFTs to compressed collections of billions, from fair token launches to hybrid token/NFT systems, Metaplex provides the infrastructure.

### Key Statistics

- **99%** of Solana NFTs use Metaplex standards
- **$10B+** in transaction value facilitated
- **78%** of Solana NFTs minted via Candy Machine (as of 2022)
- **Billions** of compressed NFTs possible at minimal cost

## Overview

Metaplex provides multiple products for different use cases:

### NFT Standards

| Product | Description | Cost per Mint |
|---------|-------------|---------------|
| **Core** | Next-gen single-account NFT standard | ~0.0029 SOL |
| **Token Metadata** | Original NFT standard with PDAs | ~0.022 SOL |
| **Bubblegum v2** | Compressed NFTs (cNFTs) | ~0.00009 SOL |

### Launch & Distribution

| Product | Description |
|---------|-------------|
| **Candy Machine** | NFT collection minting with guards |
| **Core Candy Machine** | Candy Machine for Core assets |
| **Genesis** | Token Generation Event (TGE) platform |

### Utilities

| Product | Description |
|---------|-------------|
| **MPL-Hybrid** | Swap between fungible and non-fungible |
| **Inscriptions** | On-chain data storage (up to 10MB) |
| **DAS API** | Unified API for fetching digital assets |
| **Umi** | JavaScript framework for Solana clients |

---

## Program IDs

### Core Programs (Mainnet & Devnet)

| Program | Address |
|---------|---------|
| **MPL Core** | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |
| **Token Metadata** | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |
| **Bubblegum** | `BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY` |
| **Candy Machine V3** | `CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR` |
| **Candy Guard** | `Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g` |
| **Core Candy Machine** | `CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J` |
| **Core Candy Guard** | `CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ` |
| **MPL Hybrid** | `MPL4o4wMzndgh8T1NVDxELQCj5UQfYTYEkabX3wNKtb` |
| **Inscription** | `1NSCRfGeyo7wPUazGbaPBUsTM49e1k2aXewHGARfzSo` |

### SPL Programs (Required)

| Program | Address |
|---------|---------|
| **SPL Token** | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| **Token 2022** | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| **Associated Token** | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| **Account Compression** | `cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK` |

---

## Quick Start

### Installation

```bash
# Core NFTs (Recommended for new projects)
npm install @metaplex-foundation/mpl-core \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults

# Token Metadata NFTs
npm install @metaplex-foundation/mpl-token-metadata \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults

# Compressed NFTs (Bubblegum)
npm install @metaplex-foundation/mpl-bubblegum \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults

# Candy Machine
npm install @metaplex-foundation/mpl-candy-machine \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults

# Core Candy Machine
npm install @metaplex-foundation/mpl-core-candy-machine \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults

# Genesis (Token Launches)
npm install @metaplex-foundation/mpl-genesis \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults

# File uploads (Arweave via Irys)
npm install @metaplex-foundation/umi-uploader-irys
```

### Umi Setup

All Metaplex SDKs use Umi, a modular Solana framework:

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore } from '@metaplex-foundation/mpl-core';
import {
  keypairIdentity,
  generateSigner
} from '@metaplex-foundation/umi';

// Create Umi instance
const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(mplCore());

// Option 1: Use generated keypair
const signer = generateSigner(umi);
umi.use(keypairIdentity(signer));

// Option 2: Use existing keypair
import { createSignerFromKeypair } from '@metaplex-foundation/umi';
const keypair = umi.eddsa.createKeypairFromSecretKey(secretKeyBytes);
const signer = createSignerFromKeypair(umi, keypair);
umi.use(keypairIdentity(signer));

// Option 3: Use wallet adapter (browser)
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters';
umi.use(walletAdapterIdentity(wallet));
```

---

## MPL Core (Recommended)

The next-generation NFT standard with single-account design, lower costs, and built-in plugins.

### Why Core?

| Feature | Core | Token Metadata |
|---------|------|----------------|
| Accounts per NFT | 1 | 4+ |
| Mint Cost | ~0.0029 SOL | ~0.022 SOL |
| Compute Units | ~17,000 | ~205,000 |
| Enforced Royalties | Yes | No |
| Plugin System | Yes | No |

### Create a Core NFT

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplCore,
  create,
  fetchAsset
} from '@metaplex-foundation/mpl-core';
import {
  generateSigner,
  keypairIdentity
} from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';

// Setup
const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(mplCore())
  .use(irysUploader());

// Upload metadata
const metadata = {
  name: 'My Core NFT',
  description: 'A next-gen NFT on Solana',
  image: 'https://arweave.net/your-image',
  attributes: [
    { trait_type: 'Background', value: 'Blue' },
    { trait_type: 'Rarity', value: 'Legendary' }
  ]
};
const metadataUri = await umi.uploader.uploadJson(metadata);

// Create NFT
const asset = generateSigner(umi);
await create(umi, {
  asset,
  name: 'My Core NFT',
  uri: metadataUri,
}).sendAndConfirm(umi);

console.log('Asset created:', asset.publicKey);

// Fetch the asset
const fetchedAsset = await fetchAsset(umi, asset.publicKey);
console.log('Asset data:', fetchedAsset);
```

### Core with Plugins

```typescript
import {
  create,
  ruleSet,
  plugin,
} from '@metaplex-foundation/mpl-core';

// Create with royalty enforcement
await create(umi, {
  asset,
  name: 'Royalty Enforced NFT',
  uri: metadataUri,
  plugins: [
    {
      type: 'Royalties',
      basisPoints: 500, // 5%
      creators: [
        { address: creatorAddress, percentage: 100 }
      ],
      ruleSet: ruleSet('None'), // or 'ProgramAllowList', 'ProgramDenyList'
    },
    {
      type: 'FreezeDelegate',
      frozen: false,
      authority: { type: 'Owner' },
    },
    {
      type: 'TransferDelegate',
      authority: { type: 'Owner' },
    },
  ],
}).sendAndConfirm(umi);
```

### Core Collections

```typescript
import {
  createCollection,
  create,
  fetchCollection,
} from '@metaplex-foundation/mpl-core';

// Create collection
const collection = generateSigner(umi);
await createCollection(umi, {
  collection,
  name: 'My Collection',
  uri: collectionUri,
}).sendAndConfirm(umi);

// Create asset in collection
const asset = generateSigner(umi);
await create(umi, {
  asset,
  name: 'Collection Item #1',
  uri: assetUri,
  collection: collection.publicKey,
}).sendAndConfirm(umi);
```

### Transfer & Burn

```typescript
import { transfer, burn } from '@metaplex-foundation/mpl-core';

// Transfer
await transfer(umi, {
  asset: assetPublicKey,
  newOwner: recipientPublicKey,
}).sendAndConfirm(umi);

// Burn
await burn(umi, {
  asset: assetPublicKey,
}).sendAndConfirm(umi);
```

---

## Token Metadata

The original Solana NFT standard using Program Derived Addresses (PDAs).

### Create NFT with Token Metadata

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplTokenMetadata,
  createNft,
  fetchDigitalAsset,
} from '@metaplex-foundation/mpl-token-metadata';
import { generateSigner, percentAmount } from '@metaplex-foundation/umi';

const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(mplTokenMetadata());

// Create NFT
const mint = generateSigner(umi);
await createNft(umi, {
  mint,
  name: 'My NFT',
  symbol: 'MNFT',
  uri: 'https://arweave.net/metadata.json',
  sellerFeeBasisPoints: percentAmount(5.5), // 5.5% royalty
  creators: [
    { address: umi.identity.publicKey, share: 100, verified: true }
  ],
}).sendAndConfirm(umi);

// Fetch NFT
const asset = await fetchDigitalAsset(umi, mint.publicKey);
console.log(asset);
```

### Create Programmable NFT (pNFT)

```typescript
import {
  createProgrammableNft,
  TokenStandard,
} from '@metaplex-foundation/mpl-token-metadata';

// pNFTs have enforced royalties
const mint = generateSigner(umi);
await createProgrammableNft(umi, {
  mint,
  name: 'My pNFT',
  uri: metadataUri,
  sellerFeeBasisPoints: percentAmount(10), // 10% royalty
  ruleSet: ruleSetPublicKey, // Optional: custom rules
}).sendAndConfirm(umi);
```

### Create Fungible Token with Metadata

```typescript
import {
  createFungible,
  mintV1,
  TokenStandard,
} from '@metaplex-foundation/mpl-token-metadata';

// Create fungible token
const mint = generateSigner(umi);
await createFungible(umi, {
  mint,
  name: 'My Token',
  symbol: 'MTK',
  uri: 'https://arweave.net/token-metadata.json',
  sellerFeeBasisPoints: percentAmount(0),
  decimals: 9,
}).sendAndConfirm(umi);

// Mint tokens
await mintV1(umi, {
  mint: mint.publicKey,
  amount: 1_000_000_000n, // 1 token with 9 decimals
  tokenOwner: recipientPublicKey,
  tokenStandard: TokenStandard.Fungible,
}).sendAndConfirm(umi);
```

### Update Metadata

```typescript
import { updateV1 } from '@metaplex-foundation/mpl-token-metadata';

await updateV1(umi, {
  mint: mintPublicKey,
  data: {
    name: 'Updated Name',
    symbol: 'UPDT',
    uri: 'https://arweave.net/new-metadata.json',
    sellerFeeBasisPoints: 500,
    creators: null, // Keep existing
  },
}).sendAndConfirm(umi);
```

---

## Bubblegum (Compressed NFTs)

Create billions of NFTs at minimal cost using Merkle tree compression.

### Cost Comparison

| Collection Size | Bubblegum Cost | Token Metadata Cost |
|-----------------|----------------|---------------------|
| 10,000 | ~0.27 SOL | ~220 SOL |
| 1,000,000 | ~50 SOL | ~22,000 SOL |
| 1,000,000,000 | ~5,007 SOL | ~22,000,000 SOL |

### Create Merkle Tree

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplBubblegum,
  createTree,
} from '@metaplex-foundation/mpl-bubblegum';
import { generateSigner } from '@metaplex-foundation/umi';

const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(mplBubblegum());

// Create tree (max depth determines capacity)
// maxDepth 14 = 16,384 NFTs, maxDepth 20 = 1,048,576 NFTs
const merkleTree = generateSigner(umi);
await createTree(umi, {
  merkleTree,
  maxDepth: 14,
  maxBufferSize: 64,
}).sendAndConfirm(umi);

console.log('Tree created:', merkleTree.publicKey);
```

### Mint Compressed NFT

```typescript
import { mintV1 } from '@metaplex-foundation/mpl-bubblegum';

await mintV1(umi, {
  leafOwner: recipientPublicKey,
  merkleTree: merkleTreePublicKey,
  metadata: {
    name: 'Compressed NFT #1',
    symbol: 'CNFT',
    uri: 'https://arweave.net/metadata.json',
    sellerFeeBasisPoints: 500,
    collection: { key: collectionMint, verified: false },
    creators: [
      { address: umi.identity.publicKey, share: 100, verified: true }
    ],
  },
}).sendAndConfirm(umi);
```

### Mint to Collection

```typescript
import { mintToCollectionV1 } from '@metaplex-foundation/mpl-bubblegum';

await mintToCollectionV1(umi, {
  leafOwner: recipientPublicKey,
  merkleTree: merkleTreePublicKey,
  collectionMint: collectionMintPublicKey,
  metadata: {
    name: 'Collection cNFT #1',
    symbol: 'CCNFT',
    uri: metadataUri,
    sellerFeeBasisPoints: 500,
    creators: [
      { address: umi.identity.publicKey, share: 100, verified: true }
    ],
  },
}).sendAndConfirm(umi);
```

### Transfer Compressed NFT

```typescript
import { transfer } from '@metaplex-foundation/mpl-bubblegum';
import { getAssetWithProof } from '@metaplex-foundation/mpl-bubblegum';

// Get asset with proof from DAS API
const assetWithProof = await getAssetWithProof(umi, assetId);

await transfer(umi, {
  ...assetWithProof,
  leafOwner: currentOwner,
  newLeafOwner: newOwner,
}).sendAndConfirm(umi);
```

### Decompress to Regular NFT

```typescript
import { decompressV1 } from '@metaplex-foundation/mpl-bubblegum';

// Decompress creates on-chain Token Metadata NFT
await decompressV1(umi, {
  ...assetWithProof,
  mint: mintSigner,
}).sendAndConfirm(umi);
```

---

## Candy Machine

The leading NFT minting system for fair collection launches.

### Create Candy Machine

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplCandyMachine,
  create,
  addConfigLines,
} from '@metaplex-foundation/mpl-candy-machine';
import { generateSigner, some, sol, dateTime } from '@metaplex-foundation/umi';

const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(mplCandyMachine());

// Create candy machine
const candyMachine = generateSigner(umi);
const collection = generateSigner(umi);

await create(umi, {
  candyMachine,
  collection: collection.publicKey,
  collectionUpdateAuthority: umi.identity,
  itemsAvailable: 1000,
  sellerFeeBasisPoints: percentAmount(5),
  creators: [
    { address: umi.identity.publicKey, percentageShare: 100, verified: true }
  ],
  configLineSettings: some({
    prefixName: 'My NFT #',
    nameLength: 4,
    prefixUri: 'https://arweave.net/',
    uriLength: 43,
    isSequential: false,
  }),
  guards: {
    botTax: some({ lamports: sol(0.01), lastInstruction: true }),
    solPayment: some({ lamports: sol(0.5), destination: treasury }),
    startDate: some({ date: dateTime('2024-01-01T00:00:00Z') }),
    mintLimit: some({ id: 1, limit: 3 }),
  },
}).sendAndConfirm(umi);
```

### Add Items to Candy Machine

```typescript
await addConfigLines(umi, {
  candyMachine: candyMachine.publicKey,
  index: 0,
  configLines: [
    { name: '0001', uri: 'abc123...' },
    { name: '0002', uri: 'def456...' },
    { name: '0003', uri: 'ghi789...' },
  ],
}).sendAndConfirm(umi);
```

### Mint from Candy Machine

```typescript
import {
  mintV1,
  fetchCandyMachine,
  fetchCandyGuard,
} from '@metaplex-foundation/mpl-candy-machine';

const candyMachine = await fetchCandyMachine(umi, candyMachinePublicKey);
const candyGuard = await fetchCandyGuard(umi, candyMachine.mintAuthority);

const nftMint = generateSigner(umi);

await mintV1(umi, {
  candyMachine: candyMachine.publicKey,
  candyGuard: candyGuard.publicKey,
  nftMint,
  collectionMint: candyMachine.collectionMint,
  collectionUpdateAuthority: candyMachine.authority,
  mintArgs: {
    solPayment: some({ destination: treasury }),
    mintLimit: some({ id: 1 }),
  },
}).sendAndConfirm(umi);
```

### Available Guards (21+)

| Guard | Description |
|-------|-------------|
| `solPayment` | Charge SOL for minting |
| `tokenPayment` | Charge SPL tokens |
| `nftPayment` | Require NFT payment |
| `startDate` | Set mint start time |
| `endDate` | Set mint end time |
| `mintLimit` | Limit mints per wallet |
| `allowList` | Merkle tree allowlist |
| `tokenGate` | Require token ownership |
| `nftGate` | Require NFT ownership |
| `botTax` | Penalize failed mints |
| `gatekeeper` | Captcha verification |
| `freezeSolPayment` | Freeze SOL until conditions met |
| `freezeTokenPayment` | Freeze tokens until conditions met |
| `addressGate` | Restrict to specific addresses |
| `allocation` | Limit total mints per group |
| `redeemedAmount` | Stop after X mints |
| `thirdPartySigner` | Require additional signature |
| `token2022Payment` | Token-2022 payment |
| `nftBurn` | Burn NFT to mint |
| `tokenBurn` | Burn tokens to mint |
| `programGate` | Restrict calling programs |

---

## Genesis (Token Launches)

Fair token generation events (TGEs) on Solana.

### Launch Types

| Type | Description | Price Discovery |
|------|-------------|-----------------|
| **Presale** | Fixed-price token sale | Predetermined |
| **Launch Pool** | Deposits determine price | At close |
| **Uniform Price Auction** | Bidding mechanism | Clearing price |

### Create Presale

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplGenesis,
  createGenesis,
  addBucket,
  finalize,
} from '@metaplex-foundation/mpl-genesis';

const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(mplGenesis());

// Create genesis account
const genesis = generateSigner(umi);
await createGenesis(umi, {
  genesis,
  name: 'My Token',
  symbol: 'MTK',
  uri: 'https://arweave.net/token-metadata.json',
  decimals: 9,
  totalSupply: 1_000_000_000n * 10n ** 9n, // 1 billion tokens
}).sendAndConfirm(umi);

// Add presale bucket
await addBucket(umi, {
  genesis: genesis.publicKey,
  bucket: {
    type: 'Presale',
    price: sol(0.001), // 0.001 SOL per token
    maxTokens: 100_000_000n * 10n ** 9n, // 100M tokens
    startTime: dateTime('2024-06-01T00:00:00Z'),
    endTime: dateTime('2024-06-07T00:00:00Z'),
  },
}).sendAndConfirm(umi);

// Finalize (locks configuration)
await finalize(umi, {
  genesis: genesis.publicKey,
}).sendAndConfirm(umi);
```

### Participate in Launch

```typescript
import { deposit, claim } from '@metaplex-foundation/mpl-genesis';

// Deposit SOL
await deposit(umi, {
  genesis: genesisPublicKey,
  amount: sol(10), // 10 SOL
}).sendAndConfirm(umi);

// After launch ends, claim tokens
await claim(umi, {
  genesis: genesisPublicKey,
}).sendAndConfirm(umi);
```

---

## MPL-Hybrid (MPL-404)

Swap between fungible tokens and NFTs.

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplHybrid,
  createEscrow,
  swapNftToToken,
  swapTokenToNft,
} from '@metaplex-foundation/mpl-hybrid';

const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(mplHybrid());

// Create escrow for swapping
await createEscrow(umi, {
  escrow: escrowSigner,
  collection: collectionPublicKey,
  token: tokenMint,
  feeWallet: feeWallet,
  name: 'My Hybrid Collection',
  uri: 'https://arweave.net/escrow-metadata.json',
  max: 10000n,
  min: 0n,
  amount: 1000n, // Tokens per NFT
  feeAmount: sol(0.005),
  path: 0,
}).sendAndConfirm(umi);

// Swap NFT for tokens
await swapNftToToken(umi, {
  escrow: escrowPublicKey,
  asset: nftPublicKey,
}).sendAndConfirm(umi);

// Swap tokens for NFT
await swapTokenToNft(umi, {
  escrow: escrowPublicKey,
}).sendAndConfirm(umi);
```

---

## Inscriptions

Store data directly on-chain (up to 10MB).

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplInscription,
  initializeFromMint,
  writeData,
  fetchInscription,
} from '@metaplex-foundation/mpl-inscription';

const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(mplInscription());

// Initialize inscription for existing NFT
const inscriptionAccount = findInscriptionPda(umi, { mint: nftMint });
await initializeFromMint(umi, {
  mintAccount: nftMint,
}).sendAndConfirm(umi);

// Write JSON metadata
await writeData(umi, {
  inscriptionAccount: inscriptionAccount[0],
  value: Buffer.from(JSON.stringify({
    name: 'On-chain NFT',
    description: 'Fully on-chain!',
  })),
  offset: 0,
}).sendAndConfirm(umi);

// Write image in chunks
const imageBytes = fs.readFileSync('./image.png');
const chunkSize = 800;
for (let i = 0; i < imageBytes.length; i += chunkSize) {
  const chunk = imageBytes.slice(i, i + chunkSize);
  await writeData(umi, {
    inscriptionAccount: associatedInscriptionAccount,
    value: Buffer.from(chunk),
    offset: i,
  }).sendAndConfirm(umi);
}

// Access via Inscription Gateway
const gatewayUrl = `https://igw.metaplex.com/mainnet/${inscriptionAccount[0]}`;
```

---

## DAS API

Unified API for fetching digital assets across all Metaplex standards.

### Using DAS API

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { dasApi } from '@metaplex-foundation/digital-asset-standard-api';

const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(dasApi());

// Get single asset
const asset = await umi.rpc.getAsset(assetId);

// Get assets by owner
const assets = await umi.rpc.getAssetsByOwner({
  owner: ownerPublicKey,
  limit: 100,
});

// Get assets by collection
const collectionAssets = await umi.rpc.getAssetsByGroup({
  groupKey: 'collection',
  groupValue: collectionPublicKey,
  limit: 1000,
});

// Search assets
const searchResults = await umi.rpc.searchAssets({
  owner: ownerPublicKey,
  burnt: false,
  compressed: true,
});

// Get asset proof (for compressed NFTs)
const proof = await umi.rpc.getAssetProof(assetId);
```

### DAS-Compatible RPC Providers

- Helius
- Triton
- Shyft
- QuickNode
- Alchemy (with DAS)

---

## Protocol Fees

| Program | Operation | Fee |
|---------|-----------|-----|
| **Core** | Create | 0.0015 SOL |
| **Core** | Execute | 0.00004872 SOL |
| **Token Metadata** | Create | 0.01 SOL |
| **Bubblegum v2** | Create | 0.00009 SOL |
| **Bubblegum v2** | Transfer | 0.000006 SOL |
| **Bubblegum v1** | Create | Free |
| **Genesis** | Launch Pool | 2% deposit/withdraw, 5% graduation |
| **Genesis** | Presale | 2% deposit, 5% graduation |
| **MPL-Hybrid** | Swap | 0.005 SOL |

---

## Best Practices

### Choosing the Right Standard

| Use Case | Recommended |
|----------|-------------|
| New NFT collection | **Core** |
| Large collection (10K+) | **Bubblegum** |
| PFP with royalties | **Core** or **pNFT** |
| Gaming items | **Core** (plugins) |
| Existing ecosystem | **Token Metadata** |
| Token launch | **Genesis** |
| Hybrid token/NFT | **MPL-Hybrid** |

### Security

1. **Never share private keys** - Use wallet adapters in browsers
2. **Verify transactions** - Always review before signing
3. **Test on devnet** - Use devnet before mainnet
4. **Audit smart contracts** - If building custom guards

### Performance

1. **Batch operations** - Use transaction builders
2. **Cache DAS responses** - Reduce API calls
3. **Use compression** - Bubblegum for large collections
4. **Priority fees** - Add during congestion

---

## Resources

### Documentation

- [Metaplex Docs](https://developers.metaplex.com)
- [Core Docs](https://developers.metaplex.com/core)
- [Token Metadata Docs](https://developers.metaplex.com/token-metadata)
- [Bubblegum Docs](https://developers.metaplex.com/bubblegum)
- [Candy Machine Docs](https://developers.metaplex.com/candy-machine)
- [Genesis Docs](https://developers.metaplex.com/genesis)

### GitHub Repositories

- [mpl-core](https://github.com/metaplex-foundation/mpl-core)
- [mpl-token-metadata](https://github.com/metaplex-foundation/mpl-token-metadata)
- [mpl-bubblegum](https://github.com/metaplex-foundation/mpl-bubblegum)
- [mpl-candy-machine](https://github.com/metaplex-foundation/mpl-candy-machine)
- [umi](https://github.com/metaplex-foundation/umi)

### API References

- [Core TypeDoc](https://mpl-core.typedoc.metaplex.com)
- [Token Metadata TypeDoc](https://mpl-token-metadata.typedoc.metaplex.com)
- [Bubblegum TypeDoc](https://mpl-bubblegum.typedoc.metaplex.com)

### Community

- [Discord](https://discord.gg/metaplex)
- [Twitter](https://twitter.com/metaplex)

---

## Skill Structure

```
metaplex/
├── SKILL.md                           # This file
├── resources/
│   ├── program-ids.md                 # All program addresses
│   ├── sdk-packages.md                # NPM packages reference
│   └── protocol-fees.md               # Fee schedule
├── examples/
│   ├── core/
│   │   └── create-nft.ts              # Core NFT examples
│   ├── token-metadata/
│   │   └── create-nft.ts              # Token Metadata examples
│   ├── bubblegum/
│   │   └── compressed-nfts.ts         # cNFT examples
│   ├── candy-machine/
│   │   └── launch-collection.ts       # Candy Machine examples
│   └── genesis/
│       └── token-launch.ts            # Genesis TGE examples
├── templates/
│   └── metaplex-client.ts             # Ready-to-use client
└── docs/
    └── troubleshooting.md             # Common issues
```
