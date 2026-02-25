# Fetch NFTs Examples

Examples demonstrating Helius DAS API for NFT and token data.

## Setup

```typescript
import { createHelius } from "helius-sdk";

const helius = createHelius({
  apiKey: process.env.HELIUS_API_KEY!,
});
```

## Get All NFTs for Wallet

```typescript
async function getAllNFTsForWallet(walletAddress: string) {
  const response = await helius.getAssetsByOwner({
    ownerAddress: walletAddress,
    page: 1,
    limit: 1000,
    displayOptions: {
      showFungible: false,
      showCollectionMetadata: true,
    },
  });

  // Filter to only NFTs
  const nfts = response.items.filter(asset =>
    asset.interface !== "FungibleToken" &&
    asset.interface !== "FungibleAsset"
  );

  console.log(`Found ${nfts.length} NFTs`);

  for (const nft of nfts) {
    console.log(`Name: ${nft.content.metadata.name}`);
    console.log(`Mint: ${nft.id}`);
    console.log(`Image: ${nft.content.files[0]?.uri || "N/A"}`);

    // Collection info
    const collection = nft.grouping.find(g => g.group_key === "collection");
    if (collection) {
      console.log(`Collection: ${collection.group_value}`);
    }
    console.log("---");
  }

  return nfts;
}
```

## Get Compressed NFTs

```typescript
async function getCompressedNFTs(walletAddress: string) {
  const response = await helius.searchAssets({
    ownerAddress: walletAddress,
    compressed: true,
    tokenType: "nonFungible",
    page: 1,
    limit: 100,
  });

  console.log(`Found ${response.total} compressed NFTs`);

  for (const cnft of response.items) {
    console.log(`Name: ${cnft.content.metadata.name}`);
    console.log(`Asset ID: ${cnft.id}`);
    console.log(`Tree: ${cnft.compression?.tree}`);
    console.log(`Leaf Index: ${cnft.compression?.leaf_id}`);
    console.log("---");
  }

  return response.items;
}
```

## Get NFT Collection

```typescript
async function getNFTCollection(collectionAddress: string) {
  const response = await helius.getAssetsByGroup({
    groupKey: "collection",
    groupValue: collectionAddress,
    page: 1,
    limit: 100,
    sortBy: {
      sortBy: "recent_action",
      sortDirection: "desc",
    },
  });

  console.log(`Collection has ${response.total} NFTs`);

  // Get floor price and unique holders
  const holders = new Set(response.items.map(nft => nft.ownership.owner));
  console.log(`Unique holders: ${holders.size}`);

  return response;
}
```

## Get NFT Details

```typescript
async function getNFTDetails(mintAddress: string) {
  const asset = await helius.getAsset({
    id: mintAddress,
    displayOptions: {
      showCollectionMetadata: true,
    },
  });

  console.log("=== NFT Details ===");
  console.log(`Name: ${asset.content.metadata.name}`);
  console.log(`Symbol: ${asset.content.metadata.symbol}`);
  console.log(`Description: ${asset.content.metadata.description || "N/A"}`);

  // Image
  const image = asset.content.files.find(f => f.mime?.startsWith("image/"));
  console.log(`Image: ${image?.uri || asset.content.links?.image || "N/A"}`);

  // Owner
  console.log(`Owner: ${asset.ownership.owner}`);
  console.log(`Frozen: ${asset.ownership.frozen}`);

  // Royalties
  console.log(`Royalty: ${asset.royalty.basis_points / 100}%`);
  console.log(`Primary Sale: ${asset.royalty.primary_sale_happened}`);

  // Creators
  console.log("Creators:");
  for (const creator of asset.creators) {
    console.log(`  ${creator.address}: ${creator.share}% ${creator.verified ? "(verified)" : ""}`);
  }

  // Attributes
  const attributes = asset.content.metadata.attributes || [];
  if (attributes.length > 0) {
    console.log("Attributes:");
    for (const attr of attributes) {
      console.log(`  ${attr.trait_type}: ${attr.value}`);
    }
  }

  // Compression info (if compressed)
  if (asset.compression?.compressed) {
    console.log("Compression:");
    console.log(`  Tree: ${asset.compression.tree}`);
    console.log(`  Leaf Index: ${asset.compression.leaf_id}`);
    console.log(`  Data Hash: ${asset.compression.data_hash}`);
  }

  return asset;
}
```

## Get NFT Proof (for Compressed NFTs)

```typescript
async function getCNFTProof(assetId: string) {
  const proof = await helius.getAssetProof({
    id: assetId,
  });

  console.log("=== cNFT Proof ===");
  console.log(`Root: ${proof.root}`);
  console.log(`Tree: ${proof.tree_id}`);
  console.log(`Leaf Index: ${proof.node_index}`);
  console.log(`Proof Length: ${proof.proof.length}`);

  return proof;
}
```

## Get Token Portfolio

```typescript
async function getTokenPortfolio(walletAddress: string) {
  const response = await helius.getAssetsByOwner({
    ownerAddress: walletAddress,
    displayOptions: {
      showFungible: true,
      showNativeBalance: true,
    },
  });

  // Filter to fungible tokens
  const tokens = response.items.filter(asset =>
    asset.interface === "FungibleToken" ||
    asset.interface === "FungibleAsset"
  );

  console.log(`Found ${tokens.length} tokens`);

  for (const token of tokens) {
    const tokenInfo = token.token_info;
    if (tokenInfo) {
      console.log(`Token: ${token.content.metadata.name || token.id}`);
      console.log(`Symbol: ${token.content.metadata.symbol || "N/A"}`);
      console.log(`Balance: ${tokenInfo.balance / Math.pow(10, tokenInfo.decimals)}`);

      if (tokenInfo.price_info) {
        console.log(`Price: $${tokenInfo.price_info.price_per_token}`);
        console.log(`Value: $${tokenInfo.price_info.total_price}`);
      }
      console.log("---");
    }
  }

  // Native SOL balance
  if (response.nativeBalance) {
    console.log(`SOL Balance: ${response.nativeBalance.lamports / 1e9} SOL`);
  }

  return { tokens, nativeBalance: response.nativeBalance };
}
```

## Search NFTs with Filters

```typescript
async function searchNFTs(options: {
  owner?: string;
  creator?: string;
  collection?: string;
  burnt?: boolean;
}) {
  const searchParams: any = {
    page: 1,
    limit: 100,
    tokenType: "nonFungible",
  };

  if (options.owner) {
    searchParams.ownerAddress = options.owner;
  }
  if (options.creator) {
    searchParams.creatorAddress = options.creator;
    searchParams.creatorVerified = true;
  }
  if (options.collection) {
    searchParams.grouping = ["collection", options.collection];
  }
  if (options.burnt !== undefined) {
    searchParams.burnt = options.burnt;
  }

  const response = await helius.searchAssets(searchParams);

  console.log(`Found ${response.total} NFTs matching criteria`);
  return response;
}

// Usage examples
await searchNFTs({ owner: "wallet_address" });
await searchNFTs({ collection: "collection_address" });
await searchNFTs({ creator: "creator_address" });
await searchNFTs({ owner: "wallet", burnt: false });
```

## Batch Fetch NFT Details

```typescript
async function batchFetchNFTs(mintAddresses: string[]) {
  const assets = await helius.getAssetBatch({
    ids: mintAddresses,
    displayOptions: {
      showCollectionMetadata: true,
    },
  });

  console.log(`Fetched ${assets.length} NFTs`);

  return assets;
}
```

## Get NFT Transaction History

```typescript
async function getNFTHistory(mintAddress: string) {
  const signatures = await helius.getSignaturesForAsset({
    id: mintAddress,
    page: 1,
    limit: 50,
  });

  console.log(`Found ${signatures.total} transactions for NFT`);

  return signatures.items;
}
```

## Check NFT Collection Ownership

```typescript
async function ownsNFTInCollection(
  walletAddress: string,
  collectionAddress: string
): Promise<boolean> {
  const response = await helius.searchAssets({
    ownerAddress: walletAddress,
    grouping: ["collection", collectionAddress],
    tokenType: "nonFungible",
    page: 1,
    limit: 1,
  });

  const owns = response.total > 0;
  console.log(`Wallet ${owns ? "owns" : "does not own"} NFT from collection`);

  return owns;
}
```

## Get NFT Editions

```typescript
async function getNFTEditions(masterEditionMint: string) {
  const editions = await helius.getNftEditions({
    mint: masterEditionMint,
    page: 1,
    limit: 100,
  });

  console.log(`Found ${editions.total} editions`);

  for (const edition of editions.items) {
    console.log(`Edition #${edition.edition_number}: ${edition.mint}`);
  }

  return editions;
}
```

## Complete Portfolio Example

```typescript
async function getCompletePortfolio(walletAddress: string) {
  console.log(`=== Portfolio for ${walletAddress} ===\n`);

  // Get all assets
  const response = await helius.getAssetsByOwner({
    ownerAddress: walletAddress,
    displayOptions: {
      showFungible: true,
      showNativeBalance: true,
      showCollectionMetadata: true,
    },
  });

  // Categorize assets
  const portfolio = {
    nfts: [] as any[],
    compressedNfts: [] as any[],
    tokens: [] as any[],
    nativeBalance: response.nativeBalance?.lamports || 0,
  };

  for (const asset of response.items) {
    if (asset.interface === "FungibleToken" || asset.interface === "FungibleAsset") {
      portfolio.tokens.push(asset);
    } else if (asset.compression?.compressed) {
      portfolio.compressedNfts.push(asset);
    } else {
      portfolio.nfts.push(asset);
    }
  }

  // Summary
  console.log("=== Summary ===");
  console.log(`SOL: ${portfolio.nativeBalance / 1e9} SOL`);
  console.log(`NFTs: ${portfolio.nfts.length}`);
  console.log(`Compressed NFTs: ${portfolio.compressedNfts.length}`);
  console.log(`Tokens: ${portfolio.tokens.length}`);

  // Token values
  let totalValue = 0;
  for (const token of portfolio.tokens) {
    if (token.token_info?.price_info?.total_price) {
      totalValue += token.token_info.price_info.total_price;
    }
  }
  console.log(`Total Token Value: $${totalValue.toFixed(2)}`);

  return portfolio;
}
```

## Paginate Through All NFTs

```typescript
async function getAllNFTsPaginated(walletAddress: string) {
  const allNFTs = [];
  let page = 1;
  const limit = 1000;

  while (true) {
    const response = await helius.getAssetsByOwner({
      ownerAddress: walletAddress,
      page,
      limit,
      displayOptions: {
        showFungible: false,
      },
    });

    const nfts = response.items.filter(a =>
      a.interface !== "FungibleToken" &&
      a.interface !== "FungibleAsset"
    );

    allNFTs.push(...nfts);

    console.log(`Page ${page}: ${nfts.length} NFTs (Total: ${allNFTs.length})`);

    if (response.items.length < limit) {
      break;
    }
    page++;
  }

  console.log(`Total NFTs: ${allNFTs.length}`);
  return allNFTs;
}
```
