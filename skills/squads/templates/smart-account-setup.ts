/**
 * Squads Smart Account Setup Template
 *
 * Ready-to-use client for Smart Account operations.
 * Copy this file and customize for your project.
 *
 * Usage:
 * 1. Set your API key in environment variable
 * 2. Update CONFIG with your settings
 * 3. Run with: npx ts-node smart-account-setup.ts
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // API Base URL
  apiBaseUrl: "https://developer-api.squads.so/api/v1",

  // API Key (for server-side operations)
  apiKey: process.env.SQUADS_API_KEY || "",

  // Default account ID (set after creating)
  accountId: process.env.SQUADS_ACCOUNT_ID || "",
};

// ============================================================================
// TYPES
// ============================================================================

export interface SmartAccount {
  id: string;
  address: string;
  email?: string;
  name: string;
  type: "personal" | "business";
  status: "pending_verification" | "active" | "frozen";
  balance?: Record<string, string>;
  kycStatus?: "not_started" | "pending" | "verified" | "failed";
  createdAt: string;
}

export interface SessionKey {
  id: string;
  publicKey: string;
  name: string;
  expiresAt: string;
  permissions: string[];
  limits?: SessionKeyLimits;
  status: "active" | "expired" | "revoked";
  createdAt: string;
}

export interface SessionKeyLimits {
  perTransaction?: string;
  daily?: string;
  allowedMints?: string[];
  allowedDestinations?: string[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface Policy {
  id: string;
  type: "spending_limit" | "allowlist" | "blocklist" | "time_window";
  name: string;
  params: Record<string, unknown>;
  status: "active" | "disabled";
  createdAt: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// ============================================================================
// SMART ACCOUNT CLIENT
// ============================================================================

export class SmartAccountClient {
  private baseUrl: string;
  private apiKey: string;
  private accessToken?: string;

  constructor(config?: { apiKey?: string; accessToken?: string }) {
    this.baseUrl = CONFIG.apiBaseUrl;
    this.apiKey = config?.apiKey || CONFIG.apiKey;
    this.accessToken = config?.accessToken;
  }

  // --------------------------------------------------------------------------
  // Internal Request Handler
  // --------------------------------------------------------------------------

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    // Use access token if available, otherwise API key
    const authToken = this.accessToken || this.apiKey;
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error: ApiError = errorData.error || {
        code: "UNKNOWN_ERROR",
        message: `Request failed with status ${response.status}`,
      };
      throw new Error(`[${error.code}] ${error.message}`);
    }

    return response.json();
  }

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  async requestEmailOtp(email: string): Promise<{ success: boolean }> {
    return this.request("/auth/email/otp", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  async verifyEmailOtp(email: string, otp: string): Promise<AuthTokens> {
    const tokens = await this.request<AuthTokens>("/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ email, otp }),
    });
    this.accessToken = tokens.accessToken;
    return tokens;
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    const tokens = await this.request<AuthTokens>("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
    this.accessToken = tokens.accessToken;
    return tokens;
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  // --------------------------------------------------------------------------
  // Account Management
  // --------------------------------------------------------------------------

  async createAccount(params: {
    name: string;
    type: "personal" | "business";
  }): Promise<SmartAccount> {
    return this.request("/accounts", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getAccount(accountId: string = CONFIG.accountId): Promise<SmartAccount> {
    return this.request(`/accounts/${accountId}`);
  }

  async listAccounts(): Promise<{ accounts: SmartAccount[]; total: number }> {
    return this.request("/accounts");
  }

  async updateAccount(
    accountId: string,
    params: { name?: string }
  ): Promise<{ success: boolean }> {
    return this.request(`/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }

  // --------------------------------------------------------------------------
  // Session Keys
  // --------------------------------------------------------------------------

  async createSessionKey(
    accountId: string,
    params: {
      publicKey: string;
      name: string;
      expiresAt: string;
      permissions: string[];
      limits?: SessionKeyLimits;
    }
  ): Promise<SessionKey> {
    return this.request(`/accounts/${accountId}/sessions`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async listSessionKeys(
    accountId: string
  ): Promise<{ sessions: SessionKey[]; total: number }> {
    return this.request(`/accounts/${accountId}/sessions`);
  }

  async getSessionKey(accountId: string, sessionId: string): Promise<SessionKey> {
    return this.request(`/accounts/${accountId}/sessions/${sessionId}`);
  }

  async revokeSessionKey(
    accountId: string,
    sessionId: string
  ): Promise<{ success: boolean }> {
    return this.request(`/accounts/${accountId}/sessions/${sessionId}`, {
      method: "DELETE",
    });
  }

  // --------------------------------------------------------------------------
  // Policies
  // --------------------------------------------------------------------------

  async createPolicy(
    accountId: string,
    params: {
      type: Policy["type"];
      name: string;
      params: Record<string, unknown>;
    }
  ): Promise<Policy> {
    return this.request(`/accounts/${accountId}/policies`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async listPolicies(accountId: string): Promise<{ policies: Policy[]; total: number }> {
    return this.request(`/accounts/${accountId}/policies`);
  }

  async updatePolicy(
    accountId: string,
    policyId: string,
    params: { params?: Record<string, unknown>; status?: "active" | "disabled" }
  ): Promise<{ success: boolean }> {
    return this.request(`/accounts/${accountId}/policies/${policyId}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }

  async deletePolicy(accountId: string, policyId: string): Promise<{ success: boolean }> {
    return this.request(`/accounts/${accountId}/policies/${policyId}`, {
      method: "DELETE",
    });
  }

  // --------------------------------------------------------------------------
  // KYC
  // --------------------------------------------------------------------------

  async startKyc(
    accountId: string,
    redirectUrl: string
  ): Promise<{ inquiryId: string; kycUrl: string; expiresAt: string }> {
    return this.request(`/accounts/${accountId}/kyc`, {
      method: "POST",
      body: JSON.stringify({ provider: "persona", redirectUrl }),
    });
  }

  async getKycStatus(accountId: string): Promise<{
    status: string;
    level: string;
    verifiedAt?: string;
    expiresAt?: string;
  }> {
    return this.request(`/accounts/${accountId}/kyc`);
  }

  // --------------------------------------------------------------------------
  // Transactions
  // --------------------------------------------------------------------------

  async executeTransaction(
    accountId: string,
    params: {
      instructions: Array<{
        programId: string;
        accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
        data: string;
      }>;
      sessionKeySignature?: string;
    }
  ): Promise<{ id: string; signature: string; status: string }> {
    return this.request(`/accounts/${accountId}/transactions`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getTransaction(
    accountId: string,
    transactionId: string
  ): Promise<{
    id: string;
    signature: string;
    status: string;
    fee: string;
    timestamp: string;
  }> {
    return this.request(`/accounts/${accountId}/transactions/${transactionId}`);
  }

  async listTransactions(
    accountId: string,
    params?: { limit?: number; offset?: number }
  ): Promise<{
    transactions: Array<{ id: string; signature: string; status: string; timestamp: string }>;
    total: number;
  }> {
    const query = new URLSearchParams();
    if (params?.limit) query.set("limit", params.limit.toString());
    if (params?.offset) query.set("offset", params.offset.toString());
    return this.request(`/accounts/${accountId}/transactions?${query.toString()}`);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create a session key with transfer permissions
 */
export async function createTransferSession(
  client: SmartAccountClient,
  accountId: string,
  sessionPublicKey: string,
  options?: {
    name?: string;
    expiresInHours?: number;
    maxPerTransaction?: string;
    dailyLimit?: string;
    allowedDestinations?: string[];
  }
): Promise<SessionKey> {
  const expiresAt = new Date(
    Date.now() + (options?.expiresInHours || 24) * 60 * 60 * 1000
  ).toISOString();

  return client.createSessionKey(accountId, {
    publicKey: sessionPublicKey,
    name: options?.name || "Transfer Session",
    expiresAt,
    permissions: ["transfer"],
    limits: {
      perTransaction: options?.maxPerTransaction,
      daily: options?.dailyLimit,
      allowedDestinations: options?.allowedDestinations,
    },
  });
}

/**
 * Create a spending limit policy
 */
export async function createSpendingLimitPolicy(
  client: SmartAccountClient,
  accountId: string,
  params: {
    name: string;
    mint: string;
    amount: string;
    period: "daily" | "weekly" | "monthly";
  }
): Promise<Policy> {
  return client.createPolicy(accountId, {
    type: "spending_limit",
    name: params.name,
    params: {
      mint: params.mint,
      amount: params.amount,
      period: params.period,
    },
  });
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  console.log("=== Squads Smart Account Setup ===\n");

  if (!CONFIG.apiKey) {
    console.log("Set SQUADS_API_KEY environment variable to use this client.");
    console.log("Get your API key from: https://developers.squads.so\n");

    console.log("Example usage:");
    console.log(`
const client = new SmartAccountClient({ apiKey: "your-api-key" });

// Create an account
const account = await client.createAccount({
  name: "My Wallet",
  type: "personal",
});
console.log("Account:", account.address);

// Create a session key for mobile app
const session = await createTransferSession(client, account.id, sessionPublicKey, {
  name: "Mobile App",
  expiresInHours: 24,
  maxPerTransaction: "1000000000", // 1 SOL
  dailyLimit: "5000000000", // 5 SOL
});
console.log("Session:", session.id);
`);
    return;
  }

  const client = new SmartAccountClient();

  // List accounts
  const { accounts, total } = await client.listAccounts();
  console.log(`Found ${total} accounts:`);
  accounts.forEach((account) => {
    console.log(`  - ${account.name} (${account.address})`);
    console.log(`    Status: ${account.status}`);
  });

  // If we have an account ID, show details
  if (CONFIG.accountId) {
    const account = await client.getAccount();
    console.log("\nAccount Details:");
    console.log("  Address:", account.address);
    console.log("  Status:", account.status);
    console.log("  KYC:", account.kycStatus);

    // List session keys
    const { sessions } = await client.listSessionKeys(CONFIG.accountId);
    console.log("\nSession Keys:", sessions.length);
    sessions.forEach((session) => {
      console.log(`  - ${session.name} (${session.status})`);
      console.log(`    Expires: ${session.expiresAt}`);
    });

    // List policies
    const { policies } = await client.listPolicies(CONFIG.accountId);
    console.log("\nPolicies:", policies.length);
    policies.forEach((policy) => {
      console.log(`  - ${policy.name} (${policy.type})`);
    });
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
