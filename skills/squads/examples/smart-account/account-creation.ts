/**
 * Squads Smart Account: Account Creation Example
 *
 * This example demonstrates how to create and manage smart accounts
 * using the Squads Smart Account REST API.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  apiBaseUrl: "https://developer-api.squads.so/api/v1",
  apiKey: process.env.SQUADS_API_KEY || "",
};

// ============================================================================
// TYPES
// ============================================================================

interface SmartAccount {
  id: string;
  address: string;
  email?: string;
  type: "personal" | "business";
  status: "pending_verification" | "active" | "frozen";
  balance?: {
    SOL?: string;
    USDC?: string;
  };
  kycStatus?: "not_started" | "pending" | "verified" | "failed";
  createdAt: string;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// ============================================================================
// API CLIENT
// ============================================================================

class SmartAccountClient {
  private baseUrl: string;
  private apiKey: string;
  private accessToken?: string;

  constructor(apiKey: string) {
    this.baseUrl = CONFIG.apiBaseUrl;
    this.apiKey = apiKey;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    } else if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || "API request failed");
    }

    return response.json();
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  // ========================================
  // Authentication
  // ========================================

  /**
   * Request an OTP code via email
   */
  async requestEmailOtp(email: string): Promise<{ success: boolean }> {
    return this.request("/auth/email/otp", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  /**
   * Verify OTP and get access tokens
   */
  async verifyEmailOtp(email: string, otp: string): Promise<AuthTokens> {
    const tokens = await this.request<AuthTokens>("/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ email, otp }),
    });
    this.accessToken = tokens.accessToken;
    return tokens;
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    const tokens = await this.request<AuthTokens>("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
    this.accessToken = tokens.accessToken;
    return tokens;
  }

  // ========================================
  // Account Management
  // ========================================

  /**
   * Create a new smart account
   */
  async createAccount(params: {
    name: string;
    type: "personal" | "business";
  }): Promise<SmartAccount> {
    return this.request("/accounts", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /**
   * Get account details
   */
  async getAccount(accountId: string): Promise<SmartAccount> {
    return this.request(`/accounts/${accountId}`);
  }

  /**
   * List all accounts
   */
  async listAccounts(): Promise<{ accounts: SmartAccount[]; total: number }> {
    return this.request("/accounts");
  }

  /**
   * Update account
   */
  async updateAccount(
    accountId: string,
    params: { name?: string }
  ): Promise<{ success: boolean }> {
    return this.request(`/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }
}

// ============================================================================
// EXAMPLE FUNCTIONS
// ============================================================================

/**
 * Example 1: Create account with email authentication
 */
async function createAccountWithEmail(email: string): Promise<void> {
  console.log("\n=== Creating Account with Email Auth ===");

  const client = new SmartAccountClient(CONFIG.apiKey);

  // Step 1: Request OTP
  console.log("Requesting OTP for:", email);
  await client.requestEmailOtp(email);
  console.log("OTP sent to email");

  // Step 2: In a real app, user enters the OTP
  // For demo, we'll simulate this
  const otp = "123456"; // User would enter this

  // Step 3: Verify OTP and get access token
  console.log("Verifying OTP...");
  const tokens = await client.verifyEmailOtp(email, otp);
  console.log("Authenticated successfully");
  console.log("Access token expires in:", tokens.expiresIn, "seconds");

  // Step 4: Create account
  console.log("Creating smart account...");
  const account = await client.createAccount({
    name: "My Wallet",
    type: "personal",
  });

  console.log("Account created:");
  console.log("  ID:", account.id);
  console.log("  Address:", account.address);
  console.log("  Status:", account.status);
}

/**
 * Example 2: Create account with API key (server-side)
 */
async function createAccountServerSide(
  email: string,
  accountName: string
): Promise<SmartAccount> {
  console.log("\n=== Creating Account (Server-Side) ===");

  const client = new SmartAccountClient(CONFIG.apiKey);

  // Create account directly with API key
  const account = await client.createAccount({
    name: accountName,
    type: "personal",
  });

  console.log("Account created:");
  console.log("  ID:", account.id);
  console.log("  Solana Address:", account.address);

  return account;
}

/**
 * Example 3: Get account details and balance
 */
async function getAccountDetails(accountId: string): Promise<void> {
  console.log("\n=== Getting Account Details ===");

  const client = new SmartAccountClient(CONFIG.apiKey);

  const account = await client.getAccount(accountId);

  console.log("Account Details:");
  console.log("  ID:", account.id);
  console.log("  Address:", account.address);
  console.log("  Type:", account.type);
  console.log("  Status:", account.status);
  console.log("  KYC Status:", account.kycStatus || "not_started");

  if (account.balance) {
    console.log("  Balances:");
    if (account.balance.SOL) console.log("    SOL:", account.balance.SOL);
    if (account.balance.USDC) console.log("    USDC:", account.balance.USDC);
  }
}

/**
 * Example 4: List all accounts
 */
async function listAllAccounts(): Promise<void> {
  console.log("\n=== Listing All Accounts ===");

  const client = new SmartAccountClient(CONFIG.apiKey);

  const { accounts, total } = await client.listAccounts();

  console.log(`Found ${total} accounts:`);
  accounts.forEach((account, index) => {
    console.log(`\n${index + 1}. ${account.name || "Unnamed"}`);
    console.log(`   ID: ${account.id}`);
    console.log(`   Address: ${account.address}`);
    console.log(`   Status: ${account.status}`);
  });
}

/**
 * Example 5: Create a business account
 */
async function createBusinessAccount(
  companyName: string
): Promise<SmartAccount> {
  console.log("\n=== Creating Business Account ===");

  const client = new SmartAccountClient(CONFIG.apiKey);

  const account = await client.createAccount({
    name: companyName,
    type: "business",
  });

  console.log("Business account created:");
  console.log("  ID:", account.id);
  console.log("  Address:", account.address);
  console.log("  Type:", account.type);
  console.log("\nNote: Business accounts may require enhanced KYC");

  return account;
}

// ============================================================================
// KYC FLOW
// ============================================================================

/**
 * Example 6: Start KYC verification
 */
async function startKycVerification(
  accountId: string,
  redirectUrl: string
): Promise<void> {
  console.log("\n=== Starting KYC Verification ===");

  const client = new SmartAccountClient(CONFIG.apiKey);

  const response = await client["request"]<{
    inquiryId: string;
    kycUrl: string;
    expiresAt: string;
  }>(`/accounts/${accountId}/kyc`, {
    method: "POST",
    body: JSON.stringify({
      provider: "persona",
      redirectUrl,
    }),
  });

  console.log("KYC flow initiated:");
  console.log("  Inquiry ID:", response.inquiryId);
  console.log("  Redirect user to:", response.kycUrl);
  console.log("  Link expires:", response.expiresAt);
}

/**
 * Example 7: Check KYC status
 */
async function checkKycStatus(accountId: string): Promise<void> {
  console.log("\n=== Checking KYC Status ===");

  const client = new SmartAccountClient(CONFIG.apiKey);

  const status = await client["request"]<{
    status: string;
    level: string;
    verifiedAt?: string;
    expiresAt?: string;
  }>(`/accounts/${accountId}/kyc`);

  console.log("KYC Status:");
  console.log("  Status:", status.status);
  console.log("  Level:", status.level);
  if (status.verifiedAt) {
    console.log("  Verified at:", status.verifiedAt);
  }
  if (status.expiresAt) {
    console.log("  Expires at:", status.expiresAt);
  }

  // Show what the level allows
  switch (status.level) {
    case "basic":
      console.log("  Daily limit: $1,000");
      break;
    case "enhanced":
      console.log("  Daily limit: $10,000");
      break;
    case "full":
      console.log("  Daily limit: $100,000");
      break;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Squads Smart Account Examples ===");

  if (!CONFIG.apiKey) {
    console.log("\nNote: Set SQUADS_API_KEY environment variable to run examples");
    console.log("Get your API key from: https://developers.squads.so\n");

    // Show the flow without making actual API calls
    console.log("Example flow:");
    console.log("1. Request email OTP");
    console.log("2. Verify OTP to get access token");
    console.log("3. Create smart account");
    console.log("4. Complete KYC verification");
    console.log("5. Use session keys for transactions");
    return;
  }

  try {
    // Example: Create an account
    await createAccountServerSide("user@example.com", "My Wallet");

    // Example: List accounts
    await listAllAccounts();
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
