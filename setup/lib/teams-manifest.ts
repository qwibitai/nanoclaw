/**
 * Build the Teams app package zip that the operator sideloads from the Teams
 * "Manage your apps" screen.
 *
 * A Teams app package is a zip containing:
 *   - manifest.json  — declares the bot, scopes, required permissions
 *   - outline.png    — 32×32 transparent outline icon
 *   - color.png      — 192×192 full-color icon
 *
 * Icons are generated in-process using a minimal PNG encoder so we don't
 * need ImageMagick or vendor binary icon blobs into the repo. The outline
 * icon is a simple rounded square outline; the color icon is a brand-blue
 * filled square with a small white "N" blocked in by pixel setting. Good
 * enough for a working sideload — teams admins who care can replace the
 * icons later.
 *
 * The manifest is pinned to schema v1.16 to match the skill doc.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const MANIFEST_SCHEMA =
  'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json';
const MANIFEST_VERSION = '1.16';

export interface ManifestOptions {
  /** The Azure AD app ID (same value used for `bots[0].botId`). */
  appId: string;
  /** Short bot name shown in Teams (<= 30 chars). */
  shortName: string;
  /** Long bot description. */
  longDescription: string;
  /** Developer website URL (required by schema — any reachable URL works). */
  websiteUrl: string;
  /** Out-dir for the generated zip + loose files. */
  outDir: string;
}

export interface ManifestResult {
  zipPath: string;
  manifestPath: string;
  outlinePath: string;
  colorPath: string;
}

/** Build the full app package zip and return the paths. */
export function buildTeamsAppPackage(opts: ManifestOptions): ManifestResult {
  fs.mkdirSync(opts.outDir, { recursive: true });

  const manifestPath = path.join(opts.outDir, 'manifest.json');
  const outlinePath = path.join(opts.outDir, 'outline.png');
  const colorPath = path.join(opts.outDir, 'color.png');
  const zipPath = path.join(opts.outDir, 'teams-app-package.zip');

  fs.writeFileSync(manifestPath, renderManifest(opts));
  fs.writeFileSync(outlinePath, encodeOutlineIcon());
  fs.writeFileSync(colorPath, encodeColorIcon());

  // Fresh zip every run — idempotent, no stale files.
  try {
    fs.unlinkSync(zipPath);
  } catch {
    // noop if missing
  }
  execSync(`zip -j -q "${zipPath}" "${manifestPath}" "${outlinePath}" "${colorPath}"`, {
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  return { zipPath, manifestPath, outlinePath, colorPath };
}

function renderManifest(opts: ManifestOptions): string {
  const manifest = {
    $schema: MANIFEST_SCHEMA,
    manifestVersion: MANIFEST_VERSION,
    version: '1.0.0',
    id: opts.appId,
    packageName: 'com.nanoclaw.bot',
    developer: {
      name: 'NanoClaw',
      websiteUrl: opts.websiteUrl,
      privacyUrl: opts.websiteUrl,
      termsOfUseUrl: opts.websiteUrl,
    },
    name: {
      short: opts.shortName.slice(0, 30),
      full: `${opts.shortName} Assistant`,
    },
    description: {
      short: 'Your personal assistant in Teams.',
      full: opts.longDescription,
    },
    icons: { outline: 'outline.png', color: 'color.png' },
    accentColor: '#4A90D9',
    bots: [
      {
        botId: opts.appId,
        scopes: ['personal', 'team', 'groupchat'],
        supportsFiles: false,
        isNotificationOnly: false,
      },
    ],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [new URL(opts.websiteUrl).host],
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

// ─── Minimal PNG encoder (solid color, no external deps) ──────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Precompute the CRC-32 table per the PNG spec. Node doesn't expose CRC32
// directly (zlib.crc32 isn't part of the public API), so we roll our own.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encode a solid-color RGBA image as a PNG. `pixels` is a width*height*4
 * byte array (R, G, B, A per pixel, row-major, top-to-bottom).
 */
function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT: scanlines with filter byte 0 (None) prepended per row.
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    for (let x = 0; x < rowBytes; x++) {
      raw[y * (rowBytes + 1) + 1 + x] = pixels[y * rowBytes + x];
    }
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Outline icon: 32×32 transparent background with a simple white rounded-
 * square outline. Teams renders it against a colored background so the
 * outline needs to be visible on both light and dark.
 */
function encodeOutlineIcon(): Buffer {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  const inset = 4;
  const stroke = 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const onBorder =
        ((x >= inset && x < inset + stroke) || (x >= size - inset - stroke && x < size - inset)) &&
        y >= inset &&
        y < size - inset;
      const onTopBot =
        ((y >= inset && y < inset + stroke) || (y >= size - inset - stroke && y < size - inset)) &&
        x >= inset &&
        x < size - inset;
      const i = (y * size + x) * 4;
      if (onBorder || onTopBot) {
        pixels[i] = 255;
        pixels[i + 1] = 255;
        pixels[i + 2] = 255;
        pixels[i + 3] = 255;
      } else {
        pixels[i] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
        pixels[i + 3] = 0; // transparent
      }
    }
  }
  return encodePng(size, size, pixels);
}

/**
 * Color icon: 192×192 brand-blue filled square with a white "N" shape drawn
 * with simple bars (left vertical, right vertical, diagonal from top-right
 * to bottom-left). Crude but recognizable at a glance.
 */
function encodeColorIcon(): Buffer {
  const size = 192;
  const pixels = new Uint8Array(size * size * 4);
  // Brand blue #4A90D9
  const BG_R = 0x4a;
  const BG_G = 0x90;
  const BG_B = 0xd9;
  const thickness = 24;
  const margin = 40;
  const leftBarX = margin;
  const rightBarX = size - margin - thickness;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      pixels[i] = BG_R;
      pixels[i + 1] = BG_G;
      pixels[i + 2] = BG_B;
      pixels[i + 3] = 255;
    }
  }
  // Vertical bars
  for (let y = margin; y < size - margin; y++) {
    for (let dx = 0; dx < thickness; dx++) {
      setWhite(pixels, size, leftBarX + dx, y);
      setWhite(pixels, size, rightBarX + dx, y);
    }
  }
  // Diagonal from top-right of left bar to bottom-left of right bar
  const diagSteps = size - margin * 2;
  for (let s = 0; s < diagSteps; s++) {
    const t = s / (diagSteps - 1);
    const cx = Math.round(leftBarX + thickness + t * (rightBarX - leftBarX - thickness));
    const cy = Math.round(margin + t * (size - margin * 2 - 1));
    for (let dx = -Math.floor(thickness / 2); dx < Math.ceil(thickness / 2); dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        setWhite(pixels, size, cx + dx, cy + dy);
      }
    }
  }
  return encodePng(size, size, pixels);
}

function setWhite(pixels: Uint8Array, size: number, x: number, y: number): void {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 4;
  pixels[i] = 255;
  pixels[i + 1] = 255;
  pixels[i + 2] = 255;
  pixels[i + 3] = 255;
}
