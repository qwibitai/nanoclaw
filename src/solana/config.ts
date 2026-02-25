/**
 * Solana Agent Configuration Management
 * Handles loading and validation of Solana agent config
 */

import fs from 'fs/promises';
import path from 'path';
import { SolanaAgentConfig } from './agent.js';

export interface SolanaConfig {
  wallet: {
    provider: string;
    privateKey: string;
    publicKey: string;
    apiKey?: string;
    email?: string;
    environment?: string;
  };
  plugins: {
    token?: boolean;
    nft?: boolean;
    defi?: boolean;
    misc?: boolean;
    blinks?: boolean;
  };
  preferences: {
    rpcUrl: string;
    defaultSlippage: number;
  };
  setupComplete: boolean;
  setupDate: string;
}

/**
 * Load Solana configuration from file
 * @param configPath - Path to config file (default: config/solana-config.json)
 */
export async function loadSolanaConfig(
  configPath: string = 'config/solana-config.json'
): Promise<SolanaConfig> {
  const fullPath = path.resolve(configPath);
  const configData = await fs.readFile(fullPath, 'utf-8');
  const config = JSON.parse(configData) as SolanaConfig;

  // Validate config
  if (!config.wallet) {
    throw new Error('Invalid config: missing wallet configuration');
  }

  if (!config.setupComplete) {
    throw new Error('Setup incomplete. Run: npm run setup');
  }

  return config;
}

/**
 * Convert SolanaConfig to SolanaAgentConfig
 */
export function configToAgentConfig(config: SolanaConfig): SolanaAgentConfig {
  if (config.wallet.provider !== 'solana-agent-kit') {
    throw new Error(
      `Unsupported wallet provider: ${config.wallet.provider}. Expected: solana-agent-kit`
    );
  }

  if (!config.wallet.privateKey) {
    throw new Error('Private key not found in config');
  }

  return {
    privateKey: config.wallet.privateKey,
    rpcUrl: config.preferences.rpcUrl,
    openAIKey: process.env.OPENAI_API_KEY,
  };
}

/**
 * Load agent config from file and convert to agent config
 */
export async function loadAgentConfig(
  configPath?: string
): Promise<SolanaAgentConfig> {
  const config = await loadSolanaConfig(configPath);
  return configToAgentConfig(config);
}

/**
 * Check if Solana agent is configured
 */
export async function isSolanaConfigured(
  configPath: string = 'config/solana-config.json'
): Promise<boolean> {
  try {
    const fullPath = path.resolve(configPath);
    await fs.access(fullPath);
    const config = await loadSolanaConfig(configPath);
    return config.setupComplete && !!config.wallet.privateKey;
  } catch {
    return false;
  }
}
