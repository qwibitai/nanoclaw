/**
 * Solana Agent Kit Integration
 * Provides autonomous access to 60+ Solana protocol actions
 */

import { SolanaAgentKit, KeypairWallet } from 'solana-agent-kit';
import { Keypair, Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import TokenPlugin from '@solana-agent-kit/plugin-token';
import NFTPlugin from '@solana-agent-kit/plugin-nft';
import DefiPlugin from '@solana-agent-kit/plugin-defi';
import MiscPlugin from '@solana-agent-kit/plugin-misc';
import BlinksPlugin from '@solana-agent-kit/plugin-blinks';

export interface SolanaAgentConfig {
  privateKey: string; // base58 encoded
  rpcUrl: string;
  openAIKey?: string;
}

export interface SolanaAgentOptions {
  OPENAI_API_KEY?: string;
}

/**
 * SolanaAgent wrapper class
 * Provides convenience methods and direct access to all 60+ actions
 */
export class SolanaAgent {
  private agent: any;
  public readonly publicKey: string;
  public readonly rpcUrl: string;

  constructor(privateKeyBase58: string, rpcUrl: string, options: SolanaAgentOptions = {}) {
    // Decode private key
    const secretKey = bs58.decode(privateKeyBase58);
    const keypair = Keypair.fromSecretKey(secretKey);
    const wallet = new KeypairWallet(keypair);

    // Initialize agent with all plugins
    this.agent = new SolanaAgentKit(wallet, rpcUrl, options)
      .use(TokenPlugin)
      .use(NFTPlugin)
      .use(DefiPlugin)
      .use(MiscPlugin)
      .use(BlinksPlugin);

    this.publicKey = keypair.publicKey.toBase58();
    this.rpcUrl = rpcUrl;
  }

  // === Convenience Methods ===

  /**
   * Get SOL balance in lamports
   */
  async getBalance(): Promise<number> {
    return this.agent.connection.getBalance(this.agent.wallet_address);
  }

  /**
   * Get SOL balance in human-readable format
   */
  async getBalanceSOL(): Promise<number> {
    const lamports = await this.getBalance();
    return lamports / 1e9;
  }

  /**
   * Transfer SOL or SPL tokens
   * @param to - Recipient address
   * @param amount - Amount to transfer
   * @param mint - Optional: SPL token mint address (omit for SOL)
   */
  async transfer(to: string, amount: number, mint?: string): Promise<string> {
    return this.agent.methods.transfer(this.agent, to, amount, mint);
  }

  /**
   * Swap tokens via Jupiter
   * @param outputMint - Output token mint address
   * @param amount - Input amount
   * @param inputMint - Input token mint (null = SOL)
   * @param slippage - Slippage in basis points (300 = 3%)
   */
  async swap(
    outputMint: string,
    amount: number,
    inputMint: string | null = null,
    slippage: number = 300
  ): Promise<string> {
    return this.agent.methods.trade(this.agent, outputMint, amount, inputMint, slippage);
  }

  /**
   * Stake SOL via Jupiter
   * @param amount - Amount of SOL to stake
   */
  async stake(amount: number): Promise<string> {
    return this.agent.methods.stakeWithJup(this.agent, amount);
  }

  /**
   * Lend USDC via Lulo
   * @param amount - Amount of USDC to lend
   */
  async lend(amount: number): Promise<string> {
    return this.agent.methods.lendAssets(this.agent, amount);
  }

  /**
   * Deploy new SPL token
   * @param name - Token name
   * @param uri - Metadata URI
   * @param symbol - Token symbol
   * @param decimals - Token decimals (default: 9)
   * @param supply - Initial supply (default: 1000000)
   */
  async deployToken(
    name: string,
    uri: string,
    symbol: string,
    decimals: number = 9,
    supply: number = 1000000
  ): Promise<any> {
    return this.agent.methods.deployToken(this.agent, name, uri, symbol, decimals, {}, supply);
  }

  /**
   * Mint NFT to collection
   * @param collectionMint - Collection mint address
   * @param metadata - NFT metadata
   * @param recipient - Recipient address (defaults to wallet)
   */
  async mintNFT(collectionMint: string, metadata: any, recipient?: string): Promise<string> {
    return this.agent.methods.mintNFT(
      this.agent,
      collectionMint,
      metadata,
      recipient || this.publicKey
    );
  }

  /**
   * Get token price via Pyth
   * @param mint - Token mint address
   */
  async getPrice(mint: string): Promise<number> {
    return this.agent.methods.fetchPrice(this.agent, mint);
  }

  /**
   * Resolve .sol domain to address
   * @param domain - Domain name (e.g., "bonfida.sol")
   */
  async resolveDomain(domain: string): Promise<string> {
    return this.agent.methods.resolveDomain(this.agent, domain);
  }

  /**
   * Get trending tokens
   */
  async getTrendingTokens(): Promise<any[]> {
    return this.agent.methods.getTrendingTokens(this.agent);
  }

  // === Direct Access ===

  /**
   * Get all available actions (60+)
   */
  get actions(): any[] {
    return this.agent.actions;
  }

  /**
   * Get all methods for direct access
   */
  get methods(): any {
    return this.agent.methods;
  }

  /**
   * Get connection object for low-level operations
   */
  get connection(): Connection {
    return this.agent.connection;
  }
}

/**
 * Create SolanaAgent from config
 */
export function createSolanaAgent(config: SolanaAgentConfig): SolanaAgent {
  return new SolanaAgent(config.privateKey, config.rpcUrl, {
    OPENAI_API_KEY: config.openAIKey,
  });
}
