---
name: render-diagram
description: Render polished diagrams and visuals as PNG images using Mermaid, HTML, or SVG via the render_diagram tool. Use instead of ASCII art when a professional visual would be more effective.
---

# Rendering Diagrams

You have the `render_diagram` tool. It renders Mermaid diagrams, HTML pages, or SVG graphics as PNG images and sends them directly to chat.

## When to use

- Architecture diagrams, flowcharts, sequence diagrams, org charts, timelines
- KPI dashboards, status reports, comparison matrices, project roadmaps
- Any visual where layout, color, or relationships matter more than raw text

## When NOT to use

- Simple lists or hierarchies that read fine as text
- Quick inline sketches where ASCII is clearer (e.g. `A -> B -> C`)
- Data charts with real datasets (bar, line, scatter) — use Python with plotly/matplotlib and `send_file`

## IMPORTANT: Always use `type: "html"`

**You MUST use `type: "html"` for render_diagram calls.** Do NOT use `type: "mermaid"`. The HTML templates below produce far superior visuals — Mermaid produces basic, unstyled diagrams that look unprofessional.

The ONLY exceptions where Mermaid is acceptable:
- The user explicitly says "quick", "simple", or "mermaid"
- Sequence diagrams or Gantt charts (Mermaid handles these well)

For everything else — architecture, flowcharts, dashboards, timelines, comparisons, org charts — use `type: "html"` and adapt the matching template below:

| Request | Template to adapt |
|---------|-------------------|
| Architecture, system design, infrastructure | Architecture (mesh gradient) |
| Metrics, KPIs, status report, weekly update | KPI Dashboard |
| Vendor eval, pros/cons, option comparison | Comparison Matrix |
| Roadmap, milestones, project phases | Project Roadmap (timeline) |
| Services, microservices, platform overview | Glassmorphism Cards |
| Pipeline, workflow, approval process, steps | Process Flow (vertical) |
| Launch, release notes, feature announcement | Feature Announcement |
| Team structure, org chart, hierarchy | Org Chart |

---

## Design principles

Follow these when building HTML visuals. Based on established information design practice.

**Typography hierarchy** — use 2-3 typefaces max. Size guide: titles 28-36px bold, section headers 18-22px semibold, body 13-15px, labels/captions 11-12px. Use `-apple-system, 'Segoe UI', system-ui, sans-serif` for clean cross-platform rendering.

**Color discipline** — limit to 4-5 colors plus a neutral. Assign each color a role: one primary accent, one or two secondary, one for backgrounds, one for borders/muted text. Maintain color meaning consistently throughout.

**White space** — generous padding between sections (32-48px), breathing room inside cards (20-28px), and clear margins. Resist filling every pixel.

**Visual hierarchy** — the most important element should be the largest and most prominent. Supporting info should be visually subordinate. Guide attention through size, weight, color, and position — not by making everything bold.

**Data-ink ratio** — every visual element should serve communication. Skip decorative 3D effects, gratuitous gradients, and chartjunk. Design serves content, not the reverse.

---

## Mermaid — quick structural diagrams

Good for getting a diagram out fast with minimal code.

```
render_diagram(type: "mermaid", title: "architecture", content: `
graph TD
    A[Client] -->|REST| B[API Gateway]
    B --> C[Auth Service]
    B --> D[Order Service]
    D --> E[(PostgreSQL)]
    D --> F[(Redis Cache)]
`, theme: "default")
```

```
render_diagram(type: "mermaid", title: "auth-flow", content: `
sequenceDiagram
    participant U as User
    participant A as API
    participant DB as Database
    U->>A: POST /login
    A->>DB: Verify credentials
    DB-->>A: User record
    A-->>U: JWT token
`, theme: "neutral")
```

**Themes**: `default` (blue/gray), `dark`, `forest` (green), `neutral` (minimal)

---

## HTML templates by use case

### KPI Dashboard — metrics with context

Stat cards with comparison indicators. Good for status reports, weekly updates, business reviews.

```
render_diagram(type: "html", title: "metrics", width: 1200, height: 400, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; background: #ffffff; color: #18181b; padding: 40px; }
  h1 { font-size: 20px; font-weight: 600; color: #71717a; margin-bottom: 24px; letter-spacing: -0.01em; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .card .label { font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .card .value { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 6px; }
  .card .delta { font-size: 13px; }
  .up { color: #4ade80; }
  .down { color: #f87171; }
  .neutral { color: #71717a; }
</style></head>
<body>
  <h1>Weekly Performance — Mar 31, 2026</h1>
  <div class="grid">
    <div class="card"><div class="label">Revenue</div><div class="value">$142K</div><div class="delta up">+12.3% vs last week</div></div>
    <div class="card"><div class="label">Active Users</div><div class="value">8,421</div><div class="delta up">+340 new</div></div>
    <div class="card"><div class="label">Conversion</div><div class="value">3.2%</div><div class="delta down">-0.4pp from target</div></div>
    <div class="card"><div class="label">P95 Latency</div><div class="value">142ms</div><div class="delta up">-18ms improved</div></div>
  </div>
</body></html>
`)
```

### Architecture — clean layout with mesh gradient

Uses layered radial gradients at low opacity on a light base. Nodes with subtle shadows and borders.

```
render_diagram(type: "html", title: "architecture", width: 1400, height: 900, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    color: #1e293b;
    padding: 48px;
    background: #f8fafc;
    background-image:
      radial-gradient(at 0% 0%, hsla(214, 60%, 80%, 0.3) 0px, transparent 50%),
      radial-gradient(at 80% 100%, hsla(260, 40%, 85%, 0.25) 0px, transparent 50%);
  }
  h1 { font-size: 28px; font-weight: 700; margin-bottom: 6px; letter-spacing: -0.02em; }
  .sub { font-size: 13px; color: #64748b; margin-bottom: 40px; }
  .flow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center; }
  .node { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 22px 28px; min-width: 150px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .node.accent { border-color: rgba(37, 99, 235, 0.4); box-shadow: 0 1px 8px rgba(37, 99, 235, 0.1); }
  .node h3 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .node.accent h3 { color: #2563eb; }
  .node p { font-size: 12px; color: #64748b; }
  .arrow { color: #d4d4d8; font-size: 18px; }
  .tier { display: flex; gap: 16px; margin-top: 32px; justify-content: center; }
  .tier .node { flex: 1; max-width: 200px; }
  .section { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin: 32px 0 12px; text-align: center; }
</style></head>
<body>
  <h1>System Architecture</h1>
  <p class="sub">Production topology — multi-region deployment</p>
  <div class="flow">
    <div class="node"><h3>CDN</h3><p>Edge cache</p></div>
    <span class="arrow">&rarr;</span>
    <div class="node accent"><h3>Load Balancer</h3><p>TLS termination</p></div>
    <span class="arrow">&rarr;</span>
    <div class="node accent"><h3>API Gateway</h3><p>Auth &middot; Rate limit</p></div>
    <span class="arrow">&rarr;</span>
    <div class="node"><h3>Service Mesh</h3><p>gRPC routing</p></div>
  </div>
  <div class="section">Services</div>
  <div class="tier">
    <div class="node"><h3>Users</h3><p>Auth &middot; Profiles</p></div>
    <div class="node"><h3>Orders</h3><p>Checkout &middot; Payment</p></div>
    <div class="node"><h3>Catalog</h3><p>Search &middot; Inventory</p></div>
    <div class="node"><h3>Notifications</h3><p>Email &middot; Push</p></div>
  </div>
  <div class="section">Data</div>
  <div class="tier">
    <div class="node accent"><h3>PostgreSQL</h3><p>Primary store</p></div>
    <div class="node"><h3>Redis</h3><p>Cache &middot; Sessions</p></div>
    <div class="node"><h3>S3</h3><p>Objects &middot; Backups</p></div>
  </div>
</body></html>
`)
```

### Comparison Matrix — evaluation with clear recommendation

Professional decision-support visual. Color-coded status indicators, recommended option highlighted.

```
render_diagram(type: "html", title: "comparison", width: 1200, height: 600, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; background: #fafafa; color: #18181b; padding: 40px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; letter-spacing: -0.01em; }
  .sub { font-size: 13px; color: #52525b; margin-bottom: 24px; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; }
  th { font-size: 13px; font-weight: 600; padding: 14px 20px; text-align: left; background: #ffffff; border-bottom: 1px solid #e2e8f0; color: #71717a; }
  th.pick { color: #2563eb; }
  td { padding: 13px 20px; font-size: 14px; border-bottom: 1px solid rgba(226,232,240,0.7); }
  tr:last-child td { border-bottom: none; }
  .feat { color: #71717a; font-weight: 500; }
  .y { color: #4ade80; } .n { color: #52525b; } .m { color: #facc15; }
  .badge { font-size: 10px; padding: 2px 8px; border-radius: 99px; background: rgba(37,99,235,0.1); color: #2563eb; margin-left: 6px; vertical-align: middle; font-weight: 600; }
  .rec { background: rgba(37,99,235,0.03); }
</style></head>
<body>
  <h1>Vendor Evaluation</h1>
  <p class="sub">Scored against production requirements — April 2026</p>
  <table>
    <tr><th class="feat">Criteria</th><th class="pick">Vendor A<span class="badge">Pick</span></th><th>Vendor B</th><th>Vendor C</th></tr>
    <tr class="rec"><td class="feat">Auto-scaling</td><td class="y">Built-in</td><td class="m">Manual config</td><td class="y">Built-in</td></tr>
    <tr><td class="feat">Cold start</td><td class="y">&lt; 100ms</td><td class="n">2-5s</td><td class="m">~500ms</td></tr>
    <tr class="rec"><td class="feat">Multi-region</td><td class="y">12 regions</td><td class="y">6 regions</td><td class="n">Single only</td></tr>
    <tr><td class="feat">Observability</td><td class="y">Native OTel</td><td class="m">Third-party</td><td class="m">Basic logs</td></tr>
    <tr class="rec"><td class="feat">Monthly cost</td><td class="y">$2.4K</td><td class="m">$4.1K</td><td class="y">$1.8K</td></tr>
    <tr><td class="feat">Team readiness</td><td class="y">High</td><td class="m">Medium</td><td class="n">Low</td></tr>
  </table>
</body></html>
`)
```

### Project Roadmap — horizontal timeline with milestones

Phase indicators with status (done/active/pending). Clean connector line using CSS gradient.

```
render_diagram(type: "html", title: "roadmap", width: 1200, height: 420, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; background: #ffffff; color: #18181b; padding: 48px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 36px; letter-spacing: -0.01em; }
  .timeline { position: relative; display: flex; justify-content: space-between; padding: 0 20px; }
  .timeline::before { content: ''; position: absolute; top: 20px; left: 50px; right: 50px; height: 2px; background: linear-gradient(90deg, #3b82f6, #8b5cf6, #e2e8f0 70%); }
  .step { position: relative; text-align: center; flex: 1; }
  .dot { width: 40px; height: 40px; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; position: relative; z-index: 1; }
  .done { background: #3b82f6; color: white; }
  .active { background: #8b5cf6; color: white; box-shadow: 0 0 20px rgba(139,92,246,0.4); }
  .pending { background: #f4f4f5; border: 2px solid #d4d4d8; color: #a1a1aa; }
  .label { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .desc { font-size: 12px; color: #52525b; max-width: 130px; margin: 0 auto; line-height: 1.4; }
  .date { font-size: 11px; color: #a1a1aa; margin-top: 8px; font-variant-numeric: tabular-nums; }
</style></head>
<body>
  <h1>Product Roadmap</h1>
  <div class="timeline">
    <div class="step"><div class="dot done">1</div><div class="label">Research</div><div class="desc">User interviews and competitive analysis</div><div class="date">Jan 2026</div></div>
    <div class="step"><div class="dot done">2</div><div class="label">Design</div><div class="desc">Wireframes, prototypes, design system</div><div class="date">Feb 2026</div></div>
    <div class="step"><div class="dot active">3</div><div class="label">Build</div><div class="desc">Core features and API integration</div><div class="date">Mar 2026</div></div>
    <div class="step"><div class="dot pending">4</div><div class="label">Beta</div><div class="desc">Private beta with select partners</div><div class="date">Apr 2026</div></div>
    <div class="step"><div class="dot pending">5</div><div class="label">Launch</div><div class="desc">GA release and marketing push</div><div class="date">May 2026</div></div>
  </div>
</body></html>
`)
```

### Glassmorphism Cards — frosted-glass service overview

Uses `backdrop-filter: blur()` with `saturate()` — the technique from Apple's Liquid Glass and macOS. Requires a colorful background behind the cards to show the blur effect.

```
render_diagram(type: "html", title: "services", width: 1400, height: 800, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    color: #1e293b;
    padding: 48px;
    min-height: 100vh;
    background: #f0f0ff;
    background-image:
      radial-gradient(at 20% 30%, hsla(260, 80%, 85%, 0.5) 0px, transparent 50%),
      radial-gradient(at 80% 70%, hsla(200, 80%, 85%, 0.4) 0px, transparent 50%),
      radial-gradient(at 50% 90%, hsla(330, 60%, 90%, 0.3) 0px, transparent 50%);
  }
  h1 { font-size: 26px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.02em; }
  .sub { font-size: 13px; color: rgba(0,0,0,0.4); margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .glass {
    background: rgba(255,255,255,0.7);
    backdrop-filter: blur(12px) saturate(180%);
    -webkit-backdrop-filter: blur(12px) saturate(180%);
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 16px;
    padding: 28px;
  }
  .glass .icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; margin-bottom: 16px; color: white; }
  .glass h3 { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  .glass p { font-size: 13px; line-height: 1.6; color: rgba(0,0,0,0.5); }
  .glass .tag { display: inline-block; font-size: 11px; padding: 3px 10px; border-radius: 99px; background: rgba(0,0,0,0.05); color: rgba(0,0,0,0.45); margin-top: 14px; }
  .i1 { background: linear-gradient(135deg, #3b82f6, #1d4ed8); }
  .i2 { background: linear-gradient(135deg, #8b5cf6, #6d28d9); }
  .i3 { background: linear-gradient(135deg, #06b6d4, #0e7490); }
  .i4 { background: linear-gradient(135deg, #f59e0b, #b45309); }
  .i5 { background: linear-gradient(135deg, #10b981, #047857); }
  .i6 { background: linear-gradient(135deg, #ef4444, #b91c1c); }
  .divider { grid-column: 1 / -1; text-align: center; color: rgba(0,0,0,0.15); font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase; padding: 4px 0; }
</style></head>
<body>
  <h1>Platform Services</h1>
  <p class="sub">Microservices topology — 6 services, 3 data stores</p>
  <div class="grid">
    <div class="glass"><div class="icon i1">A</div><h3>API Gateway</h3><p>Rate limiting, auth verification, request routing. Handles 50K req/s peak.</p><span class="tag">Kong + Lua</span></div>
    <div class="glass"><div class="icon i2">S</div><h3>Auth Service</h3><p>OAuth 2.0 with PKCE, JWT issuance, session lifecycle management.</p><span class="tag">Node.js</span></div>
    <div class="glass"><div class="icon i3">O</div><h3>Order Engine</h3><p>Order lifecycle, inventory reservation, payment orchestration.</p><span class="tag">Go</span></div>
    <div class="divider">&middot; &middot; &middot; event bus &middot; &middot; &middot;</div>
    <div class="glass"><div class="icon i4">A</div><h3>Analytics</h3><p>Real-time metrics pipeline, funnel analysis, cohort tracking.</p><span class="tag">Python + Kafka</span></div>
    <div class="glass"><div class="icon i5">N</div><h3>Notifications</h3><p>Email, push, and SMS delivery with template rendering.</p><span class="tag">Rust</span></div>
    <div class="glass"><div class="icon i6">M</div><h3>Monitoring</h3><p>Health checks, distributed tracing, alerting with PagerDuty.</p><span class="tag">Grafana stack</span></div>
  </div>
</body></html>
`)
```

### Process Flow — vertical steps with status

Clean vertical flow with step numbers, descriptions, and owner/status badges. Good for onboarding flows, deployment pipelines, approval workflows.

```
render_diagram(type: "html", title: "process", width: 800, height: 800, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; background: #fafafa; color: #18181b; padding: 40px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 28px; }
  .steps { position: relative; padding-left: 40px; }
  .steps::before { content: ''; position: absolute; left: 15px; top: 0; bottom: 0; width: 2px; background: #e2e8f0; }
  .step { position: relative; margin-bottom: 28px; }
  .step:last-child { margin-bottom: 0; }
  .step .num { position: absolute; left: -40px; top: 0; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; z-index: 1; }
  .num.done { background: #3b82f6; color: white; }
  .num.active { background: #8b5cf6; color: white; box-shadow: 0 0 12px rgba(139,92,246,0.3); }
  .num.pending { background: #f4f4f5; color: #a1a1aa; border: 2px solid #d4d4d8; }
  .step .content { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .step .title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .step .desc { font-size: 13px; color: #71717a; line-height: 1.5; }
  .step .meta { display: flex; gap: 8px; margin-top: 10px; }
  .pill { font-size: 11px; padding: 2px 10px; border-radius: 99px; }
  .pill.owner { background: rgba(139,92,246,0.1); color: #a78bfa; }
  .pill.status { background: rgba(74,222,128,0.1); color: #4ade80; }
  .pill.wait { background: rgba(250,204,21,0.1); color: #facc15; }
</style></head>
<body>
  <h1>Deployment Pipeline</h1>
  <div class="steps">
    <div class="step"><div class="num done">1</div><div class="content"><div class="title">Code Review</div><div class="desc">PR approved by 2 reviewers, all checks passing.</div><div class="meta"><span class="pill owner">@eng-team</span><span class="pill status">Complete</span></div></div></div>
    <div class="step"><div class="num done">2</div><div class="content"><div class="title">Build &amp; Test</div><div class="desc">CI pipeline: lint, unit tests, integration tests, Docker image built and pushed.</div><div class="meta"><span class="pill owner">CI/CD</span><span class="pill status">Complete</span></div></div></div>
    <div class="step"><div class="num active">3</div><div class="content"><div class="title">Staging Deploy</div><div class="desc">Deployed to staging environment. Running smoke tests and load testing.</div><div class="meta"><span class="pill owner">@platform</span><span class="pill wait">In progress</span></div></div></div>
    <div class="step"><div class="num pending">4</div><div class="content"><div class="title">QA Sign-off</div><div class="desc">Manual testing of critical user flows and edge cases.</div><div class="meta"><span class="pill owner">@qa-team</span></div></div></div>
    <div class="step"><div class="num pending">5</div><div class="content"><div class="title">Production Release</div><div class="desc">Canary deployment at 5%, promote to 100% after 30m if error rate holds.</div><div class="meta"><span class="pill owner">@sre</span></div></div></div>
  </div>
</body></html>
`)
```

### Feature Announcement — marketing-style visual

Bold gradient headline, benefit cards. Good for changelogs, release notes, product updates.

```
render_diagram(type: "html", title: "announcement", width: 1200, height: 700, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    background: #ffffff;
    color: #18181b;
    padding: 56px 48px;
    background-image:
      radial-gradient(at 50% 0%, hsla(250, 80%, 90%, 0.3) 0px, transparent 60%);
  }
  .eyebrow { font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; color: #8b5cf6; font-weight: 600; margin-bottom: 12px; }
  h1 { font-size: 36px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.15; margin-bottom: 12px; background: linear-gradient(135deg, #18181b 0%, #52525b 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .lead { font-size: 16px; color: #71717a; line-height: 1.6; max-width: 560px; margin-bottom: 40px; }
  .benefits { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .benefit { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .benefit .num { font-size: 28px; font-weight: 800; margin-bottom: 8px; background: linear-gradient(135deg, #8b5cf6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .benefit h3 { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .benefit p { font-size: 13px; color: #71717a; line-height: 1.5; }
</style></head>
<body>
  <div class="eyebrow">Now Available</div>
  <h1>Instant Edge Deployments</h1>
  <p class="lead">Deploy to 12 global regions in under 30 seconds. Zero-downtime rollouts with automatic rollback on error spike.</p>
  <div class="benefits">
    <div class="benefit"><div class="num">30s</div><h3>Deploy Time</h3><p>From git push to live in production across all regions.</p></div>
    <div class="benefit"><div class="num">99.99%</div><h3>Uptime SLA</h3><p>Rolling deploys with health checks at every stage.</p></div>
    <div class="benefit"><div class="num">12</div><h3>Edge Regions</h3><p>Automatic routing to the nearest point of presence.</p></div>
  </div>
</body></html>
`)
```

### Org / Team Chart — hierarchy with roles

```
render_diagram(type: "html", title: "team", width: 1000, height: 600, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; background: #fafafa; color: #18181b; padding: 40px; display: flex; flex-direction: column; align-items: center; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 32px; }
  .row { display: flex; gap: 16px; justify-content: center; margin-bottom: 8px; position: relative; }
  .connector { width: 2px; height: 24px; background: #e2e8f0; margin: 0 auto; }
  .branch { display: flex; gap: 16px; justify-content: center; position: relative; }
  .branch::before { content: ''; position: absolute; top: -12px; left: 25%; right: 25%; height: 2px; background: #e2e8f0; }
  .person { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 24px; text-align: center; min-width: 140px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .person.lead { border-color: rgba(139,92,246,0.3); }
  .person .avatar { width: 36px; height: 36px; border-radius: 50%; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: white; }
  .a1 { background: linear-gradient(135deg, #8b5cf6, #6d28d9); }
  .a2 { background: linear-gradient(135deg, #3b82f6, #1d4ed8); }
  .a3 { background: linear-gradient(135deg, #06b6d4, #0e7490); }
  .a4 { background: linear-gradient(135deg, #10b981, #047857); }
  .a5 { background: linear-gradient(135deg, #f59e0b, #b45309); }
  .person .name { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
  .person .role { font-size: 12px; color: #52525b; }
</style></head>
<body>
  <h1>Engineering Organization</h1>
  <div class="row"><div class="person lead"><div class="avatar a1">VP</div><div class="name">Sarah Chen</div><div class="role">VP Engineering</div></div></div>
  <div class="connector"></div>
  <div class="branch">
    <div class="person"><div class="avatar a2">BE</div><div class="name">Alex Rivera</div><div class="role">Backend Lead</div></div>
    <div class="person"><div class="avatar a3">FE</div><div class="name">Jordan Park</div><div class="role">Frontend Lead</div></div>
    <div class="person"><div class="avatar a4">IN</div><div class="name">Morgan Lee</div><div class="role">Infra Lead</div></div>
    <div class="person"><div class="avatar a5">DA</div><div class="name">Casey Ortiz</div><div class="role">Data Lead</div></div>
  </div>
</body></html>
`)
```

---

## SVG — precise vector graphics

For geometric diagrams where pixel-perfect control matters:

```
render_diagram(type: "svg", title: "layers", width: 800, height: 500, background: "white", content: `
<svg viewBox="0 0 400 250" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#2563eb"/></linearGradient>
    <linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#7c3aed"/></linearGradient>
    <linearGradient id="g3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#0891b2"/></linearGradient>
    <filter id="s"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.12"/></filter>
  </defs>
  <rect x="60" y="15" width="280" height="54" rx="12" fill="url(#g1)" filter="url(#s)"/>
  <text x="200" y="48" text-anchor="middle" fill="white" font-family="system-ui" font-size="15" font-weight="600">Presentation</text>
  <rect x="60" y="95" width="280" height="54" rx="12" fill="url(#g2)" filter="url(#s)"/>
  <text x="200" y="128" text-anchor="middle" fill="white" font-family="system-ui" font-size="15" font-weight="600">Business Logic</text>
  <rect x="60" y="175" width="280" height="54" rx="12" fill="url(#g3)" filter="url(#s)"/>
  <text x="200" y="208" text-anchor="middle" fill="white" font-family="system-ui" font-size="15" font-weight="600">Data Access</text>
  <line x1="200" y1="69" x2="200" y2="95" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4"/>
  <line x1="200" y1="149" x2="200" y2="175" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4"/>
</svg>
`)
```

---

## Design tips

- **Match complexity to request** — quick question gets Mermaid; presentation-quality gets polished HTML
- **Light backgrounds with subtle borders and shadows** produce clean, professional visuals — use `#ffffff` (white), `#fafafa` (zinc-50), or `#f8fafc` (slate-50) as base
- **Mesh gradient backgrounds** — layer 2-3 `radial-gradient()` calls with `hsla()` colors at 0.2-0.4 opacity on a light base for depth without distraction
- **Glassmorphism** — requires `backdrop-filter: blur(12px) saturate(180%)` with `-webkit-` prefix, a translucent `rgba(255,255,255,0.7)` background, and a colorful element behind the glass to be visible
- **Sizing** — set `width` and `height` to match content. Common sizes: dashboards 1200x600, architecture 1400x900, timelines 1200x420
- **Color palette** — stick to 2-3 accent colors. Good combos: blue (#2563eb) + purple (#8b5cf6), cyan (#06b6d4) + green (#10b981)
- **Keep it focused** — 5-10 elements communicates better than 30. Tufte's principle: maximize data-ink ratio, minimize chartjunk
