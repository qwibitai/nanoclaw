/**
 * Metaplex Core NFT Examples
 *
 * MPL Core is the next-generation NFT standard on Solana with:
 * - Single account design (lower costs, simpler)
 * - Built-in plugin system
 * - Enforced royalties
 * - ~0.0029 SOL per mint
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplCore,
  create,
  createCollection,
  fetchAsset,
  fetchCollection,
  transfer,
  burn,
  update,
  addPlugin,
  removePlugin,
  ruleSet,
} from '@metaplex-foundation/mpl-core';
import {
  generateSigner,
  keypairIdentity,
  publicKey,
  createSignerFromKeypair,
} from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import * as fs from 'fs';

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

/**
 * Setup Umi instance with Core plugin
 */
function setupUmi(secretKey?: Uint8Array) {
  const umi = createUmi(RPC_URL)
    .use(mplCore())
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
 * Example 1: Create a simple Core NFT
 */
async function createSimpleNft() {
  const umi = setupUmi();

  console.log('Creating simple Core NFT...');

  // Prepare metadata
  const metadata = {
    name: 'My Core NFT',
    description: 'A next-generation NFT on Solana',
    image: 'https://arweave.net/your-image-uri',
    attributes: [
      { trait_type: 'Background', value: 'Blue' },
      { trait_type: 'Rarity', value: 'Common' },
    ],
    properties: {
      files: [{ uri: 'https://arweave.net/your-image-uri', type: 'image/png' }],
      category: 'image',
    },
  };

  // Upload metadata
  const metadataUri = await umi.uploader.uploadJson(metadata);
  console.log('Metadata uploaded:', metadataUri);

  // Create NFT
  const asset = generateSigner(umi);
  const tx = await create(umi, {
    asset,
    name: metadata.name,
    uri: metadataUri,
  }).sendAndConfirm(umi);

  console.log('NFT created!');
  console.log('Asset address:', asset.publicKey);
  console.log('Transaction:', tx.signature);

  return asset.publicKey;
}

/**
 * Example 2: Create NFT with plugins (royalties, freeze, etc.)
 */
async function createNftWithPlugins() {
  const umi = setupUmi();

  console.log('Creating Core NFT with plugins...');

  const metadataUri = await umi.uploader.uploadJson({
    name: 'Royalty Enforced NFT',
    description: 'This NFT has enforced royalties',
    image: 'https://arweave.net/your-image-uri',
  });

  const asset = generateSigner(umi);
  await create(umi, {
    asset,
    name: 'Royalty Enforced NFT',
    uri: metadataUri,
    plugins: [
      // Royalties plugin - enforced on all transfers
      {
        type: 'Royalties',
        basisPoints: 500, // 5% royalty
        creators: [
          {
            address: umi.identity.publicKey,
            percentage: 100,
          },
        ],
        ruleSet: ruleSet('None'),
      },
      // Freeze delegate - allows freezing the asset
      {
        type: 'FreezeDelegate',
        frozen: false,
        authority: { type: 'Owner' },
      },
      // Burn delegate - allows burning
      {
        type: 'BurnDelegate',
        authority: { type: 'Owner' },
      },
      // Attributes plugin - on-chain attributes
      {
        type: 'Attributes',
        attributeList: [
          { key: 'level', value: '1' },
          { key: 'experience', value: '0' },
        ],
      },
    ],
  }).sendAndConfirm(umi);

  console.log('NFT with plugins created:', asset.publicKey);
  return asset.publicKey;
}

/**
 * Example 3: Create a Collection
 */
async function createNftCollection() {
  const umi = setupUmi();

  console.log('Creating collection...');

  // Create collection metadata
  const collectionUri = await umi.uploader.uploadJson({
    name: 'My Collection',
    description: 'A collection of amazing NFTs',
    image: 'https://arweave.net/collection-image',
  });

  // Create collection
  const collection = generateSigner(umi);
  await createCollection(umi, {
    collection,
    name: 'My Collection',
    uri: collectionUri,
  }).sendAndConfirm(umi);

  console.log('Collection created:', collection.publicKey);

  // Create asset in collection
  const assetUri = await umi.uploader.uploadJson({
    name: 'Collection Item #1',
    description: 'First item in the collection',
    image: 'https://arweave.net/item-image',
  });

  const asset = generateSigner(umi);
  await create(umi, {
    asset,
    name: 'Collection Item #1',
    uri: assetUri,
    collection: collection.publicKey,
  }).sendAndConfirm(umi);

  console.log('Asset created in collection:', asset.publicKey);

  return { collection: collection.publicKey, asset: asset.publicKey };
}

/**
 * Example 4: Transfer a Core NFT
 */
async function transferNft(assetAddress: string, newOwnerAddress: string) {
  const umi = setupUmi();

  console.log('Transferring NFT...');

  await transfer(umi, {
    asset: publicKey(assetAddress),
    newOwner: publicKey(newOwnerAddress),
  }).sendAndConfirm(umi);

  console.log('NFT transferred to:', newOwnerAddress);
}

/**
 * Example 5: Update NFT metadata
 */
async function updateNft(assetAddress: string) {
  const umi = setupUmi();

  console.log('Updating NFT...');

  const newUri = await umi.uploader.uploadJson({
    name: 'Updated NFT',
    description: 'This NFT has been updated',
    image: 'https://arweave.net/new-image',
  });

  await update(umi, {
    asset: publicKey(assetAddress),
    name: 'Updated NFT',
    uri: newUri,
  }).sendAndConfirm(umi);

  console.log('NFT updated');
}

/**
 * Example 6: Add plugin to existing NFT
 */
async function addPluginToNft(assetAddress: string) {
  const umi = setupUmi();

  console.log('Adding plugin to NFT...');

  await addPlugin(umi, {
    asset: publicKey(assetAddress),
    plugin: {
      type: 'FreezeDelegate',
      frozen: false,
      authority: { type: 'Owner' },
    },
  }).sendAndConfirm(umi);

  console.log('Plugin added');
}

/**
 * Example 7: Burn NFT
 */
async function burnNft(assetAddress: string) {
  const umi = setupUmi();

  console.log('Burning NFT...');

  await burn(umi, {
    asset: publicKey(assetAddress),
  }).sendAndConfirm(umi);

  console.log('NFT burned');
}

/**
 * Example 8: Fetch and display NFT data
 */
async function fetchNftData(assetAddress: string) {
  const umi = setupUmi();

  console.log('Fetching NFT data...');

  const asset = await fetchAsset(umi, publicKey(assetAddress));

  console.log('\n=== Asset Data ===');
  console.log('Name:', asset.name);
  console.log('URI:', asset.uri);
  console.log('Owner:', asset.owner);
  console.log('Update Authority:', asset.updateAuthority);

  if (asset.royalties) {
    console.log('Royalties:', asset.royalties.basisPoints / 100, '%');
  }

  return asset;
}

/**
 * Example 9: Upload image and create NFT
 */
async function uploadAndCreateNft(imagePath: string) {
  const umi = setupUmi();

  console.log('Uploading image and creating NFT...');

  // Read image file
  const imageBuffer = fs.readFileSync(imagePath);
  const imageFile = {
    buffer: imageBuffer,
    fileName: 'image.png',
    displayName: 'NFT Image',
    uniqueName: `nft-image-${Date.now()}`,
    contentType: 'image/png',
    extension: 'png',
    tags: [{ name: 'Content-Type', value: 'image/png' }],
  };

  // Upload image
  const [imageUri] = await umi.uploader.upload([imageFile]);
  console.log('Image uploaded:', imageUri);

  // Create and upload metadata
  const metadata = {
    name: 'Uploaded NFT',
    description: 'NFT with uploaded image',
    image: imageUri,
    properties: {
      files: [{ uri: imageUri, type: 'image/png' }],
      category: 'image',
    },
  };
  const metadataUri = await umi.uploader.uploadJson(metadata);
  console.log('Metadata uploaded:', metadataUri);

  // Create NFT
  const asset = generateSigner(umi);
  await create(umi, {
    asset,
    name: metadata.name,
    uri: metadataUri,
  }).sendAndConfirm(umi);

  console.log('NFT created:', asset.publicKey);
  return asset.publicKey;
}

/**
 * Main execution
 */
async function main() {
  try {
    // Create simple NFT
    const assetAddress = await createSimpleNft();

    // Fetch and display
    await fetchNftData(assetAddress);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run if executed directly
main().catch(console.error);

export {
  setupUmi,
  createSimpleNft,
  createNftWithPlugins,
  createNftCollection,
  transferNft,
  updateNft,
  addPluginToNft,
  burnNft,
  fetchNftData,
  uploadAndCreateNft,
};
