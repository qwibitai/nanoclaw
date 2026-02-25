# DAS API (Digital Asset Standard) Reference

Complete reference for Helius DAS API - unified access to NFTs, tokens, and compressed assets on Solana.

## Overview

The DAS API provides a single interface for:
- Standard NFTs (Metaplex)
- Compressed NFTs (cNFTs)
- Fungible tokens (SPL)
- Token metadata
- Collection data

## Methods Reference

### getAsset

Get detailed information about a single asset.

```typescript
const asset = await helius.getAsset({
  id: "asset_id",
  displayOptions: {
    showFungible: true,
    showNativeBalance: true,
    showInscription: true,
    showCollectionMetadata: true,
  },
});
```

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Asset ID (mint address) |
| `displayOptions` | object | No | Additional data to include |

**Response:**
```typescript
interface Asset {
  interface: "V1_NFT" | "V1_PRINT" | "LEGACY_NFT" | "V2_NFT" | "FungibleAsset" | "FungibleToken" | "Custom" | "Identity" | "Executable" | "ProgrammableNFT";
  id: string;
  content: {
    $schema: string;
    json_uri: string;
    files: Array<{ uri: string; mime: string }>;
    metadata: {
      name: string;
      symbol: string;
      description?: string;
      attributes?: Array<{ trait_type: string; value: string }>;
    };
    links?: Record<string, string>;
  };
  authorities: Array<{ address: string; scopes: string[] }>;
  compression?: {
    eligible: boolean;
    compressed: boolean;
    data_hash: string;
    creator_hash: string;
    asset_hash: string;
    tree: string;
    seq: number;
    leaf_id: number;
  };
  grouping: Array<{ group_key: string; group_value: string }>;
  royalty: {
    royalty_model: string;
    target: string | null;
    percent: number;
    basis_points: number;
    primary_sale_happened: boolean;
    locked: boolean;
  };
  creators: Array<{ address: string; share: number; verified: boolean }>;
  ownership: {
    frozen: boolean;
    delegated: boolean;
    delegate: string | null;
    ownership_model: string;
    owner: string;
  };
  supply?: {
    print_max_supply: number;
    print_current_supply: number;
    edition_nonce: number | null;
  };
  mutable: boolean;
  burnt: boolean;
  token_info?: {
    balance: number;
    supply: number;
    decimals: number;
    token_program: string;
    associated_token_address: string;
    price_info?: {
      price_per_token: number;
      total_price: number;
      currency: string;
    };
  };
}
```

### getAssetBatch

Fetch multiple assets in a single request.

```typescript
const assets = await helius.getAssetBatch({
  ids: ["asset1", "asset2", "asset3"],
  displayOptions: {
    showFungible: true,
  },
});
```

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Array of asset IDs (max 1000) |
| `displayOptions` | object | No | Additional data options |

### getAssetsByOwner

Get all assets owned by a wallet.

```typescript
const assets = await helius.getAssetsByOwner({
  ownerAddress: "wallet_address",
  page: 1,
  limit: 100,
  sortBy: {
    sortBy: "recent_action",
    sortDirection: "desc",
  },
  displayOptions: {
    showFungible: true,
    showNativeBalance: true,
    showInscription: false,
    showCollectionMetadata: true,
  },
  options: {
    showUnverifiedCollections: false,
    showCollectionMetadata: true,
    showGrandTotal: true,
  },
});
```

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ownerAddress` | string | Yes | Wallet address |
| `page` | number | No | Page number (default: 1) |
| `limit` | number | No | Results per page (max: 1000) |
| `sortBy` | object | No | Sorting options |
| `displayOptions` | object | No | Display preferences |
| `before` | string | No | Cursor for pagination |
| `after` | string | No | Cursor for pagination |

### getAssetsByCreator

Get assets by creator address.

```typescript
const assets = await helius.getAssetsByCreator({
  creatorAddress: "creator_wallet",
  onlyVerified: true,
  page: 1,
  limit: 100,
});
```

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `creatorAddress` | string | Yes | Creator wallet address |
| `onlyVerified` | boolean | No | Only verified creators |
| `page` | number | No | Page number |
| `limit` | number | No | Results per page |

### getAssetsByAuthority

Get assets by update authority.

```typescript
const assets = await helius.getAssetsByAuthority({
  authorityAddress: "authority_address",
  page: 1,
  limit: 100,
});
```

### getAssetsByGroup

Get assets by collection or group.

```typescript
// Get NFTs in a collection
const collection = await helius.getAssetsByGroup({
  groupKey: "collection",
  groupValue: "collection_mint_address",
  page: 1,
  limit: 100,
  sortBy: {
    sortBy: "recent_action",
    sortDirection: "desc",
  },
});
```

**Group Keys:**
| Key | Description |
|-----|-------------|
| `collection` | NFT collection address |

### searchAssets

Advanced search with multiple filters.

```typescript
const results = await helius.searchAssets({
  // Owner filter
  ownerAddress: "wallet_address",

  // Creator filter
  creatorAddress: "creator_address",
  creatorVerified: true,

  // Authority filter
  authorityAddress: "authority_address",

  // Collection filter
  grouping: ["collection", "collection_address"],

  // Token type filter
  tokenType: "fungible", // "fungible" | "nonFungible" | "regularNft" | "compressedNft" | "all"

  // State filters
  burnt: false,
  frozen: false,

  // Supply filter
  supplyMint: "mint_address",
  supply: 1,

  // Interface filter
  interface: "V1_NFT",

  // Delegate filter
  delegate: "delegate_address",

  // Compressed filter
  compressed: false,
  compressible: false,

  // Royalty filter
  royaltyTargetType: "creators",
  royaltyTarget: "royalty_address",
  royaltyAmount: 500, // basis points

  // Pagination
  page: 1,
  limit: 100,

  // Sorting
  sortBy: {
    sortBy: "created",
    sortDirection: "desc",
  },

  // JSON search (metadata)
  jsonUri: "https://arweave.net/...",
});
```

**Token Types:**
| Type | Description |
|------|-------------|
| `fungible` | Fungible tokens (SPL) |
| `nonFungible` | All NFTs |
| `regularNft` | Standard Metaplex NFTs |
| `compressedNft` | Compressed NFTs (cNFTs) |
| `all` | All asset types |

### getAssetProof

Get merkle proof for compressed NFT verification.

```typescript
const proof = await helius.getAssetProof({
  id: "compressed_nft_id",
});

// Response
interface AssetProof {
  root: string;
  proof: string[];
  node_index: number;
  leaf: string;
  tree_id: string;
}
```

### getAssetProofBatch

Get proofs for multiple compressed NFTs.

```typescript
const proofs = await helius.getAssetProofBatch({
  ids: ["cnft1", "cnft2", "cnft3"],
});
```

### getNftEditions

Get edition information for an NFT.

```typescript
const editions = await helius.getNftEditions({
  mint: "master_edition_mint",
  page: 1,
  limit: 100,
});

// Response includes all print editions
```

### getTokenAccounts

Get token accounts for a mint or owner.

```typescript
// By mint
const accountsByMint = await helius.getTokenAccounts({
  mint: "token_mint_address",
  page: 1,
  limit: 100,
});

// By owner
const accountsByOwner = await helius.getTokenAccounts({
  owner: "wallet_address",
  page: 1,
  limit: 100,
});
```

### getSignaturesForAsset

Get transaction history for an asset.

```typescript
const signatures = await helius.getSignaturesForAsset({
  id: "asset_id",
  page: 1,
  limit: 100,
  sortDirection: "desc",
});

// Response
interface SignatureResponse {
  total: number;
  limit: number;
  page: number;
  items: string[]; // Transaction signatures
}
```

## Display Options

Control what data is included in responses:

```typescript
interface DisplayOptions {
  showFungible?: boolean;        // Include fungible tokens
  showNativeBalance?: boolean;   // Include SOL balance
  showInscription?: boolean;     // Include inscription data
  showCollectionMetadata?: boolean; // Include collection info
  showGrandTotal?: boolean;      // Include total count
  showUnverifiedCollections?: boolean; // Include unverified
}
```

## Pagination

DAS API supports both page-based and cursor-based pagination:

### Page-Based

```typescript
const page1 = await helius.getAssetsByOwner({
  ownerAddress: "wallet",
  page: 1,
  limit: 100,
});

const page2 = await helius.getAssetsByOwner({
  ownerAddress: "wallet",
  page: 2,
  limit: 100,
});
```

### Cursor-Based

```typescript
let cursor = null;
const allAssets = [];

do {
  const response = await helius.getAssetsByOwner({
    ownerAddress: "wallet",
    limit: 1000,
    after: cursor,
  });

  allAssets.push(...response.items);
  cursor = response.cursor;
} while (cursor);
```

## Common Patterns

### Get All NFTs for Wallet

```typescript
async function getAllNFTs(wallet: string) {
  const assets = await helius.getAssetsByOwner({
    ownerAddress: wallet,
    displayOptions: {
      showFungible: false,
      showCollectionMetadata: true,
    },
  });

  return assets.items.filter(a =>
    a.interface !== "FungibleToken" &&
    a.interface !== "FungibleAsset"
  );
}
```

### Get Token Portfolio

```typescript
async function getTokenPortfolio(wallet: string) {
  const assets = await helius.getAssetsByOwner({
    ownerAddress: wallet,
    displayOptions: {
      showFungible: true,
      showNativeBalance: true,
    },
  });

  return assets.items.filter(a =>
    a.interface === "FungibleToken" ||
    a.interface === "FungibleAsset"
  );
}
```

### Verify Collection Ownership

```typescript
async function ownsNftInCollection(wallet: string, collection: string): Promise<boolean> {
  const assets = await helius.searchAssets({
    ownerAddress: wallet,
    grouping: ["collection", collection],
    tokenType: "nonFungible",
  });

  return assets.total > 0;
}
```

### Get Compressed NFT with Proof

```typescript
async function getCnftWithProof(assetId: string) {
  const [asset, proof] = await Promise.all([
    helius.getAsset({ id: assetId }),
    helius.getAssetProof({ id: assetId }),
  ]);

  return { asset, proof };
}
```

## Credits Cost

| Method | Credits |
|--------|---------|
| `getAsset` | 1 |
| `getAssetBatch` | 1 per asset |
| `getAssetsByOwner` | 1 |
| `getAssetsByCreator` | 1 |
| `getAssetsByAuthority` | 1 |
| `getAssetsByGroup` | 1 |
| `searchAssets` | 1 |
| `getAssetProof` | 1 |
| `getAssetProofBatch` | 1 per proof |
| `getNftEditions` | 1 |
| `getTokenAccounts` | 1 |
| `getSignaturesForAsset` | 1 |
