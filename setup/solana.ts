/**
 * Solana setup step
 * Configures Solana wallet and plugins for agent operations
 */

import { select, password, input, checkbox } from '@inquirer/prompts';
import fs from 'fs/promises';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import chalk from 'chalk';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  console.log(chalk.cyan.bold('\n🦀 Solana Configuration\n'));
  console.log('Configure wallet and enable Solana protocol operations.\n');

  emitStatus('SOLANA_SETUP', { STATUS: 'starting' });

  try {
    // Step 1: Wallet Configuration
    console.log(chalk.yellow('Step 1: Wallet Configuration'));

    const keySource = await select({
      message: 'How would you like to provide the private key?',
      choices: [
        {
          name: 'Paste base58 private key (recommended)',
          value: 'base58',
        },
        {
          name: 'Load from keypair JSON file',
          value: 'file',
        },
        {
          name: 'Generate new keypair',
          value: 'generate',
        },
      ],
    });

    let privateKey: string;
    let publicKey: string;

    if (keySource === 'base58') {
      privateKey = await password({
        message: 'Paste base58 private key:',
        validate: (value) => {
          try {
            const decoded = bs58.decode(value);
            return decoded.length === 64 ? true : 'Invalid key length (expected 64 bytes)';
          } catch {
            return 'Invalid base58 format';
          }
        },
      });

      // Derive public key
      const secretKey = bs58.decode(privateKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      publicKey = keypair.publicKey.toBase58();

      console.log(chalk.green('\n✓ Keypair validated'));
      console.log(chalk.white(`  Public Key: ${publicKey}\n`));
    } else if (keySource === 'file') {
      const keypath = await input({
        message: 'Path to keypair JSON file:',
        default: '~/.config/solana/id.json',
      });

      // Expand ~ to home directory
      const expandedPath = keypath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');

      // Load and convert to base58
      const keypairData = JSON.parse(await fs.readFile(expandedPath, 'utf-8'));
      const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
      privateKey = bs58.encode(keypair.secretKey);
      publicKey = keypair.publicKey.toBase58();

      console.log(chalk.green('\n✓ Keypair loaded from file'));
      console.log(chalk.white(`  Public Key: ${publicKey}\n`));
    } else {
      // Generate new keypair
      const keypair = Keypair.generate();
      privateKey = bs58.encode(keypair.secretKey);
      publicKey = keypair.publicKey.toBase58();

      console.log(chalk.green('\n✓ New keypair generated!'));
      console.log(chalk.yellow('\n⚠️  SAVE THIS PRIVATE KEY - You will not see it again!\n'));
      console.log(chalk.white(`Public Key:  ${chalk.cyan(publicKey)}`));
      console.log(chalk.white(`Private Key: ${chalk.cyan(privateKey)}\n`));
      console.log(chalk.gray('Fund your wallet before using:'));
      console.log(chalk.gray(`  solana airdrop 1 ${publicKey}\n`));
    }

    // Step 2: RPC Configuration
    console.log(chalk.yellow('\nStep 2: RPC Configuration'));
    const rpcUrl = await input({
      message: 'Solana RPC URL:',
      default: 'https://api.mainnet-beta.solana.com',
    });

    const defaultSlippage = await input({
      message: 'Default slippage (basis points):',
      default: '50',
      validate: (value) => {
        const num = parseInt(value);
        return num >= 0 && num <= 1000 ? true : 'Must be between 0 and 1000';
      },
    });

    // Step 3: Plugin Selection
    console.log(chalk.yellow('\n\nStep 3: Plugin Selection'));
    const selectedPlugins = await checkbox({
      message: 'Select Solana Agent Kit plugins to enable:',
      choices: [
        { name: 'Token Plugin (transfers, swaps, deployments)', value: 'token', checked: true },
        { name: 'DeFi Plugin (Jupiter, Raydium, Drift, Meteora, etc.)', value: 'defi', checked: true },
        { name: 'NFT Plugin (Metaplex, 3.Land)', value: 'nft', checked: true },
        { name: 'Misc Plugin (domains, prices, trending, faucet)', value: 'misc', checked: true },
        { name: 'Blinks Plugin (arcade games)', value: 'blinks', checked: false },
      ],
    });

    const plugins: Record<string, boolean> = {};
    selectedPlugins.forEach(plugin => {
      plugins[plugin] = true;
    });

    // Build config
    const config = {
      wallet: {
        provider: 'solana-agent-kit',
        privateKey,
        publicKey,
      },
      plugins,
      preferences: {
        rpcUrl,
        defaultSlippage: parseInt(defaultSlippage),
      },
      setupComplete: true,
      setupDate: new Date().toISOString(),
    };

    // Save config
    const configPath = path.join(process.cwd(), 'config', 'solana-config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    // Create .env file
    const envLines = [
      '# SolClaw Solana Configuration',
      '# Generated during setup',
      '',
      `SOLANA_PRIVATE_KEY=${privateKey}`,
      `SOLANA_RPC_URL=${rpcUrl}`,
      '',
    ];

    const envPath = path.join(process.cwd(), '.env.solana');
    await fs.writeFile(envPath, envLines.join('\n'));

    // Summary
    console.log(chalk.green.bold('\n✅ Solana Configuration Complete!\n'));
    console.log(chalk.white('Configuration saved to:'));
    console.log(chalk.cyan(`  ${configPath}`));
    console.log(chalk.cyan(`  ${envPath}\n`));

    console.log(chalk.white('Enabled plugins:'));
    Object.keys(plugins).forEach(p => {
      console.log(chalk.cyan(`  ✓ ${p}`));
    });

    console.log(chalk.white('\nYour agent can now:'));
    console.log(chalk.cyan('  • Execute 60+ Solana actions'));
    console.log(chalk.cyan('  • Trade tokens via Jupiter'));
    console.log(chalk.cyan('  • Stake SOL, lend USDC'));
    console.log(chalk.cyan('  • Deploy tokens & mint NFTs'));
    console.log(chalk.cyan('  • Access price feeds & trending data\n'));

    emitStatus('SOLANA_SETUP', {
      STATUS: 'complete',
      PUBLIC_KEY: publicKey,
      RPC_URL: rpcUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red('\n❌ Solana setup failed:'), message);
    emitStatus('SOLANA_SETUP', {
      STATUS: 'failed',
      ERROR: message,
    });
    throw error;
  }
}
