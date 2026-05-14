/**
 * Cross-platform Chromium-family browser detection for the X-integration skill.
 *
 * Resolves the user's *real* browser so X's bot detection sees a normal
 * logged-in session. Supports Chrome, Chromium, and Brave (all Chromium-
 * based — Playwright's `chromium` driver works with any of them via
 * `executablePath`).
 *
 * Resolution order:
 *   1. CHROME_PATH env var — explicit override, wins over auto-detection.
 *      Pin Brave with `CHROME_PATH=/usr/bin/brave-browser` (or the macOS
 *      bundle path) to force Brave even if Chrome is also installed.
 *   2. Platform-specific probe — Chrome variants first (most common),
 *      then Brave, then Chromium.
 *   3. Throw with an actionable install hint.
 *
 * Why no fallback to Playwright's bundled Chromium: the entire point of the
 * skill is to drive the user's *real* browser. Bundled Chromium fails X's
 * bot-detection check.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

export function detectChromePath(): string {
  const override = process.env.CHROME_PATH;
  if (override && fs.existsSync(override)) {
    return override;
  }

  const platform = os.platform();

  if (platform === 'darwin') {
    const macAppDirs: Array<{ app: string; exe: string; bundleId: string }> = [
      {
        app: '/Applications/Google Chrome.app',
        exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        bundleId: 'com.google.Chrome',
      },
      {
        app: '/Applications/Brave Browser.app',
        exe: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        bundleId: 'com.brave.Browser',
      },
      {
        app: '/Applications/Chromium.app',
        exe: '/Applications/Chromium.app/Contents/MacOS/Chromium',
        bundleId: 'org.chromium.Chromium',
      },
    ];
    for (const { exe } of macAppDirs) {
      if (fs.existsSync(exe)) return exe;
    }
    for (const { bundleId } of macAppDirs) {
      try {
        const bundle = execSync(
          `mdfind "kMDItemCFBundleIdentifier == '${bundleId}'" 2>/dev/null | head -1`,
          { encoding: 'utf8' },
        ).trim();
        if (bundle) {
          const match = macAppDirs.find((d) => d.bundleId === bundleId);
          if (match) {
            const exe = bundle + match.exe.slice(match.app.length);
            if (fs.existsSync(exe)) return exe;
          }
        }
      } catch {}
    }
  } else if (platform === 'linux') {
    const candidates = [
      'google-chrome-stable',
      'google-chrome',
      'brave-browser',
      'brave',
      'chromium-browser',
      'chromium',
    ];
    for (const cmd of candidates) {
      try {
        const found = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (found && fs.existsSync(found)) return found;
      } catch {}
    }
    for (const path of ['/snap/bin/chromium', '/snap/bin/brave', '/opt/brave.com/brave/brave']) {
      if (fs.existsSync(path)) return path;
    }

    // Detect Flatpak installs and emit a specific error — Playwright cannot
    // launch a sandboxed Flatpak browser via executablePath. Users have to
    // install the native package alongside.
    try {
      const flatpakList = execSync('flatpak list --app 2>/dev/null', { encoding: 'utf8' });
      const hasBrave = /com\.brave\.Browser/i.test(flatpakList);
      const hasChrome = /com\.google\.Chrome/i.test(flatpakList);
      const hasChromium = /org\.chromium\.Chromium/i.test(flatpakList);
      if (hasBrave || hasChrome || hasChromium) {
        const which = hasBrave ? 'Brave' : hasChrome ? 'Chrome' : 'Chromium';
        const installCmd = hasBrave
          ? 'install brave-browser as a .deb (curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg && echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg arch=amd64] https://brave-browser-apt-release.s3.brave.com/ stable main" | sudo tee /etc/apt/sources.list.d/brave-browser-release.list && sudo apt update && sudo apt install brave-browser)'
          : hasChrome
            ? 'install google-chrome-stable as a .deb (sudo apt install google-chrome-stable)'
            : 'install chromium-browser as a .deb (sudo apt install chromium-browser)';
        throw new Error(
          `${which} detected as Flatpak (sandboxed) — Playwright cannot drive sandboxed Flatpak browsers. Please ${installCmd}. Both installs can coexist.`,
        );
      }
    } catch (e) {
      // Re-throw the explicit Flatpak error; swallow `flatpak` not-found
      if (e instanceof Error && e.message.includes('Flatpak')) throw e;
    }
  }

  const installHint =
    platform === 'linux'
      ? 'Install one of: `sudo apt install google-chrome-stable` | `sudo apt install brave-browser` (after adding the Brave repo) | `sudo apt install chromium-browser`. Or set CHROME_PATH in .env to an explicit binary.'
      : platform === 'darwin'
        ? 'Install Chrome (https://www.google.com/chrome/), Brave (https://brave.com/download/), or Chromium. Or set CHROME_PATH in .env.'
        : 'Install a Chromium-based browser and set CHROME_PATH in .env.';
  throw new Error(`No Chromium-family browser found on ${platform}. ${installHint}`);
}
