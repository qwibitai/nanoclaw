# Solana Module

Autonomous Solana operations for SolClaw via Solana Agent Kit.

## Quick Start

### 1. Setup
```bash
npm run setup:solana
```

### 2. Test
```bash
npm run test:solana
```

### 3. Use in Chat

Send messages to your WhatsApp/Telegram bot:

- "What's my balance?"
- "Swap 0.1 SOL for USDC"
- "Stake 1 SOL"
- "Price of BONK"

## Files

- `agent.ts` - SolanaAgent class with 60+ actions
- `config.ts` - Configuration management
- `handler.ts` - WhatsApp/Telegram command handler
- `test.ts` - Integration tests
- `index.ts` - Public exports
- `examples/` - Usage examples

## Integration Status

✅ **Done:**
- TypeScript module created
- Configuration system
- Handler for chat commands
- Full type safety
- 60+ actions available

⏳ **TODO:**
- Integrate handler into router
- Add to main setup flow
- Test with real messages

## Usage in Code

```typescript
import { createSolanaAgent, loadAgentConfig } from './solana/index.js';

// Load agent
const config = await loadAgentConfig();
const agent = createSolanaAgent(config);

// Use it
const balance = await agent.getBalanceSOL();
await agent.swap(usdcMint, 0.1, null, 50);
```

## Usage in Chat

The handler (`handler.ts`) automatically processes:

- Balance checks
- Token swaps
- Staking operations
- Price queries
- Trending tokens

Just send natural language messages!

## Configuration

Setup creates:
- `config/solana-config.json` - Agent config
- `.env.solana` - Private key (gitignored)

Both are protected in `.gitignore`.

## See Also

- `INTEGRATION_GUIDE.md` - How to connect to router
- `CLEANUP_SUMMARY.md` - File structure
- `SOLANA_INTEGRATION.md` - Technical details
