/**
 * Solana Command Handler
 * Processes Solana-related commands from WhatsApp/Telegram
 */

import {
  createSolanaAgent,
  loadAgentConfig,
  isSolanaConfigured,
  COMMON_TOKENS,
} from './index.js';
import { logger } from '../logger.js';

/**
 * Check if user message is a Solana command
 */
export function isSolanaCommand(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  // Keywords that indicate Solana operations
  const solanaKeywords = [
    'balance',
    'swap',
    'trade',
    'stake',
    'lend',
    'deploy token',
    'mint nft',
    'sol',
    'usdc',
    'price of',
    'trending tokens',
    '.sol', // domains
  ];

  return solanaKeywords.some(keyword => lowerMessage.includes(keyword));
}

/**
 * Handle Solana commands
 */
export async function handleSolanaCommand(message: string): Promise<string> {
  try {
    // Check if Solana is configured
    const isConfigured = await isSolanaConfigured();
    if (!isConfigured) {
      return `❌ *Solana not configured*

To use Solana features, run:
\`\`\`
npm run setup:solana
\`\`\`

This will set up your wallet and enable Solana operations.`;
    }

    // Load agent
    const config = await loadAgentConfig();
    const agent = createSolanaAgent(config);

    const lowerMessage = message.toLowerCase();

    // Check balance
    if (lowerMessage.includes('balance')) {
      const balance = await agent.getBalanceSOL();
      return `💰 *Balance*

${balance.toFixed(6)} SOL

Address: \`${agent.publicKey}\``;
    }

    // Swap tokens
    if (lowerMessage.includes('swap') || lowerMessage.includes('trade')) {
      // Parse: "swap 0.1 SOL for USDC"
      const amountMatch = message.match(/(\d+\.?\d*)\s*sol/i);
      if (!amountMatch) {
        return '❌ Please specify amount (e.g., "swap 0.1 SOL for USDC")';
      }

      const amount = parseFloat(amountMatch[1]);
      const balance = await agent.getBalanceSOL();

      if (amount > balance) {
        return `❌ Insufficient balance

Requested: ${amount} SOL
Available: ${balance.toFixed(6)} SOL`;
      }

      // Determine output token
      let outputMint = COMMON_TOKENS.USDC;
      let outputName = 'USDC';

      if (lowerMessage.includes('usdt')) {
        outputMint = COMMON_TOKENS.USDT;
        outputName = 'USDT';
      } else if (lowerMessage.includes('bonk')) {
        outputMint = COMMON_TOKENS.BONK;
        outputName = 'BONK';
      }

      logger.info(`Executing swap: ${amount} SOL → ${outputName}`);

      const signature = await agent.swap(outputMint, amount, null, 50);

      return `✅ *Swap Successful*

${amount} SOL → ${outputName}

Transaction: [View on Solscan](https://solscan.io/tx/${signature})

\`${signature}\``;
    }

    // Stake SOL
    if (lowerMessage.includes('stake')) {
      const amountMatch = message.match(/(\d+\.?\d*)\s*sol/i);
      if (!amountMatch) {
        return '❌ Please specify amount (e.g., "stake 1 SOL")';
      }

      const amount = parseFloat(amountMatch[1]);
      logger.info(`Staking ${amount} SOL`);

      const signature = await agent.stake(amount);

      return `✅ *Staking Successful*

Staked: ${amount} SOL

Transaction: [View on Solscan](https://solscan.io/tx/${signature})

\`${signature}\``;
    }

    // Get token price
    if (lowerMessage.includes('price of')) {
      const tokenMatch = message.match(/price of (\w+)/i);
      if (!tokenMatch) {
        return '❌ Please specify token (e.g., "price of SOL")';
      }

      const token = tokenMatch[1].toUpperCase();
      let mint = COMMON_TOKENS.SOL;

      if (token === 'USDC') mint = COMMON_TOKENS.USDC;
      else if (token === 'BONK') mint = COMMON_TOKENS.BONK;
      else if (token === 'JUP') mint = COMMON_TOKENS.JUP;

      const price = await agent.getPrice(mint);

      return `💵 *${token} Price*

$${price.toFixed(4)}`;
    }

    // Trending tokens
    if (lowerMessage.includes('trending')) {
      const trending = await agent.getTrendingTokens();

      let response = '🔥 *Trending Tokens*\n\n';
      trending.slice(0, 5).forEach((token: any, i: number) => {
        response += `${i + 1}. ${token.symbol || 'Unknown'}\n`;
      });

      return response;
    }

    // Default: show available commands
    return `🦀 *Solana Commands*

• _balance_ - Check SOL balance
• _swap 0.1 SOL for USDC_ - Swap tokens
• _stake 1 SOL_ - Stake SOL
• _price of SOL_ - Get token price
• _trending tokens_ - Show trending tokens

Try: "What's my balance?"`;

  } catch (error: any) {
    logger.error('Solana command error:', error);
    return `❌ *Error*

${error.message}

Common issues:
• Insufficient balance
• RPC rate limit
• Network congestion`;
  }
}
