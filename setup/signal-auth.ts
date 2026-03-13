import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const QR_CODE_PATH = path.join(os.tmpdir(), 'nanoclaw-signal-qr.png');

async function generateQRCodeFile(uri: string): Promise<void> {
  const QRCode = await import('qrcode');
  await QRCode.toFile(QR_CODE_PATH, uri, { width: 400, margin: 2 });
}

function openFile(filePath: string): void {
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${filePath}"`);
    } else {
      execSync(`xdg-open "${filePath}" 2>/dev/null`);
    }
  } catch {
    console.log(`Could not auto-open. Open manually: ${filePath}`);
  }
}

export async function run(_args: string[]): Promise<void> {
  console.log('=== NANOCLAW SETUP: SIGNAL_AUTH ===');

  const phoneNumber = process.env.SIGNAL_PHONE_NUMBER || '';
  if (!phoneNumber) {
    console.log('SIGNAL_AUTH_OK=false');
    console.log('STATUS=error');
    console.log('ERROR=SIGNAL_PHONE_NUMBER not set');
    console.log('=== END ===');
    return;
  }

  // Find signal-cli binary
  const { SignalCli } = await import('signal-sdk');
  // We need to access signal-cli directly for the link command.
  // The SDK's deviceLink spawns signal-cli internally, but pipes stdout
  // so QR codes don't display in non-TTY terminals.
  // Instead, we spawn signal-cli ourselves and capture the URI.

  const signalCliBin = path.join(
    process.cwd(),
    'node_modules',
    'signal-sdk',
    'bin',
    'signal-cli',
  );

  if (!fs.existsSync(signalCliBin)) {
    console.log('SIGNAL_AUTH_OK=false');
    console.log('STATUS=error');
    console.log('ERROR=signal-cli binary not found');
    console.log('=== END ===');
    return;
  }

  console.log('Linking as secondary device...');
  console.log('A QR code image will open — scan it with Signal:');
  console.log('  Signal → Settings → Linked Devices → Link New Device');
  console.log('');

  const linkProcess = spawn(signalCliBin, ['link', '--name', 'NanoClaw'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let resolved = false;

  const result = await new Promise<{ success: boolean; error?: string }>(
    (resolve) => {
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          linkProcess.kill();
          resolve({ success: false, error: 'Timeout — QR code not scanned within 120s' });
        }
      }, 120_000);

      linkProcess.stdout.on('data', async (data: Buffer) => {
        const output = data.toString('utf8');

        // Look for the signal linking URI
        const uriMatch = output.match(/sgnl:\/\/[^\s]+/);
        if (uriMatch) {
          const uri = uriMatch[0];
          console.log(`Link URI captured. Generating QR code...`);

          try {
            await generateQRCodeFile(uri);
            console.log(`QR code saved to: ${QR_CODE_PATH}`);
            openFile(QR_CODE_PATH);
            console.log('QR code opened — scan it now! Waiting for scan...');
          } catch (err) {
            console.log(`QR generation failed. Scan this URI manually:`);
            console.log(uri);
          }
        }

        // Check for successful linking
        if (output.includes('Associated with')) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve({ success: true });
          }
        }
      });

      linkProcess.stderr.on('data', (data: Buffer) => {
        const output = data.toString('utf8').trim();
        if (output) {
          // Log but don't fail on stderr — signal-cli is noisy
          console.error(`[signal-cli] ${output}`);
        }
      });

      linkProcess.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `signal-cli exited with code ${code}` });
          }
        }
      });
    },
  );

  // Cleanup QR code file
  try {
    fs.unlinkSync(QR_CODE_PATH);
  } catch {
    /* best effort */
  }

  if (result.success) {
    console.log('');
    console.log('SIGNAL_AUTH_OK=true');
    console.log('STATUS=success');
  } else {
    console.log('');
    console.log('SIGNAL_AUTH_OK=false');
    console.log('STATUS=error');
    console.log(`ERROR=${result.error}`);
  }

  console.log('=== END ===');
}
