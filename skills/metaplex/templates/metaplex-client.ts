/**
 * Metaplex Client Template
 *
 * A comprehensive client for interacting with all Metaplex programs.
 * Copy this file and configure for your project.
 *
 * Supports: Core, Token Metadata, Bubblegum, Candy Machine, DAS API
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, create as createCoreAsset, fetchAsset, transfer as transferCore, burn as burnCore } from '@metaplex-foundation/mpl-core';
import { mplTokenMetadata, createNft, fetchDigitalAsset, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import { mplBubblegum, createTree, mintV1 as mintCnft, getAssetWithProof, transfer as transferCnft } from '@metaplex-foundation/mpl-bubblegum';
import { mplCandyMachine, create as createCandyMachine, mintV1 as mintFromCm, fetchCandyMachine } from '@metaplex-foundation/mpl-candy-machine';
import { dasApi } from '@metaplex-foundation/digital-asset-standard-api';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import {
  Umi,
  generateSigner,
  keypairIdentity,
  percentAmount,
  publicKey,
  PublicKey,
  Signer,
  createSignerFromKeypair,
  sol,
  some,
} from '@metaplex-foundation/umi';

// ============================================================================
// Configuration
// ============================================================================

export interface MetaplexClientConfig {
  rpcUrl: string;
  secretKey?: Uint8Array;
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

export const DEFAULT_CONFIG: MetaplexClientConfig = {
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  commitment: 'confirmed',
};

// ============================================================================
// Types
// ============================================================================

export interface NFTMetadata {
  name: string;
  symbol?: string;
  description?: string;
  image: string;
  attributes?: Array<{ trait_type: string; value: string }>;
  properties?: {
    files?: Array<{ uri: string; type: string }>;
    category?: string;
  };
}

export interface MintResult {
  success: boolean;
  address?: string;
  signature?: string;
  error?: string;
}

// ============================================================================
// Metaplex Client
// ============================================================================

export class MetaplexClient {
  private umi: Umi;

  constructor(config: MetaplexClientConfig = DEFAULT_CONFIG) {
    this.umi = createUmi(config.rpcUrl, { commitment: config.commitment })
      .use(mplCore())
      .use(mplTokenMetadata())
      .use(mplBubblegum())
      .use(mplCandyMachine())
      .use(dasApi())
      .use(irysUploader());

    if (config.secretKey) {
      const keypair = this.umi.eddsa.createKeypairFromSecretKey(config.secretKey);
      const signer = createSignerFromKeypair(this.umi, keypair);
      this.umi.use(keypairIdentity(signer));
    }
  }

  /**
   * Get the current identity public key
   */
  get publicKey(): PublicKey {
    return this.umi.identity.publicKey;
  }

  /**
   * Get the Umi instance for advanced operations
   */
  get umiInstance(): Umi {
    return this.umi;
  }

  // ========================================================================
  // File Upload
  // ========================================================================

  /**
   * Upload metadata JSON
   */
  async uploadMetadata(metadata: NFTMetadata): Promise<string> {
    return this.umi.uploader.uploadJson(metadata);
  }

  /**
   * Upload file
   */
  async uploadFile(file: Buffer, filename: string, contentType: string): Promise<string> {
    const [uri] = await this.umi.uploader.upload([{
      buffer: file,
      fileName: filename,
      displayName: filename,
      uniqueName: `${filename}-${Date.now()}`,
      contentType,
      extension: filename.split('.').pop() || '',
      tags: [{ name: 'Content-Type', value: contentType }],
    }]);
    return uri;
  }

  // ========================================================================
  // MPL Core (Recommended for new projects)
  // ========================================================================

  /**
   * Create a Core NFT
   */
  async createCoreNft(metadata: NFTMetadata): Promise<MintResult> {
    try {
      const uri = await this.uploadMetadata(metadata);
      const asset = generateSigner(this.umi);

      const tx = await createCoreAsset(this.umi, {
        asset,
        name: metadata.name,
        uri,
      }).sendAndConfirm(this.umi);

      return {
        success: true,
        address: asset.publicKey.toString(),
        signature: tx.signature.toString(),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Transfer Core NFT
   */
  async transferCoreNft(assetAddress: string, newOwner: string): Promise<MintResult> {
    try {
      const tx = await transferCore(this.umi, {
        asset: publicKey(assetAddress),
        newOwner: publicKey(newOwner),
      }).sendAndConfirm(this.umi);

      return { success: true, signature: tx.signature.toString() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Burn Core NFT
   */
  async burnCoreNft(assetAddress: string): Promise<MintResult> {
    try {
      const tx = await burnCore(this.umi, {
        asset: publicKey(assetAddress),
      }).sendAndConfirm(this.umi);

      return { success: true, signature: tx.signature.toString() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Fetch Core NFT
   */
  async fetchCoreNft(assetAddress: string) {
    return fetchAsset(this.umi, publicKey(assetAddress));
  }

  // ========================================================================
  // Token Metadata
  // ========================================================================

  /**
   * Create Token Metadata NFT
   */
  async createTokenMetadataNft(
    metadata: NFTMetadata,
    royaltyPercent: number = 5
  ): Promise<MintResult> {
    try {
      const uri = await this.uploadMetadata(metadata);
      const mint = generateSigner(this.umi);

      const tx = await createNft(this.umi, {
        mint,
        name: metadata.name,
        symbol: metadata.symbol || '',
        uri,
        sellerFeeBasisPoints: percentAmount(royaltyPercent),
        creators: [
          { address: this.umi.identity.publicKey, share: 100, verified: true },
        ],
      }).sendAndConfirm(this.umi);

      return {
        success: true,
        address: mint.publicKey.toString(),
        signature: tx.signature.toString(),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Fetch Token Metadata NFT
   */
  async fetchTokenMetadataNft(mintAddress: string) {
    return fetchDigitalAsset(this.umi, publicKey(mintAddress));
  }

  // ========================================================================
  // Bubblegum (Compressed NFTs)
  // ========================================================================

  /**
   * Create Merkle Tree for compressed NFTs
   */
  async createMerkleTree(maxDepth: number = 14, maxBufferSize: number = 64): Promise<MintResult> {
    try {
      const merkleTree = generateSigner(this.umi);

      const tx = await createTree(this.umi, {
        merkleTree,
        maxDepth,
        maxBufferSize,
      }).sendAndConfirm(this.umi);

      return {
        success: true,
        address: merkleTree.publicKey.toString(),
        signature: tx.signature.toString(),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Mint compressed NFT
   */
  async mintCompressedNft(
    merkleTreeAddress: string,
    metadata: NFTMetadata,
    recipient?: string
  ): Promise<MintResult> {
    try {
      const uri = await this.uploadMetadata(metadata);

      const tx = await mintCnft(this.umi, {
        leafOwner: publicKey(recipient || this.umi.identity.publicKey),
        merkleTree: publicKey(merkleTreeAddress),
        metadata: {
          name: metadata.name,
          symbol: metadata.symbol || '',
          uri,
          sellerFeeBasisPoints: 500,
          collection: null,
          creators: [
            { address: this.umi.identity.publicKey, verified: true, share: 100 },
          ],
        },
      }).sendAndConfirm(this.umi);

      return { success: true, signature: tx.signature.toString() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Transfer compressed NFT
   */
  async transferCompressedNft(assetId: string, newOwner: string): Promise<MintResult> {
    try {
      const assetWithProof = await getAssetWithProof(this.umi, publicKey(assetId));

      const tx = await transferCnft(this.umi, {
        ...assetWithProof,
        leafOwner: this.umi.identity.publicKey,
        newLeafOwner: publicKey(newOwner),
      }).sendAndConfirm(this.umi);

      return { success: true, signature: tx.signature.toString() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ========================================================================
  // DAS API
  // ========================================================================

  /**
   * Get asset by ID
   */
  async getAsset(assetId: string) {
    return this.umi.rpc.getAsset(publicKey(assetId));
  }

  /**
   * Get assets by owner
   */
  async getAssetsByOwner(owner: string, limit: number = 100) {
    return this.umi.rpc.getAssetsByOwner({
      owner: publicKey(owner),
      limit,
    });
  }

  /**
   * Get assets by collection
   */
  async getAssetsByCollection(collection: string, limit: number = 1000) {
    return this.umi.rpc.getAssetsByGroup({
      groupKey: 'collection',
      groupValue: collection,
      limit,
    });
  }

  /**
   * Search assets
   */
  async searchAssets(owner: string, options?: { compressed?: boolean; burnt?: boolean }) {
    return this.umi.rpc.searchAssets({
      owner: publicKey(owner),
      compressed: options?.compressed,
      burnt: options?.burnt ?? false,
    });
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  /**
   * Generate a new keypair
   */
  generateKeypair(): Signer {
    return generateSigner(this.umi);
  }

  /**
   * Convert string to PublicKey
   */
  toPublicKey(address: string): PublicKey {
    return publicKey(address);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create client from environment variables
 */
export function createFromEnv(): MetaplexClient {
  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const secretKeyJson = process.env.WALLET_SECRET_KEY;

  let secretKey: Uint8Array | undefined;
  if (secretKeyJson) {
    try {
      secretKey = new Uint8Array(JSON.parse(secretKeyJson));
    } catch {
      console.warn('Failed to parse WALLET_SECRET_KEY');
    }
  }

  return new MetaplexClient({ rpcUrl, secretKey });
}

/**
 * Create client for devnet
 */
export function createDevnetClient(secretKey?: Uint8Array): MetaplexClient {
  return new MetaplexClient({
    rpcUrl: 'https://api.devnet.solana.com',
    secretKey,
  });
}

/**
 * Create client for mainnet
 */
export function createMainnetClient(secretKey?: Uint8Array): MetaplexClient {
  return new MetaplexClient({
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    secretKey,
  });
}

// ============================================================================
// Usage Example
// ============================================================================

/*
import { MetaplexClient, createFromEnv } from './metaplex-client';

async function main() {
  // Create client
  const client = createFromEnv();

  // Create Core NFT (recommended)
  const result = await client.createCoreNft({
    name: 'My NFT',
    description: 'An amazing NFT',
    image: 'https://arweave.net/my-image',
  });

  if (result.success) {
    console.log('NFT created:', result.address);
  }

  // Fetch NFTs by owner
  const assets = await client.getAssetsByOwner(client.publicKey.toString());
  console.log(`Found ${assets.items.length} assets`);

  // Create compressed NFT collection
  const tree = await client.createMerkleTree(14, 64); // 16K capacity
  if (tree.success) {
    await client.mintCompressedNft(tree.address!, {
      name: 'Compressed NFT #1',
      image: 'https://arweave.net/image',
    });
  }
}

main().catch(console.error);
*/

export default MetaplexClient;
