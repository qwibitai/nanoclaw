# Solana MCP Server Setup for Claude

Configure Claude Desktop to interact with Solana blockchain using the Model Context Protocol (MCP) server.

## Overview

The Solana MCP server enables Claude to:
- Execute Solana transactions
- Check wallet balances
- Swap tokens
- Deploy tokens and NFTs
- Interact with DeFi protocols

## Installation

### Option 1: Quick Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/sendaifun/solana-mcp/main/scripts/install.sh -o solana-mcp-install.sh
chmod +x solana-mcp-install.sh
./solana-mcp-install.sh --backup
```

### Option 2: NPM Global Install

```bash
npm install -g solana-mcp
```

### Option 3: Build from Source

```bash
git clone https://github.com/sendaifun/solana-mcp
cd solana-mcp
pnpm install
pnpm run build
```

## Configuration

### 1. Prepare Environment Variables

Create a `.env` file or note these values:

```bash
# Required
SOLANA_PRIVATE_KEY=your_base58_encoded_private_key
RPC_URL=https://api.mainnet-beta.solana.com

# Optional (for enhanced features)
OPENAI_API_KEY=sk-...
HELIUS_API_KEY=your_helius_key
```

### 2. Configure Claude Desktop

Locate your Claude Desktop config file:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

### 3. Add MCP Server Configuration

#### Using NPX (Simplest)

```json
{
  "mcpServers": {
    "solana": {
      "command": "npx",
      "args": ["solana-mcp"],
      "env": {
        "RPC_URL": "https://api.mainnet-beta.solana.com",
        "SOLANA_PRIVATE_KEY": "your_base58_private_key",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

#### Using Global Install

```json
{
  "mcpServers": {
    "solana": {
      "command": "solana-mcp",
      "env": {
        "RPC_URL": "https://api.mainnet-beta.solana.com",
        "SOLANA_PRIVATE_KEY": "your_base58_private_key"
      }
    }
  }
}
```

#### Using Node Directly

```json
{
  "mcpServers": {
    "solana": {
      "command": "node",
      "args": ["/path/to/solana-mcp/dist/index.js"],
      "env": {
        "RPC_URL": "https://api.devnet.solana.com",
        "SOLANA_PRIVATE_KEY": "your_base58_private_key"
      }
    }
  }
}
```

### 4. Restart Claude Desktop

After saving the config, restart Claude Desktop for changes to take effect.

## Available Tools

Once configured, Claude can use these Solana tools:

| Tool | Description |
|------|-------------|
| `WALLET_ADDRESS` | Get wallet public address |
| `BALANCE` | Check SOL or token balance |
| `TRANSFER` | Send SOL or tokens |
| `TRADE` | Swap tokens via Jupiter |
| `DEPLOY_TOKEN` | Create new SPL token |
| `MINT_NFT` | Create NFT |
| `GET_ASSET` | Get token/NFT information |
| `GET_PRICE` | Fetch token price |
| `REQUEST_FUNDS` | Get devnet SOL |
| `RESOLVE_DOMAIN` | Lookup .sol domain |
| `GET_TPS` | Check network TPS |

## Usage Examples

### Check Balance

```
Claude, what's my SOL balance?
```

Claude will use the `BALANCE` tool to query your wallet.

### Swap Tokens

```
Claude, swap 0.1 SOL for USDC using Jupiter
```

Claude will:
1. Check your balance
2. Get the best route via Jupiter
3. Execute the swap
4. Report the result

### Deploy Token

```
Claude, create a new token called "MyToken" with symbol "MTK" and 9 decimals
```

### Send Tokens

```
Claude, send 10 USDC to address ABC123...
```

### Get Token Info

```
Claude, what's the current price of SOL?
```

## Network Selection

### Devnet (Testing)

```json
{
  "mcpServers": {
    "solana": {
      "command": "npx",
      "args": ["solana-mcp"],
      "env": {
        "RPC_URL": "https://api.devnet.solana.com",
        "SOLANA_PRIVATE_KEY": "your_devnet_key"
      }
    }
  }
}
```

### Mainnet (Production)

```json
{
  "mcpServers": {
    "solana": {
      "command": "npx",
      "args": ["solana-mcp"],
      "env": {
        "RPC_URL": "https://api.mainnet-beta.solana.com",
        "SOLANA_PRIVATE_KEY": "your_mainnet_key"
      }
    }
  }
}
```

### Using Helius RPC (Recommended for Production)

```json
{
  "mcpServers": {
    "solana": {
      "command": "npx",
      "args": ["solana-mcp"],
      "env": {
        "RPC_URL": "https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY",
        "SOLANA_PRIVATE_KEY": "your_key",
        "HELIUS_API_KEY": "YOUR_HELIUS_KEY"
      }
    }
  }
}
```

## Security Best Practices

### 1. Use Dedicated Wallet

Create a separate wallet for Claude operations:

```bash
# Generate new keypair
solana-keygen new -o claude-wallet.json

# Fund with small amount for testing
solana airdrop 1 $(solana-keygen pubkey claude-wallet.json) --url devnet
```

### 2. Limit Funds

Only keep necessary funds in the Claude-accessible wallet.

### 3. Use Devnet First

Always test on devnet before using mainnet:

```json
{
  "env": {
    "RPC_URL": "https://api.devnet.solana.com"
  }
}
```

### 4. Monitor Activity

Regularly check wallet activity:

```bash
solana transaction-history YOUR_WALLET_ADDRESS --url mainnet-beta
```

### 5. Rotate Keys

Periodically rotate the wallet used with Claude.

## Troubleshooting

### MCP Server Not Starting

1. Check Node.js version (requires v16+):
   ```bash
   node --version
   ```

2. Verify npm package installed:
   ```bash
   npm list -g solana-mcp
   ```

3. Check config file syntax:
   ```bash
   cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | jq
   ```

### Connection Errors

1. Test RPC connection:
   ```bash
   curl YOUR_RPC_URL -X POST -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```

2. Verify private key format (should be base58)

### Tool Not Found

Restart Claude Desktop after config changes.

### Transaction Failures

1. Check wallet balance (need SOL for fees)
2. Verify RPC URL is correct network
3. Check transaction logs in Claude's response

## Multiple Configurations

Run both devnet and mainnet:

```json
{
  "mcpServers": {
    "solana-devnet": {
      "command": "npx",
      "args": ["solana-mcp"],
      "env": {
        "RPC_URL": "https://api.devnet.solana.com",
        "SOLANA_PRIVATE_KEY": "devnet_key"
      }
    },
    "solana-mainnet": {
      "command": "npx",
      "args": ["solana-mcp"],
      "env": {
        "RPC_URL": "https://api.mainnet-beta.solana.com",
        "SOLANA_PRIVATE_KEY": "mainnet_key"
      }
    }
  }
}
```

Then specify which to use: "Using solana-devnet, check my balance"

## Resources

- [Solana MCP GitHub](https://github.com/sendaifun/solana-mcp)
- [MCP Specification](https://modelcontextprotocol.io)
- [Claude Desktop](https://claude.ai/download)
- [Solana Agent Kit Docs](https://docs.sendai.fun)
