#!/usr/bin/env node

/**
 * SolClaw Setup Wizard (Enhanced with Solana Agent Kit)
 * Configure Solana wallet and DeFi protocol integrations
 */

import { select, checkbox, password, input, confirm } from '@inquirer/prompts';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(chalk.cyan.bold('\n🦀 Welcome to SolClaw Setup!\n'));
console.log('This wizard will configure your Solana DeFi agent with full autonomy.\n');

async function main() {
  try {
    // Step 1: Wallet Selection
    console.log(chalk.yellow('Step 1: Wallet Configuration'));
    console.log(chalk.gray('SolClaw uses Solana Agent Kit for full protocol access (60+ actions)\n'));

    const walletType = await select({
      message: 'Select wallet configuration:',
      choices: [
        {
          name: 'Use existing keypair (recommended - full autonomy)',
          value: 'keypair',
          description: 'Agent can execute all Solana actions autonomously'
        },
        {
          name: 'Generate new keypair',
          value: 'generate',
          description: 'Create a fresh wallet for your agent'
        },
        {
          name: 'Use Crossmint (custodial - limited actions)',
          value: 'crossmint',
          description: 'Only for wallets & payments, not full DeFi'
        },
      ],
    });

    let walletConfig = {};

    if (walletType === 'keypair') {
      console.log(chalk.yellow('\n⚠️  Agent will have full access to this wallet'));
      console.log(chalk.gray('The private key enables autonomous transaction signing\n'));

      const keySource = await select({
        message: 'How would you like to provide the private key?',
        choices: [
          { name: 'Paste base58 private key (easiest)', value: 'base58' },
          { name: 'Load from keypair JSON file', value: 'file' },
        ],
      });

      if (keySource === 'base58') {
        const privateKey = await password({
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
        const publicKey = keypair.publicKey.toBase58();

        walletConfig = {
          provider: 'solana-agent-kit',
          privateKey,
          publicKey,
        };

        console.log(chalk.green('\n✓ Keypair validated'));
        console.log(chalk.white(`  Public Key: ${publicKey}\n`));

      } else if (keySource === 'file') {
        const keypath = await input({
          message: 'Path to keypair JSON file:',
          default: '~/.config/solana/id.json',
        });

        // Expand ~ to home directory
        const expandedPath = keypath.replace(/^~/, process.env.HOME || process.env.USERPROFILE);

        // Load and convert to base58
        const keypairData = JSON.parse(await fs.readFile(expandedPath, 'utf-8'));
        const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
        const privateKey = bs58.encode(keypair.secretKey);
        const publicKey = keypair.publicKey.toBase58();

        walletConfig = {
          provider: 'solana-agent-kit',
          privateKey,
          publicKey,
        };

        console.log(chalk.green('\n✓ Keypair loaded from file'));
        console.log(chalk.white(`  Public Key: ${publicKey}\n`));
      }

    } else if (walletType === 'generate') {
      const keypair = Keypair.generate();
      const privateKey = bs58.encode(keypair.secretKey);
      const publicKey = keypair.publicKey.toBase58();

      console.log(chalk.green('\n✓ New keypair generated!'));
      console.log(chalk.yellow('\n⚠️  SAVE THIS PRIVATE KEY - You will not see it again!\n'));
      console.log(chalk.white(`Public Key:  ${chalk.cyan(publicKey)}`));
      console.log(chalk.white(`Private Key: ${chalk.cyan(privateKey)}\n`));

      const confirmed = await confirm({
        message: 'Have you saved the private key securely?',
        default: false,
      });

      if (!confirmed) {
        console.log(chalk.red('\nSetup cancelled. Please save your keys and try again.'));
        process.exit(0);
      }

      walletConfig = {
        provider: 'solana-agent-kit',
        privateKey,
        publicKey,
      };

    } else if (walletType === 'crossmint') {
      console.log(chalk.yellow('\n⚠️  Crossmint only supports basic wallet operations'));
      console.log(chalk.gray('For full DeFi access, use keypair mode instead\n'));

      const apiKey = await password({
        message: 'Enter Crossmint API key:',
      });
      const email = await input({
        message: 'Email to link wallet to:',
      });
      walletConfig = {
        provider: 'crossmint',
        apiKey,
        email,
        environment: 'production',
      };
    }

    // Step 2: RPC Configuration
    console.log(chalk.yellow('\n\nStep 2: RPC Configuration'));
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

    // Step 3: Plugin Selection (for solana-agent-kit)
    let plugins = {};
    if (walletConfig.provider === 'solana-agent-kit') {
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

      selectedPlugins.forEach(plugin => {
        plugins[plugin] = true;
      });
    }

    // Step 4: Additional API Keys (optional)
    console.log(chalk.yellow('\n\nStep 4: Additional API Keys (Optional)'));
    console.log(chalk.gray('These enhance functionality but are not required\n'));

    const apiKeys = {};

    const needsOpenAI = await confirm({
      message: 'Add OpenAI API key? (for LangChain integration)',
      default: false,
    });

    if (needsOpenAI) {
      apiKeys.openai = await password({
        message: 'Enter OpenAI API key:',
      });
    }

    // Build config
    const config = {
      wallet: walletConfig,
      plugins: plugins,
      preferences: {
        rpcUrl,
        defaultSlippage: parseInt(defaultSlippage),
      },
      setupComplete: true,
      setupDate: new Date().toISOString(),
    };

    // Save config
    const configPath = path.join(__dirname, 'config', 'solana-config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    // Create .env file
    const envLines = [
      '# SolClaw Configuration',
      '# Generated by setup-solana.js',
      '',
    ];

    if (walletConfig.privateKey) {
      envLines.push(`SOLANA_PRIVATE_KEY=${walletConfig.privateKey}`);
    }

    if (walletConfig.apiKey) {
      envLines.push(`CROSSMINT_API_KEY=${walletConfig.apiKey}`);
      envLines.push(`CROSSMINT_ENVIRONMENT=production`);
    }

    if (apiKeys.openai) {
      envLines.push(`OPENAI_API_KEY=${apiKeys.openai}`);
    }

    envLines.push(`SOLANA_RPC_URL=${rpcUrl}`);

    const envPath = path.join(__dirname, '.env.solana');
    await fs.writeFile(envPath, envLines.join('\n'));

    // Summary
    console.log(chalk.green.bold('\n\n✅ Setup Complete!\n'));
    console.log(chalk.white('Configuration saved to:'));
    console.log(chalk.cyan(`  ${configPath}`));
    console.log(chalk.cyan(`  ${envPath}\n`));

    if (walletConfig.provider === 'solana-agent-kit') {
      console.log(chalk.white('Your agent has access to:'));
      console.log(chalk.cyan(`  • 60+ Solana actions via Solana Agent Kit`));
      console.log(chalk.cyan(`  • ${Object.keys(plugins).length} plugins enabled`));
      console.log(chalk.cyan(`  • Autonomous transaction signing\n`));
    }

    console.log(chalk.yellow('Next steps:'));
    console.log('1. Review config: cat config/solana-config.json');
    console.log('2. Test agent: npm test');
    console.log('3. Fund wallet: solana airdrop 1 ' + (walletConfig.publicKey || ''));
    console.log('4. Start using: npm start');

    console.log(chalk.gray('\n\nNeed help? Check solana-agent-kit-integration.md\n'));

  } catch (error) {
    if (error.message === 'User force closed the prompt') {
      console.log(chalk.yellow('\n\nSetup cancelled.'));
      process.exit(0);
    }
    console.error(chalk.red('\n\nSetup failed:'), error.message);
    process.exit(1);
  }
}

main();
