---
name: tilesheet-sprites
description: Generate sprite tilesheets with Gemini AI and extract individual sprites using pixel-projection bounding box detection. Use when asked to generate game sprites, create sprite sheets, or extract sprites from tilesheets. Requires GEMINI_API_KEY.
---

# Tilesheet Sprite Generation & Extraction

Generate sprite tilesheets with Gemini, then extract individual sprites using pixel-projection bounding box detection. Always save tilesheets to source control so the extraction pipeline can be re-run.

## Prerequisites

```bash
if [ -z "${GEMINI_API_KEY}" ]; then
  echo "Error: GEMINI_API_KEY is not set."
  exit 1
fi
# jimp v1 required for pixel-level access
npm list jimp | grep jimp || npm install jimp
```

## Workflow Overview

1. **Design tilesheet layout** — group sprites logically (e.g. heroes 3×3, enemies 4×2)
2. **Generate tilesheets** with Gemini (one API call per sheet)
3. **Save tilesheets** to `assets/tilesheets/` in git — this is the source of truth
4. **Detect bounding boxes** using pixel-projection analysis
5. **Extract sprites** using detected coordinates
6. **Save extracted sprites** to `assets/<category>/`

## Step 1: Generate a Tilesheet

Use Gemini `gemini-2.0-flash-exp` (supports image output). Generate multiple sprites in a single call using a grid layout prompt. Specify exact coordinates in the prompt so you know where to crop.

```bash
cat << 'PYEOF' > /tmp/gen_tilesheet.py
import os, base64, json, urllib.request

API_KEY = os.environ["GEMINI_API_KEY"]
URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key={API_KEY}"

# Example: heroes tilesheet — 3 cols (warrior, mage, rogue) × 3 rows (idle, attack, hurt)
PROMPT = """Create a pixel art sprite tilesheet. 3 columns × 3 rows, each cell exactly 128×128 pixels.
White or transparent background between sprites. No borders or grid lines.

Row 1 (idle poses): warrior cat with sword, mage cat with staff, rogue cat with daggers
Row 2 (attack poses): same characters mid-attack animation
Row 3 (hurt poses): same characters reacting to damage

Pixel art style, 16-bit era, vibrant colors. Each sprite centered in its 128×128 cell."""

payload = {
    "contents": [{"parts": [{"text": PROMPT}]}],
    "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]}
}

req = urllib.request.Request(URL,
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"})
resp = json.loads(urllib.request.urlopen(req).read())

for part in resp["candidates"][0]["content"]["parts"]:
    if "inlineData" in part:
        img_data = base64.b64decode(part["inlineData"]["data"])
        with open("/tmp/heroes.png", "wb") as f:
            f.write(img_data)
        print("Saved heroes.png")
        break
PYEOF
python3 /tmp/gen_tilesheet.py
```

**Batch strategy:** Generate all tilesheets in parallel (one python script per sheet) to save time. Each script writes to a different output file.

## Step 2: Save Tilesheets to Git

```bash
mkdir -p assets/tilesheets
cp /tmp/heroes.png assets/tilesheets/
cp /tmp/enemies.png assets/tilesheets/
# etc.
git add assets/tilesheets/
git commit -m "Add source tilesheets for sprite extraction"
```

## Step 3: Detect Bounding Boxes

Tilesheets from Gemini have **uneven spacing** between sprites. Use pixel-projection analysis to find the actual bounding boxes rather than assuming uniform grids.

Save this as `scripts/detect_sprites.cjs`:

```javascript
#!/usr/bin/env node
// Analyzes tilesheets and outputs pixel-exact bounding boxes for each sprite cell.
// Run: node scripts/detect_sprites.cjs
//
// Uses row/column projection:
//   1. Detect background color from image corners
//   2. For each row/col, count non-background pixels
//   3. Find contiguous bands of content (>= MIN_BAND_PX pixels, >= FILL_RATIO content)
//   4. Print bounding boxes — copy output into extract_sprites.cjs

const { Jimp } = require('jimp');
const path = require('path');
const fs = require('fs');

const ASSETS = path.resolve(__dirname, '..', 'assets');
const MIN_BAND_PX = 80;   // min band size to count as content (filters grid lines)
const FILL_RATIO = 0.04;  // min fraction of row/col that must be non-background

const TILESHEETS = [
  `${ASSETS}/tilesheets/heroes.png`,
  `${ASSETS}/tilesheets/enemies.png`,
  `${ASSETS}/tilesheets/mapnodes.png`,
  `${ASSETS}/tilesheets/ui.png`,
];

function sampleBackground(img, W, H) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const [cx, cy] of [[2,2],[W-3,2],[2,H-3],[W-3,H-3]]) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const hex = img.getPixelColor(cx+dx, cy+dy);
        r += (hex >>> 24) & 0xff;
        g += (hex >>> 16) & 0xff;
        b += (hex >>> 8) & 0xff;
        n++;
      }
    }
  }
  return { r: r/n, g: g/n, b: b/n };
}

function isBackground(r, g, b, bg, thresh = 50) {
  return Math.abs(r-bg.r)<thresh && Math.abs(g-bg.g)<thresh && Math.abs(b-bg.b)<thresh;
}

function findBands(fillArr, limit, ratio, minSize) {
  const threshold = limit * ratio;
  const bands = [];
  let inFill = fillArr[0] > threshold, start = 0;
  for (let i = 1; i < fillArr.length; i++) {
    const f = fillArr[i] > threshold;
    if (f !== inFill) {
      if (inFill && (i-1-start+1) >= minSize) bands.push({ from: start, to: i-1 });
      inFill = f; start = i;
    }
  }
  if (inFill && (fillArr.length-1-start+1) >= minSize) bands.push({ from: start, to: fillArr.length-1 });
  return bands;
}

async function analyzeSheet(file) {
  if (!fs.existsSync(file)) { console.warn(`[SKIP] ${file} not found`); return; }
  const img = await Jimp.read(file);
  const W = img.bitmap.width, H = img.bitmap.height;
  const bg = sampleBackground(img, W, H);

  const rowFill = new Array(H).fill(0);
  const colFill = new Array(W).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const hex = img.getPixelColor(x, y);
      const r = (hex >>> 24) & 0xff, g = (hex >>> 16) & 0xff, b = (hex >>> 8) & 0xff;
      if (!isBackground(r, g, b, bg)) { rowFill[y]++; colFill[x]++; }
    }
  }

  const rowBands = findBands(rowFill, W, FILL_RATIO, MIN_BAND_PX);
  const colBands = findBands(colFill, H, FILL_RATIO, MIN_BAND_PX);

  console.log(`\n=== ${path.basename(file)} (${W}×${H}) ===`);
  console.log(`  bg ~ rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`);
  console.log(`  Grid: ${rowBands.length} rows × ${colBands.length} cols`);
  console.log('  Bounding boxes (copy into extract_sprites.cjs):');
  for (let r = 0; r < rowBands.length; r++) {
    for (let c = 0; c < colBands.length; c++) {
      const x=colBands[c].from, y=rowBands[r].from;
      const w=colBands[c].to-x+1, h=rowBands[r].to-y+1;
      console.log(`    { out: 'sprite.png', x: ${x}, y: ${y}, w: ${w}, h: ${h} },  // [${r}][${c}]`);
    }
  }
}

async function main() {
  for (const f of TILESHEETS) await analyzeSheet(f);
}
main().catch(err => { console.error(err); process.exit(1); });
```

Run it:
```bash
node scripts/detect_sprites.cjs
```

## Step 4: Extract Sprites

Copy the detected bounding boxes into `scripts/extract_sprites.cjs`. Map each cell to its output filename:

```javascript
#!/usr/bin/env node
const { Jimp } = require('jimp');
const path = require('path');
const fs = require('fs');

const ASSETS = path.resolve(__dirname, '..', 'assets');

// Paste detect_sprites.cjs output here, replacing 'sprite.png' with actual filenames
const EXTRACTIONS = {
  [`${ASSETS}/tilesheets/heroes.png`]: [
    { out: `${ASSETS}/heroes/warrior_idle.png`,   x: 12, y: 8, w: 118, h: 124 },
    { out: `${ASSETS}/heroes/mage_idle.png`,      x: 148, y: 8, w: 112, h: 124 },
    // ... etc
  ],
  [`${ASSETS}/tilesheets/enemies.png`]: [
    // ...
  ],
};

async function main() {
  for (const [sheet, cells] of Object.entries(EXTRACTIONS)) {
    if (!fs.existsSync(sheet)) { console.warn(`[SKIP] ${sheet}`); continue; }
    const img = await Jimp.read(sheet);
    for (const { out, x, y, w, h } of cells) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const cropped = img.clone().crop({ x, y, w, h });
      await cropped.write(out);
      console.log(`  ✓ ${path.basename(out)}`);
    }
  }
}
main().catch(err => { console.error(err); process.exit(1); });
```

Run it:
```bash
node scripts/extract_sprites.cjs
```

## Troubleshooting

**Too few/many bands detected:**
- Increase `MIN_BAND_PX` if background noise creates false bands
- Decrease `FILL_RATIO` if sparse sprites are not detected
- Adjust `thresh` in `isBackground()` if the background color varies (e.g. light grey vs white)

**`.cjs` extension required:** jimp v1 uses ESM internally. If you get `require is not defined`, rename to `.cjs` — never use `.js` for jimp scripts in projects without `"type": "module"`.

**White border slivers:** Expand the bounding box by 1-2px or reduce `thresh` slightly to capture the full sprite edge.

**Sprites bleed into each other:** Increase `FILL_RATIO` threshold to require denser content before detecting a band boundary.

## Prompt Tips for Gemini

- Specify cell size explicitly: `"each cell exactly 128×128 pixels"`
- Ask for white/transparent background between sprites — this is what the projection algorithm needs
- Request consistent lighting and style within a tilesheet
- For animations: label rows/cols clearly in the prompt (e.g. `"Row 1: idle, Row 2: attack, Row 3: hurt"`)
- Generate many sprites per call — Gemini handles 3×3 and 4×2 grids well
