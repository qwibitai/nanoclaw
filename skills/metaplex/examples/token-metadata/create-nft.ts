/**
 * Metaplex Token Metadata NFT Examples
 *
 * The original Solana NFT standard using Program Derived Addresses (PDAs).
 * Use for compatibility with existing ecosystem or when you need pNFTs.
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplTokenMetadata,
  createNft,
  createProgrammableNft,
  createFungible,
  createFungibleAsset,
  fetchDigitalAsset,
  fetchAllDigitalAssetByOwner,
  updateV1,
  transferV1,
  burnV1,
  mintV1,
  verifyCollectionV1,
  TokenStandard,
} from '@metaplex-foundation/mpl-token-metadata';
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
 * Setup Umi instance with Token Metadata plugin
 */
function setupUmi(secretKey?: Uint8Array) {
  const umi = createUmi(RPC_URL)
    .use(mplTokenMetadata())
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
 * Example 1: Create a standard NFT
 */
async function createStandardNft() {
  const umi = setupUmi();

  console.log('Creating standard NFT...');

  // Upload metadata
  const metadataUri = await umi.uploader.uploadJson({
    name: 'My Token Metadata NFT',
    symbol: 'MNFT',
    description: 'A standard NFT using Token Metadata',
    image: 'https://arweave.net/your-image',
    attributes: [
      { trait_type: 'Background', value: 'Blue' },
      { trait_type: 'Rarity', value: 'Common' },
    ],
    properties: {
      files: [{ uri: 'https://arweave.net/your-image', type: 'image/png' }],
      category: 'image',
    },
  });

  console.log('Metadata uploaded:', metadataUri);

  // Create NFT
  const mint = generateSigner(umi);
  await createNft(umi, {
    mint,
    name: 'My Token Metadata NFT',
    symbol: 'MNFT',
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(5.5), // 5.5% royalty
    creators: [
      {
        address: umi.identity.publicKey,
        share: 100,
        verified: true,
      },
    ],
  }).sendAndConfirm(umi);

  console.log('NFT created!');
  console.log('Mint address:', mint.publicKey);

  return mint.publicKey;
}

/**
 * Example 2: Create a Programmable NFT (pNFT) with enforced royalties
 */
async function createPNft() {
  const umi = setupUmi();

  console.log('Creating programmable NFT (pNFT)...');

  const metadataUri = await umi.uploader.uploadJson({
    name: 'My pNFT',
    symbol: 'PNFT',
    description: 'A programmable NFT with enforced royalties',
    image: 'https://arweave.net/your-image',
  });

  const mint = generateSigner(umi);
  await createProgrammableNft(umi, {
    mint,
    name: 'My pNFT',
    symbol: 'PNFT',
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(10), // 10% enforced royalty
    creators: [
      {
        address: umi.identity.publicKey,
        share: 100,
        verified: true,
      },
    ],
    // Optional: Add rule set for custom transfer rules
    // ruleSet: ruleSetPublicKey,
  }).sendAndConfirm(umi);

  console.log('pNFT created:', mint.publicKey);
  return mint.publicKey;
}

/**
 * Example 3: Create a Fungible Token with metadata
 */
async function createFungibleToken() {
  const umi = setupUmi();

  console.log('Creating fungible token...');

  const metadataUri = await umi.uploader.uploadJson({
    name: 'My Token',
    symbol: 'MTK',
    description: 'A fungible token with metadata',
    image: 'https://arweave.net/token-logo',
  });

  const mint = generateSigner(umi);
  await createFungible(umi, {
    mint,
    name: 'My Token',
    symbol: 'MTK',
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(0),
    decimals: 9,
  }).sendAndConfirm(umi);

  console.log('Fungible token created:', mint.publicKey);

  // Mint some tokens
  await mintV1(umi, {
    mint: mint.publicKey,
    authority: umi.identity,
    amount: 1_000_000_000n, // 1 token (9 decimals)
    tokenOwner: umi.identity.publicKey,
    tokenStandard: TokenStandard.Fungible,
  }).sendAndConfirm(umi);

  console.log('Tokens minted');
  return mint.publicKey;
}

/**
 * Example 4: Create Semi-Fungible Token (SFT)
 */
async function createSemiFungibleToken() {
  const umi = setupUmi();

  console.log('Creating semi-fungible token...');

  const metadataUri = await umi.uploader.uploadJson({
    name: 'Game Item',
    symbol: 'ITEM',
    description: 'A semi-fungible game item',
    image: 'https://arweave.net/item-image',
  });

  const mint = generateSigner(umi);
  await createFungibleAsset(umi, {
    mint,
    name: 'Game Item',
    symbol: 'ITEM',
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(2.5),
    decimals: 0, // Whole units only
  }).sendAndConfirm(umi);

  // Mint multiple copies
  await mintV1(umi, {
    mint: mint.publicKey,
    authority: umi.identity,
    amount: 100n, // 100 copies
    tokenOwner: umi.identity.publicKey,
    tokenStandard: TokenStandard.FungibleAsset,
  }).sendAndConfirm(umi);

  console.log('SFT created and minted:', mint.publicKey);
  return mint.publicKey;
}

/**
 * Example 5: Create Collection NFT
 */
async function createCollection() {
  const umi = setupUmi();

  console.log('Creating collection...');

  const collectionUri = await umi.uploader.uploadJson({
    name: 'My Collection',
    symbol: 'MCOL',
    description: 'A collection of amazing NFTs',
    image: 'https://arweave.net/collection-image',
  });

  const collectionMint = generateSigner(umi);
  await createNft(umi, {
    mint: collectionMint,
    name: 'My Collection',
    symbol: 'MCOL',
    uri: collectionUri,
    sellerFeeBasisPoints: percentAmount(5),
    isCollection: true,
  }).sendAndConfirm(umi);

  console.log('Collection created:', collectionMint.publicKey);
  return collectionMint.publicKey;
}

/**
 * Example 6: Create NFT in Collection
 */
async function createNftInCollection(collectionMintAddress: string) {
  const umi = setupUmi();

  console.log('Creating NFT in collection...');

  const metadataUri = await umi.uploader.uploadJson({
    name: 'Collection Item #1',
    symbol: 'ITEM',
    description: 'An item in the collection',
    image: 'https://arweave.net/item-image',
  });

  const mint = generateSigner(umi);
  await createNft(umi, {
    mint,
    name: 'Collection Item #1',
    symbol: 'ITEM',
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(5),
    collection: {
      key: publicKey(collectionMintAddress),
      verified: false,
    },
    creators: [
      {
        address: umi.identity.publicKey,
        share: 100,
        verified: true,
      },
    ],
  }).sendAndConfirm(umi);

  // Verify collection (requires collection authority)
  await verifyCollectionV1(umi, {
    metadata: findMetadataPda(umi, { mint: mint.publicKey }),
    collectionMint: publicKey(collectionMintAddress),
    authority: umi.identity,
  }).sendAndConfirm(umi);

  console.log('NFT created and verified in collection:', mint.publicKey);
  return mint.publicKey;
}

/**
 * Example 7: Update NFT metadata
 */
async function updateNftMetadata(mintAddress: string) {
  const umi = setupUmi();

  console.log('Updating NFT metadata...');

  const newUri = await umi.uploader.uploadJson({
    name: 'Updated NFT',
    symbol: 'UNFT',
    description: 'This NFT has been updated',
    image: 'https://arweave.net/new-image',
  });

  await updateV1(umi, {
    mint: publicKey(mintAddress),
    data: {
      name: 'Updated NFT',
      symbol: 'UNFT',
      uri: newUri,
      sellerFeeBasisPoints: 500,
      creators: null, // Keep existing
    },
  }).sendAndConfirm(umi);

  console.log('NFT updated');
}

/**
 * Example 8: Transfer NFT
 */
async function transferNft(
  mintAddress: string,
  destinationOwner: string,
  tokenStandard: TokenStandard = TokenStandard.NonFungible
) {
  const umi = setupUmi();

  console.log('Transferring NFT...');

  await transferV1(umi, {
    mint: publicKey(mintAddress),
    authority: umi.identity,
    tokenOwner: umi.identity.publicKey,
    destinationOwner: publicKey(destinationOwner),
    tokenStandard,
  }).sendAndConfirm(umi);

  console.log('NFT transferred to:', destinationOwner);
}

/**
 * Example 9: Burn NFT
 */
async function burnNft(
  mintAddress: string,
  tokenStandard: TokenStandard = TokenStandard.NonFungible
) {
  const umi = setupUmi();

  console.log('Burning NFT...');

  await burnV1(umi, {
    mint: publicKey(mintAddress),
    authority: umi.identity,
    tokenOwner: umi.identity.publicKey,
    tokenStandard,
  }).sendAndConfirm(umi);

  console.log('NFT burned');
}

/**
 * Example 10: Fetch NFT data
 */
async function fetchNft(mintAddress: string) {
  const umi = setupUmi();

  console.log('Fetching NFT data...');

  const asset = await fetchDigitalAsset(umi, publicKey(mintAddress));

  console.log('\n=== NFT Data ===');
  console.log('Name:', asset.metadata.name);
  console.log('Symbol:', asset.metadata.symbol);
  console.log('URI:', asset.metadata.uri);
  console.log('Royalty:', asset.metadata.sellerFeeBasisPoints / 100, '%');
  console.log('Token Standard:', asset.metadata.tokenStandard);
  console.log('Creators:', asset.metadata.creators);

  return asset;
}

/**
 * Example 11: Fetch all NFTs by owner
 */
async function fetchNftsByOwner(ownerAddress: string) {
  const umi = setupUmi();

  console.log('Fetching NFTs by owner...');

  const assets = await fetchAllDigitalAssetByOwner(
    umi,
    publicKey(ownerAddress)
  );

  console.log(`Found ${assets.length} NFTs`);

  for (const asset of assets) {
    console.log(`- ${asset.metadata.name} (${asset.mint.publicKey})`);
  }

  return assets;
}

// Helper to find metadata PDA
import { findMetadataPda } from '@metaplex-foundation/mpl-token-metadata';

/**
 * Main execution
 */
async function main() {
  try {
    // Create standard NFT
    const mintAddress = await createStandardNft();

    // Fetch and display
    await fetchNft(mintAddress);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run if executed directly
main().catch(console.error);

export {
  setupUmi,
  createStandardNft,
  createPNft,
  createFungibleToken,
  createSemiFungibleToken,
  createCollection,
  createNftInCollection,
  updateNftMetadata,
  transferNft,
  burnNft,
  fetchNft,
  fetchNftsByOwner,
};
