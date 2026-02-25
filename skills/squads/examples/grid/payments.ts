/**
 * Squads Grid: Payments Example
 *
 * This example demonstrates payment operations including:
 * - One-time payments
 * - Standing orders (recurring payments)
 * - Payment webhooks
 * - Spending limits
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
}

interface StandingOrder {
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

interface SpendingLimit {
  id: string;
  type: "per_transaction" | "daily" | "weekly" | "monthly";
  amount: string;
  currency: string;
  used: string;
  remaining: string;
  resetsAt?: string;
}

// ============================================================================
// GRID PAYMENTS CLIENT
// ============================================================================

class GridPaymentsClient {
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
        ...(options.headers as Record<string, string>),
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || "API request failed");
    }

    return response.json();
  }

  // ========================================
  // One-Time Payments
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

  // ========================================
  // Standing Orders (Recurring)
  // ========================================

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

  async cancelStandingOrder(
    standingOrderId: string
  ): Promise<{ success: boolean }> {
    return this.request(`/grid/standing-orders/${standingOrderId}`, {
      method: "DELETE",
    });
  }

  // ========================================
  // Spending Limits
  // ========================================

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
}

// ============================================================================
// EXAMPLE FUNCTIONS
// ============================================================================

/**
 * Example 1: Send a one-time USDC payment
 */
async function sendUsdcPayment(
  fromAccountId: string,
  toAddress: string,
  amount: number
): Promise<Payment> {
  console.log("\n=== Sending USDC Payment ===");

  const client = new GridPaymentsClient(CONFIG.apiKey);

  const payment = await client.createPayment({
    fromAccountId,
    toAddress,
    amount: amount.toFixed(2),
    currency: "USDC",
    memo: "One-time payment",
    idempotencyKey: `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });

  console.log("Payment initiated:");
  console.log("  ID:", payment.id);
  console.log("  Amount:", payment.amount, payment.currency);
  console.log("  Fee:", payment.fee, payment.currency);
  console.log("  Status:", payment.status);

  return payment;
}

/**
 * Example 2: Create a monthly subscription payment
 */
async function createMonthlySubscription(
  fromAccountId: string,
  toAddress: string,
  monthlyAmount: number
): Promise<StandingOrder> {
  console.log("\n=== Creating Monthly Subscription ===");

  const client = new GridPaymentsClient(CONFIG.apiKey);

  // Start on the 1st of next month
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  nextMonth.setDate(1);

  const standingOrder = await client.createStandingOrder({
    fromAccountId,
    toAddress,
    amount: monthlyAmount.toFixed(2),
    currency: "USDC",
    frequency: "monthly",
    startDate: nextMonth.toISOString().split("T")[0],
    memo: "Monthly subscription",
  });

  console.log("Subscription created:");
  console.log("  ID:", standingOrder.id);
  console.log("  Amount:", standingOrder.amount, standingOrder.currency);
  console.log("  Frequency:", standingOrder.frequency);
  console.log("  First payment:", standingOrder.nextExecution);

  return standingOrder;
}

/**
 * Example 3: Create a weekly payroll payment
 */
async function createWeeklyPayroll(
  fromAccountId: string,
  employeeAddress: string,
  weeklyAmount: number
): Promise<StandingOrder> {
  console.log("\n=== Creating Weekly Payroll ===");

  const client = new GridPaymentsClient(CONFIG.apiKey);

  // Start next Monday
  const nextMonday = new Date();
  nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7));

  const standingOrder = await client.createStandingOrder({
    fromAccountId,
    toAddress: employeeAddress,
    amount: weeklyAmount.toFixed(2),
    currency: "USDC",
    frequency: "weekly",
    startDate: nextMonday.toISOString().split("T")[0],
    memo: "Weekly payroll",
  });

  console.log("Payroll standing order created:");
  console.log("  Employee:", employeeAddress);
  console.log("  Weekly amount:", weeklyAmount, "USDC");
  console.log("  First payment:", standingOrder.nextExecution);

  return standingOrder;
}

/**
 * Example 4: Manage standing orders
 */
async function manageStandingOrders(accountId: string): Promise<void> {
  console.log("\n=== Managing Standing Orders ===");

  const client = new GridPaymentsClient(CONFIG.apiKey);

  const { standingOrders, total } = await client.listStandingOrders(accountId);

  console.log(`Found ${total} standing orders:\n`);

  for (const order of standingOrders) {
    console.log(`${order.id}:`);
    console.log(`  Amount: ${order.amount} ${order.currency}`);
    console.log(`  Frequency: ${order.frequency}`);
    console.log(`  Status: ${order.status}`);
    console.log(`  Next execution: ${order.nextExecution}`);
    console.log(`  Total executed: ${order.totalExecuted}`);
    console.log("");
  }

  // Calculate total monthly outflow
  const monthlyOutflow = standingOrders.reduce((sum, order) => {
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

  console.log(`Estimated monthly outflow: ${monthlyOutflow.toFixed(2)} USDC`);
}

/**
 * Example 5: Pause and resume a standing order
 */
async function pauseAndResumeOrder(standingOrderId: string): Promise<void> {
  console.log("\n=== Pausing Standing Order ===");

  const client = new GridPaymentsClient(CONFIG.apiKey);

  // Pause
  await client.pauseStandingOrder(standingOrderId);
  console.log("Standing order paused");

  // Check status
  const paused = await client.getStandingOrder(standingOrderId);
  console.log("Status:", paused.status);

  // Resume after some time
  console.log("\n=== Resuming Standing Order ===");
  const resumed = await client.resumeStandingOrder(standingOrderId);
  console.log("Standing order resumed");
  console.log("Next execution:", resumed.nextExecution);
}

/**
 * Example 6: Set up spending limits
 */
async function setupSpendingLimits(accountId: string): Promise<void> {
  console.log("\n=== Setting Up Spending Limits ===");

  const client = new GridPaymentsClient(CONFIG.apiKey);

  // Set per-transaction limit
  const perTxLimit = await client.setSpendingLimit(accountId, {
    type: "per_transaction",
    amount: "1000.00",
    currency: "USDC",
  });
  console.log("Per-transaction limit:", perTxLimit.amount, "USDC");

  // Set daily limit
  const dailyLimit = await client.setSpendingLimit(accountId, {
    type: "daily",
    amount: "5000.00",
    currency: "USDC",
  });
  console.log("Daily limit:", dailyLimit.amount, "USDC");

  // Set monthly limit
  const monthlyLimit = await client.setSpendingLimit(accountId, {
    type: "monthly",
    amount: "50000.00",
    currency: "USDC",
  });
  console.log("Monthly limit:", monthlyLimit.amount, "USDC");
}

/**
 * Example 7: Check spending limits status
 */
async function checkSpendingLimits(accountId: string): Promise<void> {
  console.log("\n=== Checking Spending Limits ===");

  const client = new GridPaymentsClient(CONFIG.apiKey);

  const { limits } = await client.getSpendingLimits(accountId);

  console.log("Current limits:\n");

  for (const limit of limits) {
    const percentage = (
      (parseFloat(limit.used) / parseFloat(limit.amount)) *
      100
    ).toFixed(1);

    console.log(`${limit.type.toUpperCase()}:`);
    console.log(`  Limit: ${limit.amount} ${limit.currency}`);
    console.log(`  Used: ${limit.used} ${limit.currency} (${percentage}%)`);
    console.log(`  Remaining: ${limit.remaining} ${limit.currency}`);
    if (limit.resetsAt) {
      console.log(`  Resets at: ${limit.resetsAt}`);
    }
    console.log("");
  }
}

/**
 * Example 8: Batch payments (multiple recipients)
 */
async function sendBatchPayments(
  fromAccountId: string,
  payments: { address: string; amount: number; memo?: string }[]
): Promise<Payment[]> {
  console.log("\n=== Sending Batch Payments ===");

  const client = new GridPaymentsClient(CONFIG.apiKey);
  const results: Payment[] = [];

  console.log(`Processing ${payments.length} payments...\n`);

  for (let i = 0; i < payments.length; i++) {
    const p = payments[i];

    try {
      const payment = await client.createPayment({
        fromAccountId,
        toAddress: p.address,
        amount: p.amount.toFixed(2),
        currency: "USDC",
        memo: p.memo || `Batch payment ${i + 1}`,
        idempotencyKey: `batch-${Date.now()}-${i}`,
      });

      results.push(payment);
      console.log(`${i + 1}. ${p.address.slice(0, 8)}...`);
      console.log(`   Amount: ${p.amount} USDC`);
      console.log(`   Status: ${payment.status}`);
      console.log(`   ID: ${payment.id}\n`);
    } catch (error) {
      console.log(`${i + 1}. ${p.address.slice(0, 8)}... FAILED`);
      console.log(`   Error: ${error}\n`);
    }

    // Small delay between payments
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`Completed: ${results.length}/${payments.length} payments`);

  return results;
}

// ============================================================================
// WEBHOOK HANDLER EXAMPLE
// ============================================================================

/**
 * Example webhook handler for payment events
 */
function handleWebhook(payload: string, signature: string, secret: string): void {
  // Verify webhook signature
  const crypto = require("crypto");
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (signature !== expectedSignature) {
    throw new Error("Invalid webhook signature");
  }

  const event = JSON.parse(payload);

  switch (event.type) {
    case "payment.completed":
      console.log("Payment completed:", event.data.paymentId);
      console.log("Signature:", event.data.signature);
      // Update your database, send notification, etc.
      break;

    case "payment.failed":
      console.log("Payment failed:", event.data.paymentId);
      console.log("Reason:", event.data.reason);
      // Alert user, retry, etc.
      break;

    case "standing_order.executed":
      console.log("Standing order executed:", event.data.standingOrderId);
      console.log("Payment ID:", event.data.paymentId);
      // Log the recurring payment
      break;

    case "standing_order.failed":
      console.log("Standing order failed:", event.data.standingOrderId);
      console.log("Reason:", event.data.reason);
      // Alert user, may need to add funds
      break;

    default:
      console.log("Unknown event:", event.type);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Squads Grid Payments Examples ===");

  if (!CONFIG.apiKey) {
    console.log("\nNote: Set GRID_API_KEY environment variable to run examples");
    console.log("Get your API key from: https://developers.squads.so\n");

    console.log("Payment Features:");
    console.log("1. One-time USDC/USDT payments");
    console.log("2. Standing orders (recurring payments)");
    console.log("3. Spending limits (per-tx, daily, monthly)");
    console.log("4. Batch payments to multiple recipients");
    console.log("5. Webhook notifications for payment events");
    return;
  }

  const accountId = process.env.GRID_ACCOUNT_ID || "";
  const recipientAddress = "RecipientAddress...";

  try {
    // Send a one-time payment
    // await sendUsdcPayment(accountId, recipientAddress, 50.00);

    // Create a monthly subscription
    // await createMonthlySubscription(accountId, recipientAddress, 9.99);

    // Check spending limits
    // await checkSpendingLimits(accountId);

    // Manage standing orders
    // await manageStandingOrders(accountId);

    console.log("\nUncomment examples in main() to run them");
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
