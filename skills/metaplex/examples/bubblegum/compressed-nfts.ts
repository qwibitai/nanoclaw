/**
 * Metaplex Bubblegum (Compressed NFT) Examples
 *
 * Create billions of NFTs at minimal cost using Merkle tree compression.
 * Cost: ~0.00009 SOL per cNFT vs ~0.022 SOL for Token Metadata
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplBubblegum,
  createTree,
  mintV1,
  mintToCollectionV1,
  transfer,
  burn,
  getAssetWithProof,
  decompressV1,
  delegate,
  verifyCreator,
  verifyCollection,
} from '@metaplex-foundation/mpl-bubblegum';
import { mplTokenMetadata, createNft } from '@metaplex-foundation/mpl-token-metadata';
import { dasApi } from '@metaplex-foundation/digital-asset-standard-api';
import {
  generateSigner,
  keypairIdentity,
  percentAmount,
  publicKey,
  createSignerFromKeypair,
} from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

/**
 * Setup Umi instance with Bubblegum plugin
 */
function setupUmi(secretKey?: Uint8Array) {
  const umi = createUmi(RPC_URL)
    .use(mplBubblegum())
    .use(mplTokenMetadata())
    .use(dasApi())
    .use(irysUploader({ address: 'https://devnet.irys.xyz' }));

  if (secretKey) {
    const keypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
    const signer = createSignerFromKeypair(umi, keypair);
    umi.use(keypairIdentity(signer));
  } else {
    const signer = generateSigner(umi);
    umi.use(keypairIdentity(signer));
  }

  return umi;
}

/**
 * Tree size reference
 *
 * maxDepth determines capacity:
 * - 14: 16,384 NFTs
 * - 17: 131,072 NFTs
 * - 20: 1,048,576 NFTs
 * - 24: 16,777,216 NFTs
 * - 30: 1,073,741,824 NFTs
 */
const TREE_SIZES = {
  SMALL: { maxDepth: 14, maxBufferSize: 64 },      // 16K NFTs
  MEDIUM: { maxDepth: 17, maxBufferSize: 64 },     // 131K NFTs
  LARGE: { maxDepth: 20, maxBufferSize: 256 },     // 1M NFTs
  XLARGE: { maxDepth: 24, maxBufferSize: 512 },    // 16M NFTs
  MASSIVE: { maxDepth: 30, maxBufferSize: 2048 },  // 1B NFTs
};

/**
 * Example 1: Create a Merkle Tree
 */
async function createMerkleTree(size: keyof typeof TREE_SIZES = 'SMALL') {
  const umi = setupUmi();

  console.log(`Creating ${size} Merkle tree...`);
  console.log(`Capacity: ${Math.pow(2, TREE_SIZES[size].maxDepth).toLocaleString()} NFTs`);

  const merkleTree = generateSigner(umi);

  await createTree(umi, {
    merkleTree,
    maxDepth: TREE_SIZES[size].maxDepth,
    maxBufferSize: TREE_SIZES[size].maxBufferSize,
  }).sendAndConfirm(umi);

  console.log('Merkle tree created:', merkleTree.publicKey);
  return merkleTree.publicKey;
}

/**
 * Example 2: Mint a compressed NFT
 */
async function mintCompressedNft(merkleTreeAddress: string) {
  const umi = setupUmi();

  console.log('Minting compressed NFT...');

  // Upload metadata
  const metadataUri = await umi.uploader.uploadJson({
    name: 'Compressed NFT #1',
    symbol: 'CNFT',
    description: 'A highly efficient compressed NFT',
    image: 'https://arweave.net/your-image',
    attributes: [
      { trait_type: 'Type', value: 'Compressed' },
      { trait_type: 'Efficiency', value: 'Maximum' },
    ],
  });

  await mintV1(umi, {
    leafOwner: umi.identity.publicKey,
    merkleTree: publicKey(merkleTreeAddress),
    metadata: {
      name: 'Compressed NFT #1',
      symbol: 'CNFT',
      uri: metadataUri,
      sellerFeeBasisPoints: 500, // 5% royalty
      collection: null,
      creators: [
        {
          address: umi.identity.publicKey,
          verified: true,
          share: 100,
        },
      ],
    },
  }).sendAndConfirm(umi);

  console.log('cNFT minted successfully');
}

/**
 * Example 3: Mint cNFT to a collection
 */
async function mintToCollection(
  merkleTreeAddress: string,
  collectionMintAddress: string
) {
  const umi = setupUmi();

  console.log('Minting cNFT to collection...');

  const metadataUri = await umi.uploader.uploadJson({
    name: 'Collection cNFT #1',
    symbol: 'CCNFT',
    description: 'A compressed NFT in a collection',
    image: 'https://arweave.net/your-image',
  });

  await mintToCollectionV1(umi, {
    leafOwner: umi.identity.publicKey,
    merkleTree: publicKey(merkleTreeAddress),
    collectionMint: publicKey(collectionMintAddress),
    metadata: {
      name: 'Collection cNFT #1',
      symbol: 'CCNFT',
      uri: metadataUri,
      sellerFeeBasisPoints: 500,
      creators: [
        {
          address: umi.identity.publicKey,
          verified: true,
          share: 100,
        },
      ],
    },
  }).sendAndConfirm(umi);

  console.log('cNFT minted to collection');
}

/**
 * Example 4: Create collection for cNFTs
 */
async function createCollectionForCnfts() {
  const umi = setupUmi();

  console.log('Creating collection for cNFTs...');

  const collectionUri = await umi.uploader.uploadJson({
    name: 'Compressed Collection',
    symbol: 'CCOL',
    description: 'A collection of compressed NFTs',
    image: 'https://arweave.net/collection-image',
  });

  const collectionMint = generateSigner(umi);
  await createNft(umi, {
    mint: collectionMint,
    name: 'Compressed Collection',
    symbol: 'CCOL',
    uri: collectionUri,
    sellerFeeBasisPoints: percentAmount(5),
    isCollection: true,
  }).sendAndConfirm(umi);

  console.log('Collection created:', collectionMint.publicKey);
  return collectionMint.publicKey;
}

/**
 * Example 5: Batch mint cNFTs
 */
async function batchMintCnfts(
  merkleTreeAddress: string,
  count: number
) {
  const umi = setupUmi();

  console.log(`Batch minting ${count} cNFTs...`);

  const baseMetadata = {
    symbol: 'BATCH',
    description: 'Batch minted compressed NFT',
    image: 'https://arweave.net/batch-image',
  };

  for (let i = 0; i < count; i++) {
    const metadataUri = await umi.uploader.uploadJson({
      ...baseMetadata,
      name: `Batch cNFT #${i + 1}`,
      attributes: [{ trait_type: 'Number', value: String(i + 1) }],
    });

    await mintV1(umi, {
      leafOwner: umi.identity.publicKey,
      merkleTree: publicKey(merkleTreeAddress),
      metadata: {
        name: `Batch cNFT #${i + 1}`,
        symbol: 'BATCH',
        uri: metadataUri,
        sellerFeeBasisPoints: 500,
        collection: null,
        creators: [
          {
            address: umi.identity.publicKey,
            verified: true,
            share: 100,
          },
        ],
      },
    }).sendAndConfirm(umi);

    console.log(`Minted ${i + 1}/${count}`);
  }

  console.log('Batch mint complete');
}

/**
 * Example 6: Transfer compressed NFT
 */
async function transferCnft(
  assetId: string,
  newOwnerAddress: string
) {
  const umi = setupUmi();

  console.log('Transferring cNFT...');

  // Get asset with proof from DAS API
  const assetWithProof = await getAssetWithProof(umi, publicKey(assetId));

  await transfer(umi, {
    ...assetWithProof,
    leafOwner: umi.identity.publicKey,
    newLeafOwner: publicKey(newOwnerAddress),
  }).sendAndConfirm(umi);

  console.log('cNFT transferred to:', newOwnerAddress);
}

/**
 * Example 7: Burn compressed NFT
 */
async function burnCnft(assetId: string) {
  const umi = setupUmi();

  console.log('Burning cNFT...');

  const assetWithProof = await getAssetWithProof(umi, publicKey(assetId));

  await burn(umi, {
    ...assetWithProof,
    leafOwner: umi.identity.publicKey,
  }).sendAndConfirm(umi);

  console.log('cNFT burned');
}

/**
 * Example 8: Decompress cNFT to regular NFT
 */
async function decompressCnft(assetId: string) {
  const umi = setupUmi();

  console.log('Decompressing cNFT...');

  const assetWithProof = await getAssetWithProof(umi, publicKey(assetId));
  const mint = generateSigner(umi);

  await decompressV1(umi, {
    ...assetWithProof,
    mint,
  }).sendAndConfirm(umi);

  console.log('cNFT decompressed to mint:', mint.publicKey);
  return mint.publicKey;
}

/**
 * Example 9: Fetch cNFTs by owner using DAS API
 */
async function fetchCnftsByOwner(ownerAddress: string) {
  const umi = setupUmi();

  console.log('Fetching cNFTs by owner...');

  const assets = await umi.rpc.getAssetsByOwner({
    owner: publicKey(ownerAddress),
    limit: 100,
  });

  console.log(`Found ${assets.items.length} assets`);

  for (const asset of assets.items) {
    if (asset.compression?.compressed) {
      console.log(`- [cNFT] ${asset.content?.metadata?.name} (${asset.id})`);
    } else {
      console.log(`- [NFT] ${asset.content?.metadata?.name} (${asset.id})`);
    }
  }

  return assets;
}

/**
 * Example 10: Fetch cNFTs by collection
 */
async function fetchCnftsByCollection(collectionAddress: string) {
  const umi = setupUmi();

  console.log('Fetching cNFTs by collection...');

  const assets = await umi.rpc.getAssetsByGroup({
    groupKey: 'collection',
    groupValue: collectionAddress,
    limit: 1000,
  });

  console.log(`Found ${assets.items.length} assets in collection`);

  return assets;
}

/**
 * Example 11: Delegate cNFT
 */
async function delegateCnft(assetId: string, delegateAddress: string) {
  const umi = setupUmi();

  console.log('Delegating cNFT...');

  const assetWithProof = await getAssetWithProof(umi, publicKey(assetId));

  await delegate(umi, {
    ...assetWithProof,
    leafOwner: umi.identity.publicKey,
    previousLeafDelegate: umi.identity.publicKey,
    newLeafDelegate: publicKey(delegateAddress),
  }).sendAndConfirm(umi);

  console.log('cNFT delegated to:', delegateAddress);
}

/**
 * Cost calculator
 */
function calculateCosts(nftCount: number) {
  const cNftCostPerMint = 0.00009; // SOL
  const tokenMetadataCostPerMint = 0.022; // SOL

  const depths = [
    { depth: 14, capacity: 16384 },
    { depth: 17, capacity: 131072 },
    { depth: 20, capacity: 1048576 },
    { depth: 24, capacity: 16777216 },
    { depth: 30, capacity: 1073741824 },
  ];

  // Find appropriate tree size
  const tree = depths.find(d => d.capacity >= nftCount) || depths[depths.length - 1];

  // Estimate tree cost (rough approximation)
  const treeCostEstimate = tree.depth * 0.08;

  const totalCnftCost = treeCostEstimate + (nftCount * cNftCostPerMint);
  const totalTmCost = nftCount * tokenMetadataCostPerMint;
  const savings = totalTmCost - totalCnftCost;
  const savingsPercent = ((savings / totalTmCost) * 100).toFixed(1);

  console.log('\n=== Cost Comparison ===');
  console.log(`Collection Size: ${nftCount.toLocaleString()} NFTs`);
  console.log(`\nBubblegum (cNFT):`);
  console.log(`  Tree Cost: ~${treeCostEstimate.toFixed(2)} SOL`);
  console.log(`  Mint Cost: ~${(nftCount * cNftCostPerMint).toFixed(2)} SOL`);
  console.log(`  Total: ~${totalCnftCost.toFixed(2)} SOL`);
  console.log(`\nToken Metadata:`);
  console.log(`  Total: ~${totalTmCost.toFixed(2)} SOL`);
  console.log(`\nSavings: ~${savings.toFixed(2)} SOL (${savingsPercent}%)`);

  return { totalCnftCost, totalTmCost, savings };
}

/**
 * Main execution
 */
async function main() {
  try {
    // Show cost comparison
    calculateCosts(10000);

    // Create tree and mint
    const treeAddress = await createMerkleTree('SMALL');
    await mintCompressedNft(treeAddress);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run if executed directly
main().catch(console.error);

export {
  setupUmi,
  createMerkleTree,
  mintCompressedNft,
  mintToCollection,
  createCollectionForCnfts,
  batchMintCnfts,
  transferCnft,
  burnCnft,
  decompressCnft,
  fetchCnftsByOwner,
  fetchCnftsByCollection,
  delegateCnft,
  calculateCosts,
  TREE_SIZES,
};
