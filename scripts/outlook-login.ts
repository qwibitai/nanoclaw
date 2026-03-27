/**
 * Interactive Outlook login via device code flow.
 * Stores refresh token in ~/.outlook-mcp/credentials.json for NanoClaw.
 *
 * Usage: npx tsx scripts/outlook-login.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PublicClientApplication, DeviceCodeRequest } from '@azure/msal-node';

const credDir = path.join(os.homedir(), '.outlook-mcp');
const tokensPath = path.join(credDir, 'credentials.json');

// Read from .env manually
import { readFileSync } from 'fs';
const envContent = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.env'), 'utf-8');
const envVars: Record<string, string> = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) envVars[match[1].trim()] = match[2].trim();
}

const clientId = envVars.MS_CLIENT_ID;
const tenantId = envVars.MS_TENANT_ID;

if (!clientId || !tenantId) {
  console.error('MS_CLIENT_ID and MS_TENANT_ID must be set in .env');
  process.exit(1);
}

const scopes = ['Mail.Read', 'Mail.Send', 'User.Read', 'offline_access'];

const pca = new PublicClientApplication({
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
  },
});

async function main() {
  const request: DeviceCodeRequest = {
    scopes,
    deviceCodeCallback: (response) => {
      console.log('\n' + response.message + '\n');
    },
  };

  try {
    const result = await pca.acquireTokenByDeviceCode(request);
    if (!result) {
      console.error('No result from device code flow');
      process.exit(1);
    }

    fs.mkdirSync(credDir, { recursive: true });

    const creds = {
      accessToken: result.accessToken,
      expiresOn: result.expiresOn?.toISOString(),
      account: result.account,
      scopes: result.scopes,
    };

    // Also cache the full account for silent token renewal
    const cache = pca.getTokenCache().serialize();
    fs.writeFileSync(path.join(credDir, 'msal-cache.json'), cache);
    fs.writeFileSync(tokensPath, JSON.stringify(creds, null, 2));

    console.log(`\n✅ Authenticated as ${result.account?.username}`);
    console.log(`Tokens saved to ${credDir}`);
  } catch (err) {
    console.error('Authentication failed:', err);
    process.exit(1);
  }
}

main();
