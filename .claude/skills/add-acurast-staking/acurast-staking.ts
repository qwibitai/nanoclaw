/**
 * Acurast Staking MCP Skill — Phase 1: Read-only monitoring
 *
 * Connects to Acurast mainnet WSS RPC and reports Gary's full staking state.
 * Designed to run as a scheduled k2 task (daily watchlist).
 *
 * Required env vars (forwarded via NANOCLAW_EXTRA_MOUNTS or mcp-env-forwarding):
 *   ACURAST_WSS_URL   — WSS endpoint (default: wss://public-rpc.mainnet.acurast.com)
 *   ACURAST_ADDR      — Gary's manager wallet SS58 address
 *   ACURAST_COMMITMENT_ID — Gary's commitment ID as integer string (e.g. "139")
 *
 * Optional:
 *   ACURAST_EPOCH_LAG_ALERT — epochs behind before raising health alert (default: 2)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ApiPromise, WsProvider } from "@polkadot/api";

// ---------------------------------------------------------------------------
// Config validation — refuse to start with missing required vars
// ---------------------------------------------------------------------------

const WSS_URL =
  process.env.ACURAST_WSS_URL ?? "wss://public-rpc.mainnet.acurast.com";
const ADDR = process.env.ACURAST_ADDR ?? "";
const COMMITMENT_ID_STR = process.env.ACURAST_COMMITMENT_ID ?? "";
const EPOCH_LAG_ALERT = parseInt(
  process.env.ACURAST_EPOCH_LAG_ALERT ?? "2",
  10
);

if (!ADDR) {
  console.error("FATAL: ACURAST_ADDR env var is required");
  process.exit(1);
}
if (!COMMITMENT_ID_STR || isNaN(parseInt(COMMITMENT_ID_STR, 10))) {
  console.error("FATAL: ACURAST_COMMITMENT_ID env var is required and must be an integer");
  process.exit(1);
}

const COMMITMENT_ID = parseInt(COMMITMENT_ID_STR, 10);
const PICO = 1_000_000_000_000n; // 1 ACU = 1e12 picoACU

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert picoACU BigInt → human-readable string with 4 decimal places */
function formatACU(picoAcu: bigint | string | number): string {
  const val =
    typeof picoAcu === "bigint" ? picoAcu : BigInt(String(picoAcu).replace(/,/g, ""));
  const whole = val / PICO;
  const frac = val % PICO;
  const fracStr = frac.toString().padStart(12, "0").slice(0, 4);
  return `${whole.toLocaleString()}.${fracStr} ACU`;
}

/** Parse a picoACU string (possibly with commas) to BigInt */
function parsePico(raw: string): bigint {
  return BigInt(raw.replace(/,/g, ""));
}

/** Epoch duration estimate in ms (900 blocks × ~6s/block) */
const EPOCH_BLOCKS = 900;
const BLOCK_TIME_MS = 6_000;
const EPOCH_MS = EPOCH_BLOCKS * BLOCK_TIME_MS; // ~90 min

// ---------------------------------------------------------------------------
// Core data fetch
// ---------------------------------------------------------------------------

interface StakingReport {
  timestamp: string;
  currentEpoch: number;
  epochStart: number;
  nextEpochEst: string;
  commitment: {
    stakedAmount: string;
    accruedReward: string;
    totalPaid: string;
    autoCompound: boolean;
    cooldownStarted: string | null;
    lastScoringEpoch: number;
    commission: string;
    delegationsReceived: string;
  };
  balances: {
    free: string;
    reserved: string;
  };
  outgoingDelegations: string;
  managerMetricRewards: {
    totalPaid: string;
  };
  health: {
    status: "OK" | "WARNING" | "ALERT";
    issues: string[];
  };
}

async function fetchStakingReport(): Promise<StakingReport> {
  const provider = new WsProvider(WSS_URL);
  const api = await ApiPromise.create({ provider });

  try {
    // 1. Current epoch
    const cycleRaw = await api.query.acurastCompute.currentCycle();
    const cycle = (cycleRaw as any).toHuman() as { epoch: string; epochStart: string };
    const currentEpoch = parseInt(cycle.epoch.replace(/,/g, ""), 10);
    const epochStart = parseInt(cycle.epochStart.replace(/,/g, ""), 10);

    // Estimate seconds until next epoch start
    // We'd need current block for precision; use a rough wall-clock estimate instead
    const nextEpochEst = new Date(Date.now() + EPOCH_MS).toISOString();

    // 2. Commitment state
    const commitmentRaw = await api.query.acurastCompute.commitments(COMMITMENT_ID);
    const c = (commitmentRaw as any).toHuman() as any;
    const stake = c.stake;

    const accruedReward = formatACU(parsePico(stake.accruedReward));
    const stakedAmount = formatACU(parsePico(stake.amount));
    const totalPaid = formatACU(parsePico(stake.paid));
    const autoCompound: boolean = stake.allowAutoCompound === true || stake.allowAutoCompound === "true";
    const cooldownStarted: string | null = stake.cooldownStarted ?? null;
    const lastScoringEpoch = parseInt(
      String(c.lastScoringEpoch ?? "0").replace(/,/g, ""),
      10
    );
    const commission: string = c.commission ?? "unknown";
    const delegationsReceived = formatACU(parsePico(c.delegationsTotalAmount ?? "0"));

    // 3. Outgoing delegations
    const delegatorTotalRaw = await api.query.acurastCompute.delegatorTotal(ADDR);
    const outgoingDelegations = formatACU(
      parsePico(String((delegatorTotalRaw as any).toString()))
    );

    // 4. Account balances
    const accountRaw = await api.query.system.account(ADDR);
    const accountData = (accountRaw as any).toHuman() as any;
    const free = formatACU(parsePico(accountData.data.free));
    const reserved = formatACU(parsePico(accountData.data.reserved));

    // 5. Manager metric rewards
    const mmrRaw = await api.query.acurastCompute.managerMetricRewards(COMMITMENT_ID);
    const mmr = (mmrRaw as any).toHuman() as any;
    const mmrPaid = mmr?.paid ? formatACU(parsePico(mmr.paid)) : "0.0000 ACU";

    // 6. Health checks
    const issues: string[] = [];
    const epochLag = currentEpoch - lastScoringEpoch;
    if (epochLag > EPOCH_LAG_ALERT) {
      issues.push(
        `HEALTH: lastScoringEpoch ${lastScoringEpoch} is ${epochLag} epochs behind current (${currentEpoch}) — device may be offline or unhealthy`
      );
    }
    if (cooldownStarted !== null) {
      issues.push(
        `COOLDOWN: Committer cooldown started at block ${cooldownStarted} — unstake in progress (~35 day window)`
      );
    }

    const healthStatus: "OK" | "WARNING" | "ALERT" =
      issues.length === 0
        ? "OK"
        : issues.some((i) => i.startsWith("HEALTH") || i.startsWith("COOLDOWN"))
        ? "ALERT"
        : "WARNING";

    const report: StakingReport = {
      timestamp: new Date().toISOString(),
      currentEpoch,
      epochStart,
      nextEpochEst,
      commitment: {
        stakedAmount,
        accruedReward,
        totalPaid,
        autoCompound,
        cooldownStarted,
        lastScoringEpoch,
        commission,
        delegationsReceived,
      },
      balances: { free, reserved },
      outgoingDelegations,
      managerMetricRewards: { totalPaid: mmrPaid },
      health: { status: healthStatus, issues },
    };

    return report;
  } finally {
    await api.disconnect();
  }
}

function formatReport(r: StakingReport): string {
  const healthIcon = r.health.status === "OK" ? "✅" : r.health.status === "WARNING" ? "⚠️" : "🚨";
  const lines = [
    `## Acurast Staking Report — ${r.timestamp}`,
    ``,
    `**Health: ${healthIcon} ${r.health.status}**`,
    ...(r.health.issues.length > 0 ? r.health.issues.map((i) => `> ⚠ ${i}`) : []),
    ``,
    `### Epoch`,
    `- Current epoch: **${r.currentEpoch}**`,
    `- Epoch start block: ${r.epochStart}`,
    `- Next epoch est.: ~${r.nextEpochEst}`,
    ``,
    `### Commitment #${COMMITMENT_ID}`,
    `- Staked amount (reserved): **${r.commitment.stakedAmount}**`,
    `- Accrued reward (claimable now): **${r.commitment.accruedReward}**`,
    `- Total historically paid: ${r.commitment.totalPaid}`,
    `- Auto-compound: ${r.commitment.autoCompound ? "✅ enabled (rewards re-stake)" : "❌ disabled"}`,
    `- Cooldown: ${r.commitment.cooldownStarted ? `⚠️ Started block ${r.commitment.cooldownStarted}` : "None (active)"}`,
    `- Last scoring epoch: ${r.commitment.lastScoringEpoch}`,
    `- Commission: ${r.commitment.commission}`,
    `- Delegations received: ${r.commitment.delegationsReceived}`,
    ``,
    `### Account Balances`,
    `- Free balance: **${r.balances.free}**`,
    `- Reserved balance: ${r.balances.reserved}`,
    ``,
    `### Delegations`,
    `- Outgoing delegations total: ${r.outgoingDelegations}`,
    ``,
    `### Manager Metric Rewards`,
    `- Cumulative MMR paid: ${r.managerMetricRewards.totalPaid}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "acurast-staking",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "acurast_staking_report",
      description:
        "Fetch Gary's current Acurast ACU staking state from mainnet RPC. Returns epoch info, commitment details (staked, accrued reward, auto-compound, health), balances, outgoing delegations, and manager metric rewards. Raises alerts if scoring epoch lags or cooldown is active.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "acurast_staking_summary",
      description:
        "Fetch Gary's Acurast ACU staking state and return a compact one-liner summary suitable for daily status updates.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === "acurast_staking_report") {
    try {
      const report = await fetchStakingReport();
      return {
        content: [
          {
            type: "text",
            text: formatReport(report),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching Acurast staking data: ${err.message ?? String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === "acurast_staking_summary") {
    try {
      const r = await fetchStakingReport();
      const healthIcon = r.health.status === "OK" ? "✅" : "🚨";
      const summary = `${healthIcon} ACU epoch ${r.currentEpoch} | staked ${r.commitment.stakedAmount} | accrued ${r.commitment.accruedReward} | free ${r.balances.free} | health ${r.health.status}${r.health.issues.length ? " — " + r.health.issues[0] : ""}`;
      return {
        content: [{ type: "text", text: summary }],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching Acurast summary: ${err.message ?? String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
server.connect(transport);
