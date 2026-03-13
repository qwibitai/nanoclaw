import fs from 'fs';
import path from 'path';

const STORE_DIR = path.resolve(process.cwd(), 'store');

export async function run(_args: string[]): Promise<void> {
  const dataDir = path.join(STORE_DIR, 'signal');
  fs.mkdirSync(dataDir, { recursive: true });

  console.log('=== NANOCLAW SETUP: SIGNAL_AUTH ===');

  try {
    const { SignalCli } = await import('signal-sdk');

    const signal = new SignalCli(process.env.SIGNAL_PHONE_NUMBER || '');

    console.log('Linking as secondary device...');
    console.log('Scan the QR code below with Signal on your phone:');
    console.log('  Signal → Settings → Linked Devices → Link New Device');
    console.log('');

    // deviceLink displays QR in terminal and waits for scan
    // API uses `name` (not `deviceName`) per signal-sdk type definitions
    await signal.deviceLink({ name: 'NanoClaw' });

    console.log('');
    console.log('SIGNAL_AUTH_OK=true');
    console.log('STATUS=success');

    await signal.gracefulShutdown();
  } catch (err) {
    console.error('Signal device linking failed:', err);
    console.log('SIGNAL_AUTH_OK=false');
    console.log('STATUS=error');
    console.log(`ERROR=${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('=== END ===');
}
