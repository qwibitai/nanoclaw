---
name: make-website
description: Build and publish a website. Use whenever the user asks to make, create, build, or publish a website, landing page, dashboard, status page, one-pager, or anything else a human will load in a browser. Covers both the publish recipe (no tunnels, no third-party hosts) and the design discipline that keeps the result from looking like generic AI slop.
---

# make-website

Two parts to this skill: **how to publish** (one path, no tunnels) and **how to design** (avoid the AI-slop default look).

## Publish recipe

Read `groupName` from `/workspace/agent/container.json` once and cache it (e.g. `telegram_main`). Then:

1. Pick a short, lowercase, hyphenated `<sitename>` (e.g. `kitehill-photos`, `gc-invite`).
2. **Write every file first** — `index.html` plus any CSS, JS, and image assets — into `/var/www/sites/<groupName>/<sitename>/`. Verify with `ls`.
3. **Verify the URL responds with content** before sending it: `curl -s -o /dev/null -w '%{http_code} %{size_download}\n' http://45.55.64.148/<groupName>/<sitename>/`. Expect `200` and a non-zero size. If it's `404` or `0`, your files aren't where you think they are.
4. **Only after verification, send the URL** to the user.

Order matters. Sending the URL before files are on disk gives the user a blank page. Sending it before assets are written gives them broken images. Do not send the URL optimistically.

The host runs Caddy on port 80 serving `/var/www/sites/` directly. No deploy, no restart, no DNS — once the file is on disk, the URL is live.

Other groups (and class members, when applicable) own sibling subdirs at the same level. Don't write outside your own `<groupName>/` folder.

## Do NOT do these

- Don't run `cloudflared`, `ngrok`, `localtunnel`, `serveo`, `pinggy`, or any other tunnel — not directly, not via `npx`, not via `npm exec`. The local Caddy already exposes the site publicly.
- Don't spin up your own HTTP server (`node server.js`, `python -m http.server`, `npx serve`, etc.). Caddy is already serving.
- Don't deploy to Cloudflare Pages, Vercel, Netlify, GitHub Pages, or anywhere else for a normal "make me a site" request. The user wants a URL fast; the local path delivers in one file write.
- Don't send any URL that isn't `http://45.55.64.148/...`. If you're about to send something else, you've gone wrong — stop and rewrite under `/var/www/sites/`.

(If the user *explicitly* asks for Vercel/Netlify/Cloudflare, that's a different task — use the relevant skill, e.g. `vercel-cli`, instead of this one.)

## Design discipline

A website is the user's first and only interaction with what you built. Generic-looking AI output is a tax on their attention. Pick a clear aesthetic direction and execute it precisely.

### Before you write any HTML

- **Purpose**: what does this site do, and for whom?
- **Tone**: pick one direction and commit. Examples: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian. There's no "default" — pick.
- **One memorable thing**: what's the single detail someone will remember? Aim for that.

### What to do

- **Typography**: pair a distinctive display font with a refined body font. Use Google Fonts or system fonts. Make a deliberate choice that matches the tone.
- **Color**: dominant color + sharp accents. Use CSS variables for consistency. Cohesive palette, not evenly-distributed pastels.
- **Motion**: one well-orchestrated page load (staggered reveals via `animation-delay`) or one strong scroll/hover interaction beats scattered micro-animations. CSS-only is fine for HTML; reach for JS only when CSS can't do it.
- **Layout**: asymmetry, overlap, grid-breaks, deliberate negative space. Generic three-column-card layouts are a tell.
- **Backgrounds & detail**: gradient meshes, noise textures, geometric patterns, dramatic shadows, decorative borders. Atmosphere, not flat fills.

### What NOT to do (the AI-slop tells)

- **Inter / Roboto / Arial / generic system fonts** as the only typeface.
- **Purple gradient on white** (or any "AI startup" gradient cliché).
- **Centered hero + three feature cards + "Get started" button** template.
- **All rounded corners at the same radius** with no contrast.
- Picking the same fonts/colors you'd pick for any other site. Vary on purpose.

Match implementation effort to the aesthetic. Maximalist needs elaborate code and animations. Minimalist needs precision in spacing, line-height, and rhythm. Either works — half-committing to either doesn't.

### Verifying it actually looks right

Before declaring done, open the live URL in a real browser via the agent-browser skill (or ask the user to load it). A site that "should work based on the HTML" but you haven't actually seen rendered isn't done.

---

Design guidance adapted from Anthropic's `frontend-design` skill (Apache 2.0): https://github.com/anthropics/skills
