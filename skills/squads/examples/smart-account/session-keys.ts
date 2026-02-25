/**
 * Squads Smart Account: Session Keys Example
 *
 * This example demonstrates how to create, manage, and use session keys
 * for delegated access to smart accounts.
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

interface SessionKey {
  id: string;
  publicKey: string;
  name: string;
  expiresAt: string;
  permissions: string[];
  limits?: {
    perTransaction?: string;
    daily?: string;
    allowedMints?: string[];
    allowedDestinations?: string[];
  };
  status: "active" | "expired" | "revoked";
  createdAt: string;
  lastUsed?: string;
}

interface SessionKeyCreateParams {
  publicKey: string;
  name: string;
  expiresAt: string;
  permissions: string[];
  limits?: {
    perTransaction?: string;
    daily?: string;
    allowedMints?: string[];
    allowedDestinations?: string[];
  };
}

// ============================================================================
// SESSION KEY CLIENT
// ============================================================================

class SessionKeyClient {
  private baseUrl: string;
  private accessToken: string;

  constructor(accessToken: string) {
    this.baseUrl = CONFIG.apiBaseUrl;
    this.accessToken = accessToken;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        ...(options.headers as Record<string, string>),
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || "API request failed");
    }

    return response.json();
  }

  /**
   * Create a new session key
   */
  async createSessionKey(
    accountId: string,
    params: SessionKeyCreateParams
  ): Promise<SessionKey> {
    return this.request(`/accounts/${accountId}/sessions`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /**
   * List all session keys for an account
   */
  async listSessionKeys(
    accountId: string
  ): Promise<{ sessions: SessionKey[]; total: number }> {
    return this.request(`/accounts/${accountId}/sessions`);
  }

  /**
   * Get a specific session key
   */
  async getSessionKey(accountId: string, sessionId: string): Promise<SessionKey> {
    return this.request(`/accounts/${accountId}/sessions/${sessionId}`);
  }

  /**
   * Revoke a session key
   */
  async revokeSessionKey(
    accountId: string,
    sessionId: string
  ): Promise<{ success: boolean }> {
    return this.request(`/accounts/${accountId}/sessions/${sessionId}`, {
      method: "DELETE",
    });
  }
}

// ============================================================================
// EXAMPLE FUNCTIONS
// ============================================================================

/**
 * Example 1: Create a basic session key for transfers
 */
async function createTransferSessionKey(
  accessToken: string,
  accountId: string,
  sessionPublicKey: string
): Promise<SessionKey> {
  console.log("\n=== Creating Transfer Session Key ===");

  const client = new SessionKeyClient(accessToken);

  const sessionKey = await client.createSessionKey(accountId, {
    publicKey: sessionPublicKey,
    name: "Mobile App - Transfers",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
    permissions: ["transfer"],
    limits: {
      perTransaction: "1000000000", // 1 SOL max per transaction
      daily: "5000000000", // 5 SOL daily max
    },
  });

  console.log("Session key created:");
  console.log("  ID:", sessionKey.id);
  console.log("  Name:", sessionKey.name);
  console.log("  Expires:", sessionKey.expiresAt);
  console.log("  Permissions:", sessionKey.permissions.join(", "));
  console.log("  Limits:", JSON.stringify(sessionKey.limits, null, 2));

  return sessionKey;
}

/**
 * Example 2: Create a session key with multiple permissions
 */
async function createFullAccessSessionKey(
  accessToken: string,
  accountId: string,
  sessionPublicKey: string
): Promise<SessionKey> {
  console.log("\n=== Creating Full Access Session Key ===");

  const client = new SessionKeyClient(accessToken);

  const sessionKey = await client.createSessionKey(accountId, {
    publicKey: sessionPublicKey,
    name: "Desktop App - Full Access",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    permissions: ["transfer", "swap", "stake", "sign_message"],
    limits: {
      perTransaction: "10000000000", // 10 SOL
      daily: "50000000000", // 50 SOL
    },
  });

  console.log("Full access session key created:");
  console.log("  ID:", sessionKey.id);
  console.log("  Permissions:", sessionKey.permissions.join(", "));

  return sessionKey;
}

/**
 * Example 3: Create a restricted session key (specific destinations)
 */
async function createRestrictedSessionKey(
  accessToken: string,
  accountId: string,
  sessionPublicKey: string,
  allowedDestinations: string[]
): Promise<SessionKey> {
  console.log("\n=== Creating Restricted Session Key ===");

  const client = new SessionKeyClient(accessToken);

  const sessionKey = await client.createSessionKey(accountId, {
    publicKey: sessionPublicKey,
    name: "Payroll Bot",
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    permissions: ["transfer"],
    limits: {
      perTransaction: "100000000000", // 100 SOL
      daily: "1000000000000", // 1000 SOL
      allowedDestinations, // Only to these addresses
      allowedMints: [
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC only
      ],
    },
  });

  console.log("Restricted session key created:");
  console.log("  Allowed destinations:", allowedDestinations.length);
  console.log("  Allowed mints: USDC only");

  return sessionKey;
}

/**
 * Example 4: Create a swap-only session key
 */
async function createSwapSessionKey(
  accessToken: string,
  accountId: string,
  sessionPublicKey: string
): Promise<SessionKey> {
  console.log("\n=== Creating Swap-Only Session Key ===");

  const client = new SessionKeyClient(accessToken);

  const sessionKey = await client.createSessionKey(accountId, {
    publicKey: sessionPublicKey,
    name: "Trading Bot",
    expiresAt: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(), // 1 hour
    permissions: ["swap"], // Only swap, no transfers
    limits: {
      perTransaction: "100000000000", // 100 SOL equivalent
    },
  });

  console.log("Swap session key created:");
  console.log("  Permissions: swap only");
  console.log("  Expires in 1 hour");

  return sessionKey;
}

/**
 * Example 5: List and manage session keys
 */
async function manageSessionKeys(
  accessToken: string,
  accountId: string
): Promise<void> {
  console.log("\n=== Managing Session Keys ===");

  const client = new SessionKeyClient(accessToken);

  // List all session keys
  const { sessions, total } = await client.listSessionKeys(accountId);

  console.log(`Found ${total} session keys:`);
  sessions.forEach((session, index) => {
    console.log(`\n${index + 1}. ${session.name}`);
    console.log(`   ID: ${session.id}`);
    console.log(`   Status: ${session.status}`);
    console.log(`   Expires: ${session.expiresAt}`);
    console.log(`   Permissions: ${session.permissions.join(", ")}`);
    if (session.lastUsed) {
      console.log(`   Last used: ${session.lastUsed}`);
    }
  });

  // Check for expired sessions
  const expiredSessions = sessions.filter(
    (s) => new Date(s.expiresAt) < new Date()
  );
  if (expiredSessions.length > 0) {
    console.log(`\n⚠ ${expiredSessions.length} session(s) have expired`);
  }

  // Check for active sessions
  const activeSessions = sessions.filter((s) => s.status === "active");
  console.log(`\n✓ ${activeSessions.length} active session(s)`);
}

/**
 * Example 6: Revoke a session key
 */
async function revokeSession(
  accessToken: string,
  accountId: string,
  sessionId: string
): Promise<void> {
  console.log("\n=== Revoking Session Key ===");

  const client = new SessionKeyClient(accessToken);

  await client.revokeSessionKey(accountId, sessionId);

  console.log("Session key revoked:", sessionId);
}

/**
 * Example 7: Using a session key to sign a transaction
 */
async function useSessionKeyForTransaction(
  accessToken: string,
  accountId: string,
  sessionKeySignature: string, // Signature from the session key
  recipientAddress: string,
  amount: string
): Promise<void> {
  console.log("\n=== Using Session Key for Transaction ===");

  // In a real implementation, you would:
  // 1. Build the transaction on the client
  // 2. Sign with the session key
  // 3. Send to the API with the signature

  const response = await fetch(
    `${CONFIG.apiBaseUrl}/accounts/${accountId}/transactions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        instructions: [
          {
            programId: "11111111111111111111111111111111", // System Program
            accounts: [
              { pubkey: "FROM_ADDRESS", isSigner: true, isWritable: true },
              { pubkey: recipientAddress, isSigner: false, isWritable: true },
            ],
            data: "base64-encoded-transfer-data",
          },
        ],
        sessionKeySignature, // Proves the session key authorized this
      }),
    }
  );

  if (!response.ok) {
    throw new Error("Transaction failed");
  }

  const result = await response.json();
  console.log("Transaction executed:");
  console.log("  Signature:", result.signature);
  console.log("  Status:", result.status);
}

// ============================================================================
// BEST PRACTICES
// ============================================================================

/**
 * Session Key Best Practices:
 *
 * 1. Minimum Permissions: Only grant permissions the app needs
 *    - Don't grant "transfer" if app only needs "swap"
 *
 * 2. Short Expiration: Use short expiration times for sensitive operations
 *    - Trading bot: 1-4 hours
 *    - Mobile app: 24 hours
 *    - Desktop app: 7 days max
 *
 * 3. Transaction Limits: Always set reasonable limits
 *    - perTransaction: Max amount per single transaction
 *    - daily: Total daily spend limit
 *
 * 4. Destination Restrictions: For automated systems
 *    - Payroll: Only employee addresses
 *    - Trading: Only DEX program addresses
 *
 * 5. Regular Rotation: Revoke and recreate session keys periodically
 *
 * 6. Audit Logging: Monitor session key usage
 *    - Check lastUsed timestamps
 *    - Alert on unexpected activity
 */

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Squads Smart Account Session Keys Examples ===");

  const accessToken = process.env.SQUADS_ACCESS_TOKEN || "";
  const accountId = process.env.SQUADS_ACCOUNT_ID || "";

  if (!accessToken || !accountId) {
    console.log("\nNote: Set environment variables to run examples:");
    console.log("  SQUADS_ACCESS_TOKEN - Your access token");
    console.log("  SQUADS_ACCOUNT_ID - Your account ID\n");

    console.log("Session Key Flow:");
    console.log("1. Generate a keypair on the client device");
    console.log("2. Send the public key to create a session");
    console.log("3. Use the private key to sign transactions");
    console.log("4. API validates signature against session permissions");
    console.log("5. Revoke session when no longer needed");
    return;
  }

  try {
    // Example session key public key (in real use, generate on client)
    const sessionPublicKey = "ExampleSessionPublicKey123...";

    // Create a session key
    const sessionKey = await createTransferSessionKey(
      accessToken,
      accountId,
      sessionPublicKey
    );

    // List all session keys
    await manageSessionKeys(accessToken, accountId);

    // Clean up
    // await revokeSession(accessToken, accountId, sessionKey.id);
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
