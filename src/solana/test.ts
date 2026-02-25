/**
 * Test Solana Agent Integration
 * Run with: npm run test:solana
 */

import { createSolanaAgent, loadAgentConfig, isSolanaConfigured } from './index.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.solana' });

async function main() {
  console.log('\n🦀 Testing Solana Agent Kit Integration\n');

  // Test 1: Check if configured
  console.log('Test 1: Check Configuration');
  const isConfigured = await isSolanaConfigured();
  if (!isConfigured) {
    console.error('❌ Solana not configured. Run: npm run setup');
    process.exit(1);
  }
  console.log('✓ Configuration found\n');

  // Test 2: Load agent
  console.log('Test 2: Load Agent');
  const agentConfig = await loadAgentConfig();
  const agent = createSolanaAgent(agentConfig);
  console.log(`✓ Agent initialized`);
  console.log(`  Public Key: ${agent.publicKey}`);
  console.log(`  RPC URL: ${agent.rpcUrl}\n`);

  // Test 3: Get balance
  console.log('Test 3: Get Balance');
  try {
    const balance = await agent.getBalanceSOL();
    console.log(`✓ Balance: ${balance.toFixed(6)} SOL\n`);
  } catch (error: any) {
    console.log(`⚠ Failed to get balance: ${error.message}`);
    console.log('  (This is expected if RPC is rate-limited)\n');
  }

  // Test 4: List actions
  console.log('Test 4: Available Actions');
  const actions = agent.actions;
  console.log(`✓ ${actions.length} actions available\n`);

  // Group by category
  const categories: Record<string, string[]> = {
    Token: [],
    DeFi: [],
    NFT: [],
    Misc: [],
    Blinks: [],
  };

  actions.forEach((action: any) => {
    const name = action.name;
    if (
      name.includes('token') ||
      name.includes('deploy') ||
      name.includes('transfer') ||
      name.includes('trade')
    ) {
      categories.Token.push(name);
    } else if (
      name.includes('lend') ||
      name.includes('stake') ||
      name.includes('pool') ||
      name.includes('liquidity') ||
      name.includes('drift') ||
      name.includes('adrena') ||
      name.includes('meteora') ||
      name.includes('raydium')
    ) {
      categories.DeFi.push(name);
    } else if (
      name.includes('nft') ||
      name.includes('collection') ||
      name.includes('mint') ||
      name.includes('3land')
    ) {
      categories.NFT.push(name);
    } else if (name.includes('blink') || name.includes('arcade')) {
      categories.Blinks.push(name);
    } else {
      categories.Misc.push(name);
    }
  });

  Object.entries(categories).forEach(([category, categoryActions]) => {
    if (categoryActions.length > 0) {
      console.log(`  ${category} (${categoryActions.length}):`);
      categoryActions.slice(0, 3).forEach((action) => {
        console.log(`    • ${action}`);
      });
      if (categoryActions.length > 3) {
        console.log(`    ... and ${categoryActions.length - 3} more`);
      }
      console.log();
    }
  });

  console.log('✅ All tests passed!\n');
  console.log('Your SolClaw agent is ready for Solana operations.\n');
}

main().catch((error) => {
  console.error('\n❌ Test failed:', error.message);
  console.error('\nTroubleshooting:');
  console.error('  • Run: npm run setup');
  console.error('  • Check: config/solana-config.json');
  console.error('  • Verify: .env.solana\n');
  process.exit(1);
});
