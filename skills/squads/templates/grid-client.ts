/**
 * Squads Grid API Client Template
 *
 * Ready-to-use client for Grid payment operations.
 * Copy this file and customize for your project.
 *
 * Usage:
 * 1. Set your API key in environment variable
 * 2. Update CONFIG with your settings
 * 3. Run with: npx ts-node grid-client.ts
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // API Base URL
  apiBaseUrl: "https://developer-api.squads.so/api/v1",

  // API Key (required)
  apiKey: process.env.GRID_API_KEY || "",

  // Default account ID (set after creating)
  accountId: process.env.GRID_ACCOUNT_ID || "",

  // Webhook secret for signature verification
  webhookSecret: process.env.GRID_WEBHOOK_SECRET || "",
};

// ============================================================================
// TYPES
// ============================================================================

export interface GridAccount {
  id: string;
  email: string;
  type: "individual" | "business";
  status: "pending_verification" | "active" | "frozen";
  address: string;
  balances: Balance[];
  limits: {
    daily: { used: string; limit: string };
    monthly: { used: string; limit: string };
  };
  kycStatus: "not_started" | "pending" | "verified" | "failed";
  createdAt: string;
}

export interface Balance {
  mint: string;
  amount: string;
  available: string;
  pending: string;
}

export interface Payment {
  id: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  amount: string;
  currency: string;
  fee: string;
  fromAccountId: string;
  toAddress: string;
  memo?: string;
  signature?: string;
  createdAt: string;
  completedAt?: string;
}

export interface StandingOrder {
  id: string;
  status: "active" | "paused" | "completed" | "cancelled";
  amount: string;
  currency: string;
  fromAccountId: string;
  toAddress: string;
  frequency: "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  startDate: string;
  endDate?: string;
  nextExecution: string;
  lastExecution?: string;
  totalExecuted: number;
  memo?: string;
  createdAt: string;
}

export interface SpendingLimit {
  id: string;
  type: "per_transaction" | "daily" | "weekly" | "monthly";
  amount: string;
  currency: string;
  used: string;
  remaining: string;
  resetsAt?: string;
}

export interface VirtualAccount {
  id: string;
  accountId: string;
  currency: string;
  type: "checking" | "savings";
  routingNumber: string;
  accountNumber: string;
  bankName: string;
  status: "active" | "frozen";
  balance: string;
  createdAt: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  status: "active" | "disabled";
  secret: string;
}

// ============================================================================
// GRID CLIENT
// ============================================================================

export class GridClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config?: { apiKey?: string }) {
    this.baseUrl = CONFIG.apiBaseUrl;
    this.apiKey = config?.apiKey || CONFIG.apiKey;

    if (!this.apiKey) {
      throw new Error("Grid API key is required");
    }
  }

  // --------------------------------------------------------------------------
  // Internal Request Handler
  // --------------------------------------------------------------------------

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "X-API-Version": "2024-01",
        ...(options.headers as Record<string, string>),
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = errorData.error || {
        code: "UNKNOWN_ERROR",
        message: `Request failed with status ${response.status}`,
      };
      throw new Error(`[${error.code}] ${error.message}`);
    }

    return response.json();
  }

  // --------------------------------------------------------------------------
  // Account Management
  // --------------------------------------------------------------------------

  async createAccount(params: {
    email: string;
    type: "individual" | "business";
    metadata?: Record<string, string>;
  }): Promise<GridAccount> {
    return this.request("/grid/accounts", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getAccount(accountId: string = CONFIG.accountId): Promise<GridAccount> {
    return this.request(`/grid/accounts/${accountId}`);
  }

  async listAccounts(): Promise<{ accounts: GridAccount[]; total: number }> {
    return this.request("/grid/accounts");
  }

  // --------------------------------------------------------------------------
  // Payments
  // --------------------------------------------------------------------------

  async createPayment(params: {
    fromAccountId: string;
    toAddress: string;
    amount: string;
    currency: string;
    memo?: string;
    idempotencyKey?: string;
  }): Promise<Payment> {
    return this.request("/grid/payments", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getPayment(paymentId: string): Promise<Payment> {
    return this.request(`/grid/payments/${paymentId}`);
  }

  async listPayments(params?: {
    accountId?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ payments: Payment[]; total: number; cursor?: string }> {
    const query = new URLSearchParams();
    if (params?.accountId) query.set("accountId", params.accountId);
    if (params?.status) query.set("status", params.status);
    if (params?.limit) query.set("limit", params.limit.toString());
    if (params?.cursor) query.set("cursor", params.cursor);
    return this.request(`/grid/payments?${query.toString()}`);
  }

  async cancelPayment(paymentId: string): Promise<{ success: boolean }> {
    return this.request(`/grid/payments/${paymentId}/cancel`, {
      method: "POST",
    });
  }

  // --------------------------------------------------------------------------
  // Standing Orders
  // --------------------------------------------------------------------------

  async createStandingOrder(params: {
    fromAccountId: string;
    toAddress: string;
    amount: string;
    currency: string;
    frequency: StandingOrder["frequency"];
    startDate: string;
    endDate?: string;
    memo?: string;
  }): Promise<StandingOrder> {
    return this.request("/grid/standing-orders", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getStandingOrder(standingOrderId: string): Promise<StandingOrder> {
    return this.request(`/grid/standing-orders/${standingOrderId}`);
  }

  async listStandingOrders(
    accountId: string
  ): Promise<{ standingOrders: StandingOrder[]; total: number }> {
    return this.request(`/grid/standing-orders?accountId=${accountId}`);
  }

  async updateStandingOrder(
    standingOrderId: string,
    params: { amount?: string; endDate?: string }
  ): Promise<{ success: boolean }> {
    return this.request(`/grid/standing-orders/${standingOrderId}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }

  async pauseStandingOrder(
    standingOrderId: string
  ): Promise<{ success: boolean; status: string }> {
    return this.request(`/grid/standing-orders/${standingOrderId}/pause`, {
      method: "POST",
    });
  }

  async resumeStandingOrder(
    standingOrderId: string
  ): Promise<{ success: boolean; status: string; nextExecution: string }> {
    return this.request(`/grid/standing-orders/${standingOrderId}/resume`, {
      method: "POST",
    });
  }

  async cancelStandingOrder(standingOrderId: string): Promise<{ success: boolean }> {
    return this.request(`/grid/standing-orders/${standingOrderId}`, {
      method: "DELETE",
    });
  }

  // --------------------------------------------------------------------------
  // Spending Limits
  // --------------------------------------------------------------------------

  async setSpendingLimit(
    accountId: string,
    params: {
      type: SpendingLimit["type"];
      amount: string;
      currency: string;
    }
  ): Promise<SpendingLimit> {
    return this.request(`/grid/accounts/${accountId}/limits`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getSpendingLimits(accountId: string): Promise<{ limits: SpendingLimit[] }> {
    return this.request(`/grid/accounts/${accountId}/limits`);
  }

  async updateSpendingLimit(
    accountId: string,
    limitId: string,
    params: { amount: string }
  ): Promise<{ success: boolean }> {
    return this.request(`/grid/accounts/${accountId}/limits/${limitId}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }

  async deleteSpendingLimit(
    accountId: string,
    limitId: string
  ): Promise<{ success: boolean }> {
    return this.request(`/grid/accounts/${accountId}/limits/${limitId}`, {
      method: "DELETE",
    });
  }

  // --------------------------------------------------------------------------
  // Virtual Accounts
  // --------------------------------------------------------------------------

  async createVirtualAccount(
    accountId: string,
    params: { currency: string; type: "checking" | "savings" }
  ): Promise<VirtualAccount> {
    return this.request("/grid/virtual-accounts", {
      method: "POST",
      body: JSON.stringify({ accountId, ...params }),
    });
  }

  async getVirtualAccount(virtualAccountId: string): Promise<VirtualAccount> {
    return this.request(`/grid/virtual-accounts/${virtualAccountId}`);
  }

  async listVirtualAccounts(
    accountId: string
  ): Promise<{ virtualAccounts: VirtualAccount[]; total: number }> {
    return this.request(`/grid/virtual-accounts?accountId=${accountId}`);
  }

  async withdrawFromVirtualAccount(
    virtualAccountId: string,
    params: {
      amount: string;
      method: "ach" | "wire";
      destination: {
        routingNumber: string;
        accountNumber: string;
        accountType: "checking" | "savings";
      };
    }
  ): Promise<{ id: string; status: string; estimatedArrival: string }> {
    return this.request(`/grid/virtual-accounts/${virtualAccountId}/withdraw`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  // --------------------------------------------------------------------------
  // KYC
  // --------------------------------------------------------------------------

  async startKyc(
    accountId: string,
    redirectUrl: string
  ): Promise<{ inquiryId: string; kycUrl: string; expiresAt: string }> {
    return this.request(`/grid/accounts/${accountId}/kyc`, {
      method: "POST",
      body: JSON.stringify({ provider: "persona", redirectUrl }),
    });
  }

  async getKycStatus(accountId: string): Promise<{
    status: string;
    level: string;
    verifiedAt?: string;
  }> {
    return this.request(`/grid/accounts/${accountId}/kyc`);
  }

  // --------------------------------------------------------------------------
  // Webhooks
  // --------------------------------------------------------------------------

  async createWebhook(params: {
    url: string;
    events: string[];
  }): Promise<Webhook> {
    return this.request("/grid/webhooks", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async listWebhooks(): Promise<{ webhooks: Webhook[] }> {
    return this.request("/grid/webhooks");
  }

  async deleteWebhook(webhookId: string): Promise<{ success: boolean }> {
    return this.request(`/grid/webhooks/${webhookId}`, {
      method: "DELETE",
    });
  }
}

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================

import * as crypto from "crypto";

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string = CONFIG.webhookSecret
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

export interface WebhookEvent {
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export function parseWebhookEvent(payload: string): WebhookEvent {
  return JSON.parse(payload);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Send a USDC payment with automatic idempotency key
 */
export async function sendPayment(
  client: GridClient,
  fromAccountId: string,
  toAddress: string,
  amount: number,
  memo?: string
): Promise<Payment> {
  return client.createPayment({
    fromAccountId,
    toAddress,
    amount: amount.toFixed(2),
    currency: "USDC",
    memo,
    idempotencyKey: `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
}

/**
 * Wait for a payment to complete
 */
export async function waitForPayment(
  client: GridClient,
  paymentId: string,
  timeoutMs: number = 60000,
  pollIntervalMs: number = 2000
): Promise<Payment> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const payment = await client.getPayment(paymentId);

    if (payment.status === "completed") {
      return payment;
    }

    if (payment.status === "failed" || payment.status === "cancelled") {
      throw new Error(`Payment ${payment.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Payment timed out");
}

/**
 * Get total monthly recurring payments
 */
export async function getMonthlyRecurringTotal(
  client: GridClient,
  accountId: string
): Promise<number> {
  const { standingOrders } = await client.listStandingOrders(accountId);

  return standingOrders.reduce((sum, order) => {
    if (order.status !== "active") return sum;

    const amount = parseFloat(order.amount);
    switch (order.frequency) {
      case "daily":
        return sum + amount * 30;
      case "weekly":
        return sum + amount * 4.33;
      case "biweekly":
        return sum + amount * 2.17;
      case "monthly":
        return sum + amount;
      case "quarterly":
        return sum + amount / 3;
      case "yearly":
        return sum + amount / 12;
      default:
        return sum;
    }
  }, 0);
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  console.log("=== Squads Grid Client Setup ===\n");

  if (!CONFIG.apiKey) {
    console.log("Set GRID_API_KEY environment variable to use this client.");
    console.log("Get your API key from: https://developers.squads.so\n");

    console.log("Example usage:");
    console.log(`
const client = new GridClient({ apiKey: "your-api-key" });

// Create an account
const account = await client.createAccount({
  email: "user@example.com",
  type: "individual",
});

// Send a payment
const payment = await sendPayment(
  client,
  account.id,
  "RecipientAddress...",
  100.00,
  "Invoice payment"
);

// Wait for completion
const completed = await waitForPayment(client, payment.id);
console.log("Payment signature:", completed.signature);

// Set up recurring payment
const subscription = await client.createStandingOrder({
  fromAccountId: account.id,
  toAddress: "ServiceAddress...",
  amount: "9.99",
  currency: "USDC",
  frequency: "monthly",
  startDate: "2024-02-01",
  memo: "Monthly subscription",
});
`);
    return;
  }

  const client = new GridClient();

  // List accounts
  const { accounts, total } = await client.listAccounts();
  console.log(`Found ${total} accounts:`);
  accounts.forEach((account) => {
    console.log(`  - ${account.email} (${account.address})`);
    console.log(`    Status: ${account.status}, KYC: ${account.kycStatus}`);

    // Show balances
    account.balances.forEach((balance) => {
      console.log(`    ${balance.mint}: ${balance.available} available`);
    });
  });

  // If we have an account, show more details
  if (CONFIG.accountId) {
    console.log("\n--- Account Details ---");
    const account = await client.getAccount();

    // Spending limits
    const { limits } = await client.getSpendingLimits(CONFIG.accountId);
    console.log("\nSpending Limits:");
    limits.forEach((limit) => {
      console.log(`  ${limit.type}: ${limit.used}/${limit.amount} ${limit.currency}`);
    });

    // Standing orders
    const { standingOrders } = await client.listStandingOrders(CONFIG.accountId);
    console.log("\nStanding Orders:", standingOrders.length);

    const monthlyTotal = await getMonthlyRecurringTotal(client, CONFIG.accountId);
    console.log(`Monthly recurring total: $${monthlyTotal.toFixed(2)}`);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
