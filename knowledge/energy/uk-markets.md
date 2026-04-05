# UK Wholesale Electricity Markets

## How It Works

The UK wholesale electricity market operates in half-hour settlement periods. Every 30 minutes, the price of electricity can change based on supply and demand. By participating in these markets, distributed energy assets (batteries, V2G chargers) can buy electricity when it's cheap and sell when it's expensive.

## Key Market Mechanisms

### Day-Ahead Market
Electricity is bought and sold for delivery the next day. Prices are set through auctions. This gives market participants advance notice of expected prices.

### Intraday / Balancing
As real-time approaches, prices adjust based on actual supply/demand conditions. The Balancing Mechanism (BM) is the final backstop where National Grid ESO matches supply and demand.

### Imbalance Pricing
When the grid is out of balance, the System Price (also called the cash-out price or NIV price) can spike dramatically. Flexible assets that can respond quickly to these price signals can earn significant revenue.

## Revenue Streams for Distributed Assets

1. **Wholesale Trading** — Buy low, sell high on wholesale markets via aggregators like Axle Energy
2. **Import Optimisation** — Charge batteries/EVs when prices are cheap (overnight, during solar peaks)
3. **Peak Shaving** — Discharge during expensive peak periods (typically 4-7pm) to reduce site import costs
4. **DUoS Avoidance** — Shift consumption away from peak DUoS charge bands
5. **Frequency Response** — Provide fast-acting grid balancing services (requires specific technical capability)

## Market Access

Distributed assets typically access wholesale markets through an aggregator (like Axle Energy) rather than trading directly. The aggregator handles market registration, dispatch optimisation, and settlement.

To participate, assets need:
- COP11 accredited metering (via Simtricity Flows)
- P415 registration with Elexon
- An aggregator contract (e.g., Axle Energy)
- A control system that can respond to dispatch signals (Simtricity Flux)
