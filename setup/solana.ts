/**
 * Solana setup step
 * Configures Solana wallet with standard (local keypair) or Crossmint (custodial) signing
 */

import { select, password, input, confirm } from '@inquirer/prompts';
import fs from 'fs/promises';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import chalk from 'chalk';
import { emitStatus } from './status.js';

/**
 * Parse CLI args into a key-value map.
 * Supports: --signing standard --key-source generate --network mainnet --slippage 50
 *           --private-key <key> --key-path <path> --rpc-url <url>
 *           --crossmint-key <key> --crossmint-env production --public-key <key>
 *           --dflow-key <key> --jupiter-key <key> --breeze-key <key> --helius-key <key>
 */
function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return result;
}

export async function run(args: string[]): Promise<void> {
  console.log(chalk.cyan.bold('\n🦀 Solana Configuration\n'));
  console.log('Configure wallet and enable Solana protocol operations.\n');

  emitStatus('SOLANA_SETUP', { STATUS: 'starting' });

  // Parse CLI args for non-interactive mode
  const cliArgs = parseArgs(args);
  const nonInteractive = !!cliArgs.signing;

  try {
    // Step 1: Signing Method
    console.log(chalk.yellow('Step 1: Signing Method'));

    const signingMethod: 'standard' | 'crossmint' = cliArgs.signing
      ? (cliArgs.signing as 'standard' | 'crossmint')
      : await select({
          message: 'How should transactions be signed?',
          choices: [
            {
              name: 'Standard (local keypair) — recommended',
              value: 'standard' as const,
            },
            {
              name: 'Crossmint (custodial API)',
              value: 'crossmint' as const,
            },
          ],
        });

    let publicKey: string;
    let privateKey: string | undefined;
    let crossmintApiKey: string | undefined;
    let crossmintEnvironment: string | undefined;

    if (signingMethod === 'standard') {
      // Standard path: local keypair
      console.log(chalk.yellow('\nStep 2: Wallet Configuration'));

      const keySource = cliArgs['key-source']
        ? cliArgs['key-source']
        : await select({
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

      if (keySource === 'base58') {
        privateKey = cliArgs['private-key']
          ? cliArgs['private-key']
          : await password({
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

        // Validate the key
        try {
          const decoded = bs58.decode(privateKey);
          if (decoded.length !== 64) throw new Error('Invalid key length (expected 64 bytes)');
        } catch (e) {
          throw new Error(`Invalid base58 private key: ${e instanceof Error ? e.message : String(e)}`);
        }

        const secretKey = bs58.decode(privateKey);
        const keypair = Keypair.fromSecretKey(secretKey);
        publicKey = keypair.publicKey.toBase58();

        console.log(chalk.green('\n✓ Keypair validated'));
        console.log(chalk.white(`  Public Key: ${publicKey}\n`));
      } else if (keySource === 'file') {
        const keypath = cliArgs['key-path']
          ? cliArgs['key-path']
          : await input({
              message: 'Path to keypair JSON file:',
              default: '~/.config/solana/id.json',
            });

        const expandedPath = keypath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
        const keypairData = JSON.parse(await fs.readFile(expandedPath, 'utf-8'));
        const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
        privateKey = bs58.encode(keypair.secretKey);
        publicKey = keypair.publicKey.toBase58();

        console.log(chalk.green('\n✓ Keypair loaded from file'));
        console.log(chalk.white(`  Public Key: ${publicKey}\n`));
      } else {
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
    } else {
      // Crossmint path
      console.log(chalk.yellow('\nStep 2: Crossmint Configuration'));

      crossmintApiKey = cliArgs['crossmint-key']
        ? cliArgs['crossmint-key']
        : await password({
            message: 'Crossmint API key:',
            validate: (value) => value.length > 0 ? true : 'API key is required',
          });

      crossmintEnvironment = cliArgs['crossmint-env']
        ? cliArgs['crossmint-env']
        : await select({
            message: 'Crossmint environment:',
            choices: [
              { name: 'Production', value: 'production' },
              { name: 'Staging', value: 'staging' },
            ],
          });

      publicKey = cliArgs['public-key']
        ? cliArgs['public-key']
        : await input({
            message: 'Wallet public key (or leave blank to create via Crossmint):',
            default: '',
          });

      if (!publicKey) {
        console.log(chalk.yellow('\nNote: A wallet will be created via Crossmint on first use.'));
        publicKey = 'pending-crossmint-creation';
      }
    }

    // Step 3: RPC Configuration
    console.log(chalk.yellow('\nStep 3: RPC Configuration'));

    const networkChoice = cliArgs.network
      ? cliArgs.network
      : await select({
          message: 'Select Solana network:',
          choices: [
            { name: 'Mainnet (Production - real SOL)', value: 'mainnet' },
            { name: 'Devnet (Testing - free airdrops available)', value: 'devnet' },
            { name: 'Testnet', value: 'testnet' },
            { name: 'Custom RPC URL', value: 'custom' },
          ],
        });

    let rpcUrl: string;

    if (networkChoice === 'mainnet') {
      rpcUrl = 'https://api.mainnet-beta.solana.com';
      console.log(chalk.cyan('Using Mainnet'));
    } else if (networkChoice === 'devnet') {
      rpcUrl = 'https://api.devnet.solana.com';
      console.log(chalk.cyan('Using Devnet (recommended for testing)'));
      if (signingMethod === 'standard') {
        console.log(chalk.gray('Get free SOL: solana airdrop 1 ' + publicKey + ' --url devnet'));
      }
    } else if (networkChoice === 'testnet') {
      rpcUrl = 'https://api.testnet.solana.com';
      console.log(chalk.cyan('Using Testnet'));
    } else if (cliArgs['rpc-url']) {
      rpcUrl = cliArgs['rpc-url'];
    } else {
      rpcUrl = await input({
        message: 'Enter custom RPC URL:',
        default: 'https://api.mainnet-beta.solana.com',
        validate: (value) => {
          return value.startsWith('http') ? true : 'Must be a valid HTTP(S) URL';
        },
      });
    }

    const defaultSlippage = cliArgs.slippage
      ? cliArgs.slippage
      : nonInteractive
        ? '50'
        : await input({
            message: 'Default slippage (basis points):',
            default: '50',
            validate: (value) => {
              const num = parseInt(value);
              return num >= 0 && num <= 1000 ? true : 'Must be between 0 and 1000';
            },
          });

    // Step 4: Optional Protocol API Keys
    console.log(chalk.yellow('\nStep 4: Optional Protocol API Keys'));
    console.log(chalk.gray('These are optional. The agent works without them but some protocols offer better rates or features with an API key.\n'));

    const protocolKeys: Record<string, string> = {};

    if (cliArgs['dflow-key']) {
      protocolKeys.DFLOW_API_KEY = cliArgs['dflow-key'];
    } else if (!nonInteractive) {
      const wantsDflow = await confirm({ message: 'Do you have a DFlow API key?', default: false });
      if (wantsDflow) {
        const key = await password({ message: 'DFlow API key:' });
        if (key) protocolKeys.DFLOW_API_KEY = key;
      }
    }

    if (cliArgs['jupiter-key']) {
      protocolKeys.JUPITER_API_KEY = cliArgs['jupiter-key'];
    } else if (!nonInteractive) {
      const wantsJupiter = await confirm({ message: 'Do you have a Jupiter API key?', default: false });
      if (wantsJupiter) {
        const key = await password({ message: 'Jupiter API key:' });
        if (key) protocolKeys.JUPITER_API_KEY = key;
      }
    }

    if (cliArgs['breeze-key']) {
      protocolKeys.BREEZE_API_KEY = cliArgs['breeze-key'];
    } else if (!nonInteractive) {
      const wantsBreeze = await confirm({ message: 'Do you have a Breeze API key?', default: false });
      if (wantsBreeze) {
        const key = await password({ message: 'Breeze API key:' });
        if (key) protocolKeys.BREEZE_API_KEY = key;
      }
    }

    if (cliArgs['helius-key']) {
      protocolKeys.HELIUS_API_KEY = cliArgs['helius-key'];
    } else if (!nonInteractive) {
      const wantsHelius = await confirm({ message: 'Do you have a Helius API key?', default: false });
      if (wantsHelius) {
        const key = await password({ message: 'Helius API key:' });
        if (key) protocolKeys.HELIUS_API_KEY = key;
      }
    }

    // Build config
    const config: Record<string, any> = {
      wallet: {
        signingMethod,
        publicKey,
        ...(privateKey && { privateKey }),
        ...(crossmintApiKey && { crossmintApiKey }),
        ...(crossmintEnvironment && { crossmintEnvironment }),
      },
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
      `SOLANA_RPC_URL=${rpcUrl}`,
      `SOLANA_SIGNING_METHOD=${signingMethod}`,
    ];

    if (privateKey) {
      envLines.push(`SOLANA_PRIVATE_KEY=${privateKey}`);
    }
    if (crossmintApiKey) {
      envLines.push(`CROSSMINT_API_KEY=${crossmintApiKey}`);
    }

    envLines.push('');

    const envPath = path.join(process.cwd(), '.env.solana');
    await fs.writeFile(envPath, envLines.join('\n'));

    // Append protocol API keys to .env (read by container-runner)
    if (Object.keys(protocolKeys).length > 0) {
      const mainEnvPath = path.join(process.cwd(), '.env');
      let existing = '';
      try {
        existing = await fs.readFile(mainEnvPath, 'utf-8');
      } catch {
        // .env doesn't exist yet, that's fine
      }

      const newLines: string[] = [];
      if (existing && !existing.endsWith('\n')) newLines.push('');
      newLines.push('# Protocol API Keys (added by Solana setup)');
      for (const [key, value] of Object.entries(protocolKeys)) {
        // Remove existing line for this key if present
        if (existing.includes(`${key}=`)) {
          existing = existing
            .split('\n')
            .filter((line) => !line.startsWith(`${key}=`))
            .join('\n');
        }
        newLines.push(`${key}=${value}`);
      }
      newLines.push('');

      await fs.writeFile(mainEnvPath, existing + newLines.join('\n'));
    }

    // Summary
    console.log(chalk.green.bold('\n✅ Solana Configuration Complete!\n'));
    console.log(chalk.white('Configuration saved to:'));
    console.log(chalk.cyan(`  ${configPath}`));
    console.log(chalk.cyan(`  ${envPath}\n`));

    console.log(chalk.white(`Signing method: ${chalk.cyan(signingMethod)}`));
    console.log(chalk.white(`Network: ${chalk.cyan(rpcUrl)}\n`));

    console.log(chalk.white('Your agent can now:'));
    console.log(chalk.cyan('  • Check wallet balances'));
    console.log(chalk.cyan('  • Get token prices via Jupiter'));
    console.log(chalk.cyan('  • Swap tokens via Jupiter Ultra'));
    console.log(chalk.cyan('  • Transfer SOL and SPL tokens'));
    console.log(chalk.cyan('  • Access DeFi protocols via skills\n'));

    emitStatus('SOLANA_SETUP', {
      STATUS: 'complete',
      PUBLIC_KEY: publicKey,
      RPC_URL: rpcUrl,
      SIGNING_METHOD: signingMethod,
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
