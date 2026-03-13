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

function getSignalCliBin(): string {
  return path.join(
    process.cwd(),
    'node_modules',
    'signal-sdk',
    'bin',
    'signal-cli',
  );
}

function getJavaEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  // Ensure Homebrew Java is available (signal-cli needs Java 25+)
  const homebrewJava = '/opt/homebrew/opt/openjdk/bin/java';
  if (fs.existsSync(homebrewJava)) {
    try {
      const output = execSync(
        `${homebrewJava} -XshowSettings:properties -version 2>&1`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      const match = output.match(/java\.home\s*=\s*(.+)/);
      if (match) {
        env.JAVA_HOME = match[1].trim();
        env.PATH = `/opt/homebrew/opt/openjdk/bin:${env.PATH || ''}`;
      }
    } catch { /* use system Java */ }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Mode: linked — Link as secondary device via QR code scan
// ---------------------------------------------------------------------------

async function runLinked(phoneNumber: string): Promise<{ success: boolean; error?: string }> {
  const signalCliBin = getSignalCliBin();

  console.log('Linking as secondary device...');
  console.log('A QR code image will open — scan it with Signal:');
  console.log('  Signal → Settings → Linked Devices → Link New Device');
  console.log('');

  const linkProcess = spawn(signalCliBin, ['link', '--name', 'NanoClaw'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: getJavaEnv(),
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
  } catch { /* best effort */ }

  return result;
}

// ---------------------------------------------------------------------------
// Mode: primary — Register as primary device via SMS verification
// ---------------------------------------------------------------------------

async function runPrimary(phoneNumber: string): Promise<{ success: boolean; error?: string }> {
  const signalCliBin = getSignalCliBin();
  const env = getJavaEnv();

  console.log(`Registering ${phoneNumber} as primary device...`);
  console.log('An SMS verification code will be sent to this number.');
  console.log('');

  // Step 1: Send registration SMS
  try {
    const registerArgs = ['-u', phoneNumber, 'register'];
    console.log('Sending verification SMS...');
    execSync(`${JSON.stringify(signalCliBin)} ${registerArgs.join(' ')}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: 30_000,
    });
    console.log('Verification SMS sent.');
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString('utf8') || '';

    // Check if captcha is required
    if (stderr.includes('captcha') || stderr.includes('CAPTCHA')) {
      console.log('');
      console.log('Signal requires a captcha challenge before registration.');
      console.log('1. Open https://signalcaptchas.org/registration/generate.html in a browser');
      console.log('2. Complete the captcha');
      console.log('3. Copy the signalcaptcha:// URI from the page');
      console.log('');
      console.log('SIGNAL_AUTH_OK=false');
      console.log('STATUS=captcha_required');
      console.log('CAPTCHA_URL=https://signalcaptchas.org/registration/generate.html');
      return { success: false, error: 'captcha_required' };
    }

    console.error(`Registration failed: ${stderr}`);
    return { success: false, error: `register failed: ${stderr.slice(0, 200)}` };
  }

  // Step 2: Wait for user to provide verification code
  // The calling skill (add-signal) will prompt the user for the code
  // and call signal-auth again with --verify <code>
  console.log('');
  console.log('SIGNAL_AUTH_OK=pending');
  console.log('STATUS=awaiting_verification');
  console.log('NEXT_STEP=Run signal-auth again with --verify <code>');
  return { success: true };
}

async function runVerify(
  phoneNumber: string,
  code: string,
  captcha?: string,
): Promise<{ success: boolean; error?: string }> {
  const signalCliBin = getSignalCliBin();
  const env = getJavaEnv();

  // If captcha provided, re-register with captcha first
  if (captcha) {
    console.log('Re-registering with captcha token...');
    try {
      const registerArgs = ['-u', phoneNumber, 'register', '--captcha', captcha];
      execSync(`${JSON.stringify(signalCliBin)} ${registerArgs.join(' ')}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        timeout: 30_000,
      });
      console.log('Verification SMS sent (with captcha). Enter the code.');
      console.log('');
      console.log('SIGNAL_AUTH_OK=pending');
      console.log('STATUS=awaiting_verification');
      return { success: true };
    } catch (err: unknown) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString('utf8') || '';
      return { success: false, error: `register with captcha failed: ${stderr.slice(0, 200)}` };
    }
  }

  // Verify the SMS code
  console.log(`Verifying code: ${code}...`);
  try {
    const verifyArgs = ['-u', phoneNumber, 'verify', code];
    execSync(`${JSON.stringify(signalCliBin)} ${verifyArgs.join(' ')}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: 30_000,
    });
    console.log('Verification successful — registered as primary device.');

    // Set a profile name so the bot shows up nicely in groups
    try {
      const profileName = process.env.ASSISTANT_NAME || 'Andy';
      execSync(
        `${JSON.stringify(signalCliBin)} -u ${phoneNumber} updateProfile --given-name ${JSON.stringify(profileName)}`,
        { stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 15_000 },
      );
      console.log(`Profile name set to "${profileName}".`);
    } catch {
      console.log('Could not set profile name (non-critical, can be set later).');
    }

    return { success: true };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString('utf8') || '';
    return { success: false, error: `verify failed: ${stderr.slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<void> {
  console.log('=== NANOCLAW SETUP: SIGNAL_AUTH ===');

  const phoneNumber = process.env.SIGNAL_PHONE_NUMBER || '';
  if (!phoneNumber) {
    console.log('SIGNAL_AUTH_OK=false');
    console.log('STATUS=error');
    console.log('ERROR=SIGNAL_PHONE_NUMBER not set');
    console.log('=== END ===');
    return;
  }

  const signalCliBin = getSignalCliBin();
  if (!fs.existsSync(signalCliBin)) {
    console.log('SIGNAL_AUTH_OK=false');
    console.log('STATUS=error');
    console.log('ERROR=signal-cli binary not found');
    console.log('=== END ===');
    return;
  }

  // Parse mode from args: --mode linked|primary, --verify <code>, --captcha <token>
  const modeIdx = args.indexOf('--mode');
  const mode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : 'linked';

  const verifyIdx = args.indexOf('--verify');
  const verifyCode = verifyIdx !== -1 ? args[verifyIdx + 1] : undefined;

  const captchaIdx = args.indexOf('--captcha');
  const captchaToken = captchaIdx !== -1 ? args[captchaIdx + 1] : undefined;

  let result: { success: boolean; error?: string };

  if (verifyCode || captchaToken) {
    // Verify step (for primary registration)
    result = await runVerify(phoneNumber, verifyCode || '', captchaToken);
  } else if (mode === 'primary') {
    result = await runPrimary(phoneNumber);
  } else {
    result = await runLinked(phoneNumber);
  }

  if (result.success) {
    // Don't print success for pending verification
    if (!verifyCode && mode === 'primary' && !captchaToken) {
      // Pending — status already printed by runPrimary
    } else {
      console.log('');
      console.log('SIGNAL_AUTH_OK=true');
      console.log('STATUS=success');
      console.log(`MODE=${mode}`);
    }
  } else if (result.error !== 'captcha_required') {
    console.log('');
    console.log('SIGNAL_AUTH_OK=false');
    console.log('STATUS=error');
    console.log(`ERROR=${result.error}`);
  }

  console.log('=== END ===');
}
