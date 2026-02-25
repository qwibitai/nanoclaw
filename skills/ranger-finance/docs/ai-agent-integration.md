# Ranger Finance AI Agent Integration Guide

This guide covers integrating Ranger Finance with AI agents using the MCP (Model Context Protocol) server.

## Overview

Ranger provides an MCP server that exposes trading capabilities as tools for AI agents. This enables:

- Automated trading strategies
- Natural language trade execution
- Portfolio monitoring and management
- Market analysis with real-time data

## Installation

### Prerequisites

- Python 3.10+
- pip or uv package manager

### Install Dependencies

```bash
pip install mcp-agent numpy
```

Or using uv:

```bash
uv pip install mcp-agent numpy
```

### Clone the Agent Kit

```bash
git clone https://github.com/ranger-finance/ranger-agent-kit.git
cd ranger-agent-kit
```

## MCP Server Setup

### Configuration

Create a `.env` file in the `perps-mcp` directory:

```bash
cd perps-mcp
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
RANGER_API_KEY=your_api_key
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
WALLET_PRIVATE_KEY=your_base58_private_key
```

### Starting the Server

```bash
python -m ranger_mcp
```

The server runs on stdio transport by default.

## Available MCP Tools

### SOR (Smart Order Router) Tools

#### `sor_get_trade_quote`

Get pricing quotes for potential trades.

**Parameters**:
- `symbol`: Trading pair (e.g., "SOL")
- `side`: "Long" or "Short"
- `size`: Position size
- `collateral`: Collateral amount

**Returns**: Quote with venue allocations and pricing

---

#### `sor_increase_position`

Open or add to a position.

**Parameters**:
- `symbol`: Trading pair
- `side`: "Long" or "Short"
- `size`: Position size
- `collateral`: Collateral amount

**Returns**: Transaction for signing and execution

---

#### `sor_decrease_position`

Reduce an existing position.

**Parameters**:
- `symbol`: Trading pair
- `side`: "Long" or "Short"
- `size`: Amount to reduce
- `collateral`: Collateral to withdraw
- `venue`: Target venue for the trade

**Returns**: Transaction for signing

---

#### `sor_close_position`

Close a position entirely.

**Parameters**:
- `symbol`: Trading pair
- `side`: "Long" or "Short"
- `venue`: Target venue (optional, use "all" for all venues)

**Returns**: Transaction for signing

---

### Data API Tools

#### `data_get_positions`

Fetch current positions.

**Parameters**:
- `public_key`: Wallet address
- `platforms`: Filter by platforms (optional)
- `symbols`: Filter by symbols (optional)

**Returns**: List of positions with full details

---

#### `data_get_trade_history`

Retrieve historical trades.

**Parameters**:
- `public_key`: Wallet address
- `start_date`: Range start (optional)
- `end_date`: Range end (optional)

**Returns**: List of historical trades

---

#### `data_get_liquidations`

Get liquidation data and signals.

**Sub-tools**:
- `latest`: Most recent liquidations
- `totals`: Aggregated liquidation stats
- `signals`: Liquidation risk signals
- `heatmap`: Visual liquidation distribution
- `largest`: Biggest liquidations

---

#### `data_get_funding_rates`

Funding rate analytics.

**Sub-tools**:
- `arbitrage`: Funding arbitrage opportunities
- `accumulated`: Historical accumulated rates
- `extreme`: Extreme funding events
- `oi_weighted`: Open interest weighted rates
- `trend`: Funding trend analysis

---

## Example Agents

### Mean Reversion Agent

A simple mean reversion strategy:

```python
import asyncio
from mcp_agent import Agent, Tool
from ranger_mcp import RangerMCPClient

async def mean_reversion_agent():
    # Initialize MCP client
    client = RangerMCPClient()
    await client.connect()

    # Create agent with Ranger tools
    agent = Agent(
        name="MeanReversionBot",
        tools=[
            Tool.from_mcp(client, "sor_get_trade_quote"),
            Tool.from_mcp(client, "sor_increase_position"),
            Tool.from_mcp(client, "sor_close_position"),
            Tool.from_mcp(client, "data_get_positions"),
            Tool.from_mcp(client, "data_get_liquidations"),
        ],
    )

    # Agent loop
    while True:
        # Get liquidation signals
        signals = await agent.call_tool(
            "data_get_liquidations",
            {"type": "signals"}
        )

        # Check for mean reversion opportunities
        for signal in signals:
            if signal["z_score"] > 2.0:
                # Price is elevated, consider short
                quote = await agent.call_tool(
                    "sor_get_trade_quote",
                    {
                        "symbol": signal["symbol"],
                        "side": "Short",
                        "size": 0.1,
                        "collateral": 10,
                    }
                )
                # Execute if conditions met
                if quote["total_cost"] < 15:
                    await agent.call_tool(
                        "sor_increase_position",
                        {
                            "symbol": signal["symbol"],
                            "side": "Short",
                            "size": 0.1,
                            "collateral": 10,
                        }
                    )

        await asyncio.sleep(60)  # Check every minute

if __name__ == "__main__":
    asyncio.run(mean_reversion_agent())
```

### Portfolio Monitor Agent

```python
import asyncio
from mcp_agent import Agent, Tool
from ranger_mcp import RangerMCPClient

async def portfolio_monitor():
    client = RangerMCPClient()
    await client.connect()

    agent = Agent(
        name="PortfolioMonitor",
        tools=[
            Tool.from_mcp(client, "data_get_positions"),
        ],
    )

    wallet = "YOUR_WALLET_ADDRESS"

    while True:
        positions = await agent.call_tool(
            "data_get_positions",
            {"public_key": wallet}
        )

        total_pnl = sum(p["unrealized_pnl"] for p in positions["positions"])
        total_collateral = sum(p["real_collateral"] for p in positions["positions"])

        print(f"Portfolio Summary:")
        print(f"  Positions: {len(positions['positions'])}")
        print(f"  Total Collateral: ${total_collateral:.2f}")
        print(f"  Total PnL: ${total_pnl:.2f}")

        # Check for risky positions
        for pos in positions["positions"]:
            risk = abs(pos["liquidation_price"] - pos["entry_price"]) / pos["entry_price"]
            if risk < 0.1:  # Within 10% of liquidation
                print(f"  WARNING: {pos['symbol']} position at risk!")

        await asyncio.sleep(30)

if __name__ == "__main__":
    asyncio.run(portfolio_monitor())
```

### Conversational Trading Agent

```python
from mcp_agent import Agent, Tool, LLM
from ranger_mcp import RangerMCPClient

async def conversational_trader():
    client = RangerMCPClient()
    await client.connect()

    # Create LLM-powered agent
    agent = Agent(
        name="TradingAssistant",
        llm=LLM(model="claude-3-opus"),
        tools=[
            Tool.from_mcp(client, "sor_get_trade_quote"),
            Tool.from_mcp(client, "sor_increase_position"),
            Tool.from_mcp(client, "sor_close_position"),
            Tool.from_mcp(client, "data_get_positions"),
        ],
        system_prompt="""
        You are a trading assistant for Solana perpetual futures.
        You can help users:
        - Get quotes for trades
        - Open and close positions
        - Monitor their portfolio
        Always confirm before executing trades.
        """,
    )

    # Interactive loop
    while True:
        user_input = input("You: ")
        if user_input.lower() == "quit":
            break

        response = await agent.chat(user_input)
        print(f"Assistant: {response}")

if __name__ == "__main__":
    asyncio.run(conversational_trader())
```

## Integration with Claude Desktop

Add to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "ranger": {
      "command": "python",
      "args": ["-m", "ranger_mcp"],
      "cwd": "/path/to/ranger-agent-kit/perps-mcp",
      "env": {
        "RANGER_API_KEY": "your_api_key"
      }
    }
  }
}
```

## Security Considerations

1. **Private Key Management**: Never hardcode private keys. Use environment variables or secure key management.

2. **Transaction Signing**: The MCP server returns base64-encoded transactions. Sign them externally with your wallet.

3. **Rate Limiting**: Respect API rate limits in your agents to avoid being throttled.

4. **Risk Management**: Always implement position size limits and stop-loss logic in your agents.

## Resources

- [Ranger Agent Kit](https://github.com/ranger-finance/ranger-agent-kit)
- [MCP Agent Framework](https://github.com/mcp-agent/mcp-agent)
- [Ranger Finance](https://ranger.finance)
