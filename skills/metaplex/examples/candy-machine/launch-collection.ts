/**
 * Metaplex Candy Machine Examples
 *
 * The leading NFT minting and distribution program for fair collection launches.
 * Supports payment guards, allowlists, mint limits, and more.
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mplCandyMachine,
  create,
  addConfigLines,
  mintV1,
  fetchCandyMachine,
  fetchCandyGuard,
  deleteCandyMachine,
  deleteCandyGuard,
  updateCandyGuard,
  route,
} from '@metaplex-foundation/mpl-candy-machine';
import {
  mplTokenMetadata,
  createNft,
  TokenStandard,
} from '@metaplex-foundation/mpl-token-metadata';
import {
  generateSigner,
  keypairIdentity,
  percentAmount,
  publicKey,
  sol,
  some,
  none,
  dateTime,
  createSignerFromKeypair,
} from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

/**
 * Setup Umi instance with Candy Machine plugin
 */
function setupUmi(secretKey?: Uint8Array) {
  const umi = createUmi(RPC_URL)
    .use(mplCandyMachine())
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
 * Example 1: Create Collection for Candy Machine
 */
async function createCollection() {
  const umi = setupUmi();

  console.log('Creating collection...');

  const collectionUri = await umi.uploader.uploadJson({
    name: 'My NFT Collection',
    symbol: 'MNFT',
    description: 'An amazing NFT collection',
    image: 'https://arweave.net/collection-image',
  });

  const collectionMint = generateSigner(umi);
  await createNft(umi, {
    mint: collectionMint,
    name: 'My NFT Collection',
    symbol: 'MNFT',
    uri: collectionUri,
    sellerFeeBasisPoints: percentAmount(5),
    isCollection: true,
  }).sendAndConfirm(umi);

  console.log('Collection created:', collectionMint.publicKey);
  return collectionMint.publicKey;
}

/**
 * Example 2: Create Candy Machine with basic guards
 */
async function createCandyMachine(collectionMintAddress: string) {
  const umi = setupUmi();

  console.log('Creating Candy Machine...');

  const candyMachine = generateSigner(umi);
  const treasury = umi.identity.publicKey;

  await create(umi, {
    candyMachine,
    collection: publicKey(collectionMintAddress),
    collectionUpdateAuthority: umi.identity,
    itemsAvailable: 100,
    authority: umi.identity.publicKey,
    isMutable: true,
    configLineSettings: some({
      prefixName: 'NFT #',
      nameLength: 4,
      prefixUri: 'https://arweave.net/',
      uriLength: 43,
      isSequential: false,
    }),
    guards: {
      // Bot protection
      botTax: some({
        lamports: sol(0.01),
        lastInstruction: true,
      }),
      // Payment
      solPayment: some({
        lamports: sol(0.5),
        destination: treasury,
      }),
      // Timing
      startDate: some({
        date: dateTime('2024-01-01T00:00:00Z'),
      }),
      endDate: some({
        date: dateTime('2024-12-31T23:59:59Z'),
      }),
      // Limits
      mintLimit: some({
        id: 1,
        limit: 3,
      }),
    },
  }).sendAndConfirm(umi);

  console.log('Candy Machine created:', candyMachine.publicKey);
  return candyMachine.publicKey;
}

/**
 * Example 3: Create Candy Machine with allowlist
 */
async function createCandyMachineWithAllowlist(
  collectionMintAddress: string,
  allowlistAddresses: string[]
) {
  const umi = setupUmi();

  console.log('Creating Candy Machine with allowlist...');

  // Create Merkle tree for allowlist
  const { getMerkleRoot, getMerkleProof } = await import('@metaplex-foundation/mpl-candy-machine');
  const merkleRoot = getMerkleRoot(allowlistAddresses.map(a => publicKey(a)));

  const candyMachine = generateSigner(umi);
  const treasury = umi.identity.publicKey;

  await create(umi, {
    candyMachine,
    collection: publicKey(collectionMintAddress),
    collectionUpdateAuthority: umi.identity,
    itemsAvailable: 100,
    configLineSettings: some({
      prefixName: 'WL NFT #',
      nameLength: 4,
      prefixUri: 'https://arweave.net/',
      uriLength: 43,
      isSequential: false,
    }),
    guards: {
      solPayment: some({
        lamports: sol(0.3), // Discounted price
        destination: treasury,
      }),
      allowList: some({
        merkleRoot,
      }),
      mintLimit: some({
        id: 1,
        limit: 1, // 1 per allowlist wallet
      }),
    },
  }).sendAndConfirm(umi);

  console.log('Allowlist Candy Machine created:', candyMachine.publicKey);
  return { candyMachine: candyMachine.publicKey, merkleRoot };
}

/**
 * Example 4: Add items to Candy Machine
 */
async function addItems(candyMachineAddress: string) {
  const umi = setupUmi();

  console.log('Adding items to Candy Machine...');

  // Prepare config lines (name suffix + URI suffix)
  const configLines = [];
  for (let i = 0; i < 100; i++) {
    configLines.push({
      name: String(i).padStart(4, '0'),
      uri: `metadata${i}.json`.padEnd(43, ' ').slice(0, 43),
    });
  }

  // Add in batches of 10
  const batchSize = 10;
  for (let i = 0; i < configLines.length; i += batchSize) {
    const batch = configLines.slice(i, i + batchSize);
    await addConfigLines(umi, {
      candyMachine: publicKey(candyMachineAddress),
      index: i,
      configLines: batch,
    }).sendAndConfirm(umi);
    console.log(`Added items ${i + 1} to ${i + batch.length}`);
  }

  console.log('All items added');
}

/**
 * Example 5: Mint from Candy Machine
 */
async function mintFromCandyMachine(candyMachineAddress: string) {
  const umi = setupUmi();

  console.log('Minting from Candy Machine...');

  // Fetch candy machine and guard
  const candyMachine = await fetchCandyMachine(umi, publicKey(candyMachineAddress));
  const candyGuard = await fetchCandyGuard(umi, candyMachine.mintAuthority);

  // Generate mint signer
  const nftMint = generateSigner(umi);

  await mintV1(umi, {
    candyMachine: candyMachine.publicKey,
    candyGuard: candyGuard.publicKey,
    nftMint,
    collectionMint: candyMachine.collectionMint,
    collectionUpdateAuthority: candyMachine.authority,
    mintArgs: {
      solPayment: some({
        destination: umi.identity.publicKey, // Treasury from guard
      }),
      mintLimit: some({
        id: 1,
      }),
    },
  }).sendAndConfirm(umi);

  console.log('NFT minted:', nftMint.publicKey);
  return nftMint.publicKey;
}

/**
 * Example 6: Mint with allowlist proof
 */
async function mintWithAllowlist(
  candyMachineAddress: string,
  allowlistAddresses: string[]
) {
  const umi = setupUmi();

  console.log('Minting with allowlist...');

  const { getMerkleProof } = await import('@metaplex-foundation/mpl-candy-machine');

  const candyMachine = await fetchCandyMachine(umi, publicKey(candyMachineAddress));
  const candyGuard = await fetchCandyGuard(umi, candyMachine.mintAuthority);

  // Get proof for current identity
  const merkleProof = getMerkleProof(
    allowlistAddresses.map(a => publicKey(a)),
    umi.identity.publicKey
  );

  // First, route to verify allowlist (pre-validation)
  await route(umi, {
    candyMachine: candyMachine.publicKey,
    candyGuard: candyGuard.publicKey,
    guard: 'allowList',
    routeArgs: {
      path: 'proof',
      merkleRoot: candyGuard.guards.allowList.value?.merkleRoot!,
      merkleProof,
      index: allowlistAddresses.findIndex(
        a => a === umi.identity.publicKey.toString()
      ),
    },
  }).sendAndConfirm(umi);

  // Then mint
  const nftMint = generateSigner(umi);

  await mintV1(umi, {
    candyMachine: candyMachine.publicKey,
    candyGuard: candyGuard.publicKey,
    nftMint,
    collectionMint: candyMachine.collectionMint,
    collectionUpdateAuthority: candyMachine.authority,
    mintArgs: {
      allowList: some({ merkleRoot: candyGuard.guards.allowList.value?.merkleRoot! }),
      solPayment: some({ destination: umi.identity.publicKey }),
      mintLimit: some({ id: 1 }),
    },
  }).sendAndConfirm(umi);

  console.log('Allowlist NFT minted:', nftMint.publicKey);
  return nftMint.publicKey;
}

/**
 * Example 7: Update Candy Guard
 */
async function updateGuards(candyMachineAddress: string) {
  const umi = setupUmi();

  console.log('Updating guards...');

  const candyMachine = await fetchCandyMachine(umi, publicKey(candyMachineAddress));

  await updateCandyGuard(umi, {
    candyGuard: candyMachine.mintAuthority,
    guards: {
      solPayment: some({
        lamports: sol(1.0), // Update price
        destination: umi.identity.publicKey,
      }),
      // Remove mint limit
      mintLimit: none(),
    },
  }).sendAndConfirm(umi);

  console.log('Guards updated');
}

/**
 * Example 8: Create Candy Machine with multiple groups
 */
async function createCandyMachineWithGroups(collectionMintAddress: string) {
  const umi = setupUmi();

  console.log('Creating Candy Machine with mint groups...');

  const candyMachine = generateSigner(umi);
  const treasury = umi.identity.publicKey;

  await create(umi, {
    candyMachine,
    collection: publicKey(collectionMintAddress),
    collectionUpdateAuthority: umi.identity,
    itemsAvailable: 1000,
    configLineSettings: some({
      prefixName: 'NFT #',
      nameLength: 4,
      prefixUri: 'https://arweave.net/',
      uriLength: 43,
      isSequential: false,
    }),
    // Default guards (fallback)
    guards: {
      botTax: some({ lamports: sol(0.01), lastInstruction: true }),
    },
    // Mint groups with different conditions
    groups: [
      {
        label: 'early',
        guards: {
          solPayment: some({ lamports: sol(0.3), destination: treasury }),
          startDate: some({ date: dateTime('2024-01-01T00:00:00Z') }),
          endDate: some({ date: dateTime('2024-01-07T23:59:59Z') }),
          mintLimit: some({ id: 1, limit: 2 }),
        },
      },
      {
        label: 'public',
        guards: {
          solPayment: some({ lamports: sol(0.5), destination: treasury }),
          startDate: some({ date: dateTime('2024-01-08T00:00:00Z') }),
          mintLimit: some({ id: 2, limit: 5 }),
        },
      },
    ],
  }).sendAndConfirm(umi);

  console.log('Candy Machine with groups created:', candyMachine.publicKey);
  return candyMachine.publicKey;
}

/**
 * Example 9: Fetch Candy Machine status
 */
async function fetchCandyMachineStatus(candyMachineAddress: string) {
  const umi = setupUmi();

  const candyMachine = await fetchCandyMachine(umi, publicKey(candyMachineAddress));
  const candyGuard = await fetchCandyGuard(umi, candyMachine.mintAuthority);

  console.log('\n=== Candy Machine Status ===');
  console.log('Address:', candyMachine.publicKey);
  console.log('Items Available:', candyMachine.itemsAvailable.toString());
  console.log('Items Redeemed:', candyMachine.itemsRedeemed.toString());
  console.log('Items Remaining:', (candyMachine.itemsAvailable - candyMachine.itemsRedeemed).toString());
  console.log('Collection:', candyMachine.collectionMint);
  console.log('Authority:', candyMachine.authority);

  console.log('\n=== Guards ===');
  if (candyGuard.guards.solPayment.value) {
    console.log('SOL Payment:', Number(candyGuard.guards.solPayment.value.lamports.basisPoints) / 1e9, 'SOL');
  }
  if (candyGuard.guards.startDate.value) {
    console.log('Start Date:', new Date(Number(candyGuard.guards.startDate.value.date) * 1000));
  }
  if (candyGuard.guards.endDate.value) {
    console.log('End Date:', new Date(Number(candyGuard.guards.endDate.value.date) * 1000));
  }
  if (candyGuard.guards.mintLimit.value) {
    console.log('Mint Limit:', candyGuard.guards.mintLimit.value.limit);
  }

  return { candyMachine, candyGuard };
}

/**
 * Example 10: Delete Candy Machine (reclaim rent)
 */
async function deleteCandyMachineAndGuard(candyMachineAddress: string) {
  const umi = setupUmi();

  console.log('Deleting Candy Machine...');

  const candyMachine = await fetchCandyMachine(umi, publicKey(candyMachineAddress));

  // Delete guard first
  await deleteCandyGuard(umi, {
    candyGuard: candyMachine.mintAuthority,
  }).sendAndConfirm(umi);

  // Then delete candy machine
  await deleteCandyMachine(umi, {
    candyMachine: publicKey(candyMachineAddress),
  }).sendAndConfirm(umi);

  console.log('Candy Machine deleted, rent reclaimed');
}

/**
 * Main execution
 */
async function main() {
  try {
    // Create collection
    const collectionMint = await createCollection();

    // Create candy machine
    const candyMachine = await createCandyMachine(collectionMint);

    // Add items
    await addItems(candyMachine);

    // Check status
    await fetchCandyMachineStatus(candyMachine);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run if executed directly
main().catch(console.error);

export {
  setupUmi,
  createCollection,
  createCandyMachine,
  createCandyMachineWithAllowlist,
  addItems,
  mintFromCandyMachine,
  mintWithAllowlist,
  updateGuards,
  createCandyMachineWithGroups,
  fetchCandyMachineStatus,
  deleteCandyMachineAndGuard,
};
