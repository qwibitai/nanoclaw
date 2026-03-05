---
name: credit-top-up
description: Top up Vincent service credits. Use when user needs to add data source credits, check credit balances, manage their Vincent subscription, review LLM gas usage, or troubleshoot payment-required (402) errors.
---

# Credit Top-Up

Manage Vincent credits for the NanoClaw agent. Three credit types exist, each with a different top-up mechanism.

**Principle:** Diagnose the credit type that's low, top it up or guide the user to the right place, and verify the fix. Don't make the user figure out which credit system applies — determine it from context (error messages, which tool failed, what they're trying to do).

## Credit Types Overview

| Credit Type | What It Covers | Top-Up Method | Check Balance |
|-------------|---------------|---------------|---------------|
| **Data source credits** | Brave search, Twitter API, other data source calls | x402 USDC payment (self-service) | `vincent_credit_balance` MCP tool |
| **LLM credits** | Claude API usage (tokens consumed by the agent) | Stripe payment link (any amount) | `vincent_llm_credit_balance` MCP tool |
| **Subscription** | Base Vincent service access, monthly platform fee | Stripe via Vincent dashboard | Vincent dashboard |

## 1. Diagnose the Issue

Before topping up, determine which credit type is affected:

- **402 from a data source tool** (Brave search, Twitter, etc.) → Data source credits are empty
- **"insufficient credit" or "payment required" in MCP tool output** → Data source credits
- **Agent stops responding or "credits exhausted" message** → LLM credits are depleted
- **User asks about Claude/LLM usage or token costs** → LLM credit balance
- **User asks about subscription or billing** → Subscription management
- **Agent tools stop working entirely** → Could be subscription lapsed or API key revoked

## 2. Data Source Credits (Self-Service)

Data source credits are prepaid USD balance used for API calls (web search, Twitter, etc.). These can be topped up directly.

### Check Balance

The NanoClaw agent uses `mcp__vincent__vincent_credit_balance` via MCP. From the operator side:

```bash
# Check via the Vincent API directly
curl -s -H "Authorization: Bearer $VINCENT_API_KEY" \
  https://api.heyvincent.ai/api/credits/x402 | jq .
```

This returns available tiers and current balance.

### Top Up

Credits are purchased via USDC on Base network. Available tiers: **$1, $5, $10, $25, $50, $100**.

The NanoClaw agent uses `mcp__vincent__vincent_add_credits` with an `amount` parameter. From the operator side:

```bash
# Initiate a credit purchase (returns payment instructions)
curl -s -X POST \
  -H "Authorization: Bearer $VINCENT_API_KEY" \
  https://api.heyvincent.ai/api/credits/x402/10 | jq .
```

The response contains x402 payment instructions with a USDC deposit address on Base mainnet. The flow:

1. Call the endpoint with desired tier amount
2. Receive a 402 response with a deposit address
3. Send the exact USDC amount to the deposit address
4. Credits are added automatically once payment confirms

### Verify

After payment, re-check the balance to confirm credits were added:

```bash
curl -s -H "Authorization: Bearer $VINCENT_API_KEY" \
  https://api.heyvincent.ai/api/credits/x402 | jq .balance
```

## 3. LLM Credits (Self-Service)

LLM credits cover Claude API usage (tokens consumed by the agent). Each subscription includes $25/month, and additional credits can be purchased at any time.

### Check Balance

The NanoClaw agent uses `mcp__vincent__vincent_llm_credit_balance` via MCP. This returns:
- **includedCreditUsd** — Credits included with the subscription ($25/month)
- **purchasedCreditUsd** — Additional credits purchased
- **usedThisPeriodUsd** — Usage since the last subscription renewal
- **remainingUsd** — Available balance

From the operator side:

```bash
# Check via the Vincent API directly
curl -s -X POST -H "Authorization: Bearer $VINCENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vincent_llm_credit_balance","arguments":{}}}' \
  https://api.heyvincent.ai/mcp | jq .result
```

### Top Up

The NanoClaw agent uses `mcp__vincent__vincent_llm_add_credits` which returns a Stripe payment link. The user clicks the link, enters any dollar amount, and pays by card. Credits are added automatically after payment.

From the operator side:

```bash
curl -s -X POST -H "Authorization: Bearer $VINCENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vincent_llm_add_credits","arguments":{}}}' \
  https://api.heyvincent.ai/mcp | jq .result
```

The response includes a `checkoutUrl` — share this with the user.

### Verify

After the user completes payment, re-check the balance with `vincent_llm_credit_balance` to confirm credits were added.

## 4. Subscription Management

The Vincent subscription is managed through Stripe via the Vincent dashboard. There are no MCP tools for subscription changes.

**Dashboard URL:** https://heyvincent.ai

Guide the user to:
1. Log in at https://heyvincent.ai
2. Navigate to billing/subscription settings
3. Subscribe, upgrade, or manage payment method

If the subscription has lapsed, the agent's API key may stop working entirely. Check by making any MCP tool call — if all tools fail with auth errors, the subscription likely needs renewal.

Note: Each subscription includes $25/month in LLM credits that reset on renewal. The subscription itself is separate from credit top-ups.

## 5. Troubleshooting

### 402 Payment Required from MCP Tools

1. Check which tool failed — if it's a data source tool (Brave, Twitter), top up data credits
2. Run balance check: `curl -s -H "Authorization: Bearer $VINCENT_API_KEY" https://api.heyvincent.ai/api/credits/x402 | jq .`
3. If balance is zero or near-zero, top up using step 2 above
4. If balance is sufficient but 402 persists, the issue may be subscription-level — check the dashboard

### API Key Not Working

1. Verify the key is set: `echo $VINCENT_API_KEY | head -c 10` (should start with `ssk_`)
2. Test connectivity: `curl -s -H "Authorization: Bearer $VINCENT_API_KEY" https://api.heyvincent.ai/api/credits/x402 | jq .`
3. If 401/403, the key may be revoked or the subscription lapsed — check the Vincent dashboard

### MCP Tools Not Showing Credit Tools

The `vincent_credit_balance` and `vincent_add_credits` tools require a DATA_SOURCES scoped API key. If these tools aren't available:

1. Check `.mcp.json` has the Vincent server configured
2. Verify the API key has DATA_SOURCES scope (check in the Vincent dashboard under the secret's API keys)
3. If the key is for a different scope (e.g., POLYMARKET_WALLET only), create a new secret with DATA_SOURCES type or use a key that includes that scope

## Environment

| Variable | Purpose |
|----------|---------|
| `VINCENT_API_KEY` | API key for Vincent MCP server (set in `.env`) |

The MCP connection is configured in `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "vincent": {
      "url": "https://api.heyvincent.ai/mcp",
      "headers": {
        "Authorization": "Bearer ${VINCENT_API_KEY}"
      }
    }
  }
}
```
