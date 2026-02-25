/**
 * Squads Grid: API Quickstart Example
 *
 * This example demonstrates basic Grid API operations for
 * stablecoin payments and account management.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  apiBaseUrl: "https://developer-api.squads.so/api/v1",
  apiKey: process.env.GRID_API_KEY || "",
};

// ============================================================================
// TYPES
// ============================================================================

interface GridAccount {
  id: string;
  email: string;
  type: "individual" | "business";
  status: "pending_verification" | "active" | "frozen";
  address: string;
  balances: {
    mint: string;
    amount: string;
    available: string;
    pending: string;
  }[];
  limits: {
    daily: { used: string; limit: string };
    monthly: { used: string; limit: string };
  };
  kycStatus: "not_started" | "pending" | "verified" | "failed";
  createdAt: string;
}

interface Payment {
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

// ============================================================================
// GRID API CLIENT
// ============================================================================

class GridClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey: string) {
    this.baseUrl = CONFIG.apiBaseUrl;
    this.apiKey = apiKey;
  }

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
      const error = await response.json();
      throw new Error(error.error?.message || `API error: ${response.status}`);
    }

    return response.json();
  }

  // ========================================
  // Account Operations
  // ========================================

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

  async getAccount(accountId: string): Promise<GridAccount> {
    return this.request(`/grid/accounts/${accountId}`);
  }

  async listAccounts(): Promise<{ accounts: GridAccount[]; total: number }> {
    return this.request("/grid/accounts");
  }

  // ========================================
  // Payment Operations
  // ========================================

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

  async listPayments(params: {
    accountId?: string;
    status?: string;
    limit?: number;
  }): Promise<{ payments: Payment[]; total: number }> {
    const queryParams = new URLSearchParams();
    if (params.accountId) queryParams.set("accountId", params.accountId);
    if (params.status) queryParams.set("status", params.status);
    if (params.limit) queryParams.set("limit", params.limit.toString());

    return this.request(`/grid/payments?${queryParams.toString()}`);
  }

  async cancelPayment(paymentId: string): Promise<{ success: boolean }> {
    return this.request(`/grid/payments/${paymentId}/cancel`, {
      method: "POST",
    });
  }
}

// ============================================================================
// EXAMPLE FUNCTIONS
// ============================================================================

/**
 * Example 1: Create a new Grid account
 */
async function createNewAccount(email: string): Promise<GridAccount> {
  console.log("\n=== Creating Grid Account ===");

  const client = new GridClient(CONFIG.apiKey);

  const account = await client.createAccount({
    email,
    type: "individual",
    metadata: {
      source: "api-quickstart-example",
    },
  });

  console.log("Account created:");
  console.log("  ID:", account.id);
  console.log("  Email:", account.email);
  console.log("  Solana Address:", account.address);
  console.log("  Status:", account.status);
  console.log("  KYC Status:", account.kycStatus);

  return account;
}

/**
 * Example 2: Get account details and balances
 */
async function getAccountDetails(accountId: string): Promise<void> {
  console.log("\n=== Getting Account Details ===");

  const client = new GridClient(CONFIG.apiKey);

  const account = await client.getAccount(accountId);

  console.log("Account:", account.id);
  console.log("Status:", account.status);
  console.log("Address:", account.address);

  console.log("\nBalances:");
  account.balances.forEach((balance) => {
    console.log(`  ${balance.mint}:`);
    console.log(`    Total: ${balance.amount}`);
    console.log(`    Available: ${balance.available}`);
    console.log(`    Pending: ${balance.pending}`);
  });

  console.log("\nLimits:");
  console.log(
    `  Daily: ${account.limits.daily.used} / ${account.limits.daily.limit}`
  );
  console.log(
    `  Monthly: ${account.limits.monthly.used} / ${account.limits.monthly.limit}`
  );
}

/**
 * Example 3: Make a USDC payment
 */
async function makePayment(
  fromAccountId: string,
  toAddress: string,
  amountUsdc: number
): Promise<Payment> {
  console.log("\n=== Making USDC Payment ===");

  const client = new GridClient(CONFIG.apiKey);

  // Amount in USDC (human readable, API handles conversion)
  const payment = await client.createPayment({
    fromAccountId,
    toAddress,
    amount: amountUsdc.toFixed(2),
    currency: "USDC",
    memo: "Payment via Grid API",
    idempotencyKey: `payment-${Date.now()}`, // Prevent duplicate payments
  });

  console.log("Payment created:");
  console.log("  ID:", payment.id);
  console.log("  Status:", payment.status);
  console.log("  Amount:", payment.amount, payment.currency);
  console.log("  Fee:", payment.fee, payment.currency);
  console.log("  To:", payment.toAddress);

  return payment;
}

/**
 * Example 4: Check payment status
 */
async function checkPaymentStatus(paymentId: string): Promise<void> {
  console.log("\n=== Checking Payment Status ===");

  const client = new GridClient(CONFIG.apiKey);

  const payment = await client.getPayment(paymentId);

  console.log("Payment:", payment.id);
  console.log("Status:", payment.status);
  console.log("Amount:", payment.amount, payment.currency);

  switch (payment.status) {
    case "pending":
      console.log("Payment is being processed...");
      break;
    case "processing":
      console.log("Transaction submitted to Solana...");
      break;
    case "completed":
      console.log("Payment successful!");
      console.log("Signature:", payment.signature);
      console.log("Completed at:", payment.completedAt);
      break;
    case "failed":
      console.log("Payment failed. Check account balance and limits.");
      break;
    case "cancelled":
      console.log("Payment was cancelled.");
      break;
  }
}

/**
 * Example 5: List recent payments
 */
async function listRecentPayments(accountId: string): Promise<void> {
  console.log("\n=== Recent Payments ===");

  const client = new GridClient(CONFIG.apiKey);

  const { payments, total } = await client.listPayments({
    accountId,
    limit: 10,
  });

  console.log(`Showing ${payments.length} of ${total} payments:\n`);

  payments.forEach((payment, index) => {
    console.log(`${index + 1}. ${payment.id}`);
    console.log(`   Amount: ${payment.amount} ${payment.currency}`);
    console.log(`   Status: ${payment.status}`);
    console.log(`   Date: ${payment.createdAt}`);
    console.log("");
  });
}

/**
 * Example 6: Cancel a pending payment
 */
async function cancelPendingPayment(paymentId: string): Promise<void> {
  console.log("\n=== Cancelling Payment ===");

  const client = new GridClient(CONFIG.apiKey);

  // First check if payment is still pending
  const payment = await client.getPayment(paymentId);

  if (payment.status !== "pending") {
    console.log(`Cannot cancel payment with status: ${payment.status}`);
    return;
  }

  await client.cancelPayment(paymentId);
  console.log("Payment cancelled successfully");
}

/**
 * Example 7: Complete payment flow with retry
 */
async function completePaymentFlow(
  fromAccountId: string,
  toAddress: string,
  amount: number
): Promise<void> {
  console.log("\n=== Complete Payment Flow ===");

  const client = new GridClient(CONFIG.apiKey);

  // Step 1: Check account balance
  const account = await client.getAccount(fromAccountId);
  const usdcBalance = account.balances.find((b) => b.mint === "USDC");

  if (!usdcBalance || parseFloat(usdcBalance.available) < amount) {
    throw new Error("Insufficient USDC balance");
  }
  console.log("Balance check: OK");

  // Step 2: Check limits
  const dailyRemaining =
    parseFloat(account.limits.daily.limit) -
    parseFloat(account.limits.daily.used);
  if (dailyRemaining < amount) {
    throw new Error("Daily limit exceeded");
  }
  console.log("Limit check: OK");

  // Step 3: Create payment
  const payment = await client.createPayment({
    fromAccountId,
    toAddress,
    amount: amount.toFixed(2),
    currency: "USDC",
    idempotencyKey: `flow-${Date.now()}`,
  });
  console.log("Payment created:", payment.id);

  // Step 4: Poll for completion
  let attempts = 0;
  const maxAttempts = 30;
  const pollInterval = 2000; // 2 seconds

  while (attempts < maxAttempts) {
    const status = await client.getPayment(payment.id);

    if (status.status === "completed") {
      console.log("Payment completed!");
      console.log("Signature:", status.signature);
      return;
    }

    if (status.status === "failed") {
      throw new Error("Payment failed");
    }

    if (status.status === "cancelled") {
      throw new Error("Payment was cancelled");
    }

    console.log(`Status: ${status.status}... waiting`);
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    attempts++;
  }

  throw new Error("Payment timed out");
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Squads Grid API Quickstart ===");

  if (!CONFIG.apiKey) {
    console.log("\nNote: Set GRID_API_KEY environment variable to run examples");
    console.log("Get your API key from: https://developers.squads.so\n");

    console.log("Grid API Features:");
    console.log("1. Create and manage stablecoin accounts");
    console.log("2. Send USDC/USDT payments instantly");
    console.log("3. Set up recurring payments (standing orders)");
    console.log("4. Connect to fiat rails via virtual accounts");
    console.log("5. Built-in KYC/AML compliance");
    return;
  }

  try {
    // Create a test account
    const account = await createNewAccount("test@example.com");

    // Get account details
    await getAccountDetails(account.id);

    // Make a payment (would need funded account)
    // const payment = await makePayment(account.id, "RecipientAddress...", 10.00);
    // await checkPaymentStatus(payment.id);

    // List payments
    await listRecentPayments(account.id);
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
