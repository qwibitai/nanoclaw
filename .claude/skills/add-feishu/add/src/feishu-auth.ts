/**
 * Feishu Bot Authentication Setup
 * Interactive script to configure Feishu (Lark) bot credentials.
 * Run: npm run auth:feishu
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import * as Lark from '@larksuiteoapi/node-sdk';

const STORE_DIR = path.join(process.cwd(), 'store');
const CREDS_PATH = path.join(STORE_DIR, 'feishu-credentials.json');

interface FeishuCredentials {
    appId: string;
    appSecret: string;
    encryptKey?: string;
    verificationToken?: string;
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });
}

async function testConnection(
    creds: FeishuCredentials,
): Promise<{ success: boolean; botName?: string; error?: string }> {
    try {
        const client = new Lark.Client({
            appId: creds.appId,
            appSecret: creds.appSecret,
            appType: Lark.AppType.SelfBuild,
        });

        const response = await (client as any).request({
            method: 'GET',
            url: '/open-apis/bot/v3/info',
        });

        if (response.code === 0 && response.bot) {
            return { success: true, botName: response.bot.bot_name };
        }
        return {
            success: false,
            error: response.msg || `Error code: ${response.code}`,
        };
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

async function main(): Promise<void> {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║           Feishu (Lark) Bot Authentication Setup           ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Setup Instructions:');
    console.log('1. Go to https://open.feishu.cn/app');
    console.log('2. Click "Create Custom App"');
    console.log('3. Enable "Bot" capability in the app settings');
    console.log('4. Copy the App ID and App Secret from the credentials page');
    console.log(
        '5. In "Event Subscriptions", enable: im.message.receive_v1',
    );
    console.log('6. Set the connection mode to "WebSocket (Long Connection)"');
    console.log('7. Add bot to your Feishu group or direct message');
    console.log('');

    // Check for existing credentials
    if (fs.existsSync(CREDS_PATH)) {
        try {
            const existing: FeishuCredentials = JSON.parse(
                fs.readFileSync(CREDS_PATH, 'utf-8'),
            );
            console.log('⚠️  Existing credentials found.');
            const overwrite = await ask('Overwrite? (y/N): ');
            if (overwrite.toLowerCase() !== 'y') {
                console.log('Keeping existing credentials.');
                const testResult = await testConnection(existing);
                if (!testResult.success) {
                    console.error('❌ Connection failed:', testResult.error);
                    rl.close();
                    process.exit(1);
                }
                console.log(
                    `✅ Connection successful! Bot: ${testResult.botName || 'Unknown'}`,
                );
                rl.close();
                process.exit(0);
            }
        } catch {
            // Invalid existing file — continue to collect new credentials
        }
    }

    const appId = await ask('App ID: ');
    if (!appId) {
        console.error('❌ App ID is required');
        rl.close();
        process.exit(1);
    }

    const appSecret = await ask('App Secret: ');
    if (!appSecret) {
        console.error('❌ App Secret is required');
        rl.close();
        process.exit(1);
    }

    console.log('');
    console.log('Optional security settings (press Enter to skip):');
    const encryptKey = await ask('Encrypt Key (optional): ');
    const verificationToken = await ask('Verification Token (optional): ');

    const creds: FeishuCredentials = {
        appId,
        appSecret,
        ...(encryptKey && { encryptKey }),
        ...(verificationToken && { verificationToken }),
    };

    console.log('');
    console.log('🔄 Testing connection to Feishu API...');

    const testResult = await testConnection(creds);
    if (!testResult.success) {
        console.error('❌ Connection failed:', testResult.error);
        console.log('Please check your App ID and App Secret and try again.');
        rl.close();
        process.exit(1);
    }

    console.log(`✅ Connection successful! Bot: ${testResult.botName}`);

    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
    fs.chmodSync(CREDS_PATH, 0o600);

    console.log('');
    console.log(`✅ Credentials saved to: ${CREDS_PATH}`);
    console.log('');
    console.log('Next steps:');
    console.log('1. Add the bot to your Feishu group or DM');
    console.log(
        '2. Register the chat with NanoClaw by sending a message from the main group:',
    );
    console.log('   Ask it to add the Feishu group using register_group IPC');
    console.log('3. Restart NanoClaw: npm run dev');

    rl.close();
    process.exit(0);
}

main().catch((err) => {
    console.error('Error:', err);
    rl.close();
    process.exit(1);
});
