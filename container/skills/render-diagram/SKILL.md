---
name: render-diagram
description: Render polished diagrams and visuals as PNG images using Mermaid, HTML, or SVG via the render_diagram tool. Use instead of ASCII art when a professional visual would be more effective.
allowed-tools: render_diagram
---

# Rendering Diagrams

You have the `render_diagram` tool. It renders Mermaid diagrams, HTML pages, or SVG graphics as PNG images and sends them directly to chat.

## When to use

- Architecture diagrams, flowcharts, sequence diagrams, org charts, timelines
- Any visual where layout, color, or relationships matter more than raw text
- When the user asks for a diagram, chart, or visual

## When NOT to use

- Simple lists or hierarchies that read fine as text
- Quick inline sketches where ASCII is clearer (e.g. `A -> B -> C`)
- Data charts (bar, line, scatter) — use Python with plotly/matplotlib and `send_file` instead

## Choosing the right format

| Format | Best for | Limitations |
|--------|----------|-------------|
| `mermaid` | Quick flowcharts, sequence diagrams, ERDs, Gantt charts | Limited styling, fixed themes |
| `html` | Full creative control — dashboards, polished layouts, custom visuals | More verbose, requires CSS knowledge |
| `svg` | Precise vector graphics, icons, geometric art | No interactivity in output |

**Default to Mermaid** for quick structural diagrams. **Use HTML** when the user wants something polished, branded, or visually impressive.

---

## Mermaid — quick structural diagrams

Good for getting a diagram out fast. Limited styling but clear communication.

Architecture:
```
render_diagram(type: "mermaid", title: "architecture", content: `
graph TD
    A[Client] -->|REST| B[API Gateway]
    B --> C[Auth Service]
    B --> D[Order Service]
    D --> E[(PostgreSQL)]
    D --> F[(Redis Cache)]
    C --> G[OAuth Provider]
`, theme: "default")
```

Sequence:
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

**Mermaid themes**: `default` (blue/gray), `dark` (dark background), `forest` (green), `neutral` (minimal)

---

## HTML — full creative control

Use HTML when visuals matter. Match the complexity to the request: basic for quick info, polished for presentations and impressive outputs.

### Basic — clean and functional

Simple card layout, good for quick overviews:
```
render_diagram(type: "html", title: "overview", width: 1200, height: 600, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 40px; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .card { background: #1e293b; border-radius: 10px; padding: 20px; border: 1px solid #334155; }
  .card h3 { color: #38bdf8; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .card p { font-size: 14px; line-height: 1.5; color: #94a3b8; }
</style></head>
<body>
  <h1>System Overview</h1>
  <div class="grid">
    <div class="card"><h3>Frontend</h3><p>React SPA with TypeScript</p></div>
    <div class="card"><h3>API</h3><p>Node.js + Express</p></div>
    <div class="card"><h3>Database</h3><p>PostgreSQL + Redis</p></div>
  </div>
</body></html>
`)
```

### Polished — gradient accents, shadows, depth

Elevated design with visual hierarchy:
```
render_diagram(type: "html", title: "architecture", width: 1400, height: 900, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: 'SF Pro Display', -apple-system, system-ui, sans-serif; background: #0a0a1a; color: #e2e8f0; padding: 48px; }
  h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .subtitle { font-size: 14px; color: #64748b; margin-bottom: 36px; }
  .flow { display: flex; align-items: center; gap: 12px; margin-bottom: 32px; }
  .node { background: linear-gradient(145deg, #1e293b, #0f172a); border: 1px solid #334155; border-radius: 14px; padding: 20px 28px; box-shadow: 0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05); min-width: 160px; text-align: center; }
  .node.primary { border-color: #3b82f6; box-shadow: 0 4px 24px rgba(59,130,246,0.15), inset 0 1px 0 rgba(255,255,255,0.05); }
  .node h3 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .node.primary h3 { color: #60a5fa; }
  .node p { font-size: 12px; color: #64748b; }
  .arrow { color: #475569; font-size: 20px; }
  .details { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 16px; }
  .detail { background: rgba(30,41,59,0.5); border: 1px solid #1e293b; border-radius: 10px; padding: 16px; }
  .detail .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 4px; }
  .detail .value { font-size: 20px; font-weight: 700; color: #f8fafc; }
  .detail .sub { font-size: 12px; color: #4ade80; margin-top: 2px; }
</style></head>
<body>
  <h1>Request Pipeline</h1>
  <p class="subtitle">Production architecture — avg 45ms end-to-end</p>
  <div class="flow">
    <div class="node"><h3>Client</h3><p>React SPA</p></div>
    <span class="arrow">→</span>
    <div class="node primary"><h3>API Gateway</h3><p>Rate limit · Auth</p></div>
    <span class="arrow">→</span>
    <div class="node"><h3>Service Mesh</h3><p>gRPC routing</p></div>
    <span class="arrow">→</span>
    <div class="node primary"><h3>Workers</h3><p>Async processing</p></div>
    <span class="arrow">→</span>
    <div class="node"><h3>Storage</h3><p>Postgres · S3</p></div>
  </div>
  <div class="details">
    <div class="detail"><div class="label">Throughput</div><div class="value">12.4K</div><div class="sub">↑ 18% vs last week</div></div>
    <div class="detail"><div class="label">P99 Latency</div><div class="value">142ms</div><div class="sub">↓ 23ms improvement</div></div>
    <div class="detail"><div class="label">Error Rate</div><div class="value">0.02%</div><div class="sub">Within SLO target</div></div>
  </div>
</body></html>
`)
```

### Glassmorphism — modern frosted-glass aesthetic

Premium look with blur effects and transparency:
```
render_diagram(type: "html", title: "services", width: 1400, height: 800, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: linear-gradient(135deg, #0c0a2a 0%, #1a0a3e 40%, #0a1628 100%); color: #f0f0ff; padding: 48px; min-height: 100vh; }
  h1 { font-size: 26px; font-weight: 700; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .glass { background: rgba(255,255,255,0.06); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 28px; }
  .glass .icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px; margin-bottom: 16px; }
  .glass h3 { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  .glass p { font-size: 13px; line-height: 1.6; color: rgba(255,255,255,0.6); }
  .glass .tag { display: inline-block; font-size: 11px; padding: 3px 10px; border-radius: 99px; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.5); margin-top: 12px; }
  .i1 { background: linear-gradient(135deg, #3b82f6, #2563eb); }
  .i2 { background: linear-gradient(135deg, #8b5cf6, #7c3aed); }
  .i3 { background: linear-gradient(135deg, #06b6d4, #0891b2); }
  .i4 { background: linear-gradient(135deg, #f59e0b, #d97706); }
  .i5 { background: linear-gradient(135deg, #10b981, #059669); }
  .i6 { background: linear-gradient(135deg, #ef4444, #dc2626); }
  .connector { grid-column: 1 / -1; text-align: center; color: rgba(255,255,255,0.2); font-size: 13px; letter-spacing: 0.3em; text-transform: uppercase; padding: 8px 0; }
</style></head>
<body>
  <h1>Microservices Architecture</h1>
  <div class="grid">
    <div class="glass"><div class="icon i1">⚡</div><h3>API Gateway</h3><p>Rate limiting, auth, request routing. Handles 50K req/s.</p><span class="tag">Kong</span></div>
    <div class="glass"><div class="icon i2">🔐</div><h3>Auth Service</h3><p>OAuth 2.0 + PKCE, JWT issuance, session management.</p><span class="tag">Node.js</span></div>
    <div class="glass"><div class="icon i3">📦</div><h3>Order Service</h3><p>Order lifecycle, inventory checks, payment orchestration.</p><span class="tag">Go</span></div>
    <div class="connector">· · · · · · · · · · message bus · · · · · · · · · ·</div>
    <div class="glass"><div class="icon i4">📊</div><h3>Analytics</h3><p>Real-time metrics, user behavior tracking, funnel analysis.</p><span class="tag">Python</span></div>
    <div class="glass"><div class="icon i5">🔔</div><h3>Notifications</h3><p>Email, push, SMS delivery. Template rendering engine.</p><span class="tag">Rust</span></div>
    <div class="glass"><div class="icon i6">🛡️</div><h3>Monitoring</h3><p>Health checks, alerting, distributed tracing.</p><span class="tag">Grafana</span></div>
  </div>
</body></html>
`)
```

### Timeline — horizontal or vertical event sequences

```
render_diagram(type: "html", title: "timeline", width: 1200, height: 500, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 48px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 36px; }
  .timeline { position: relative; display: flex; justify-content: space-between; padding: 0 20px; }
  .timeline::before { content: ''; position: absolute; top: 18px; left: 40px; right: 40px; height: 2px; background: linear-gradient(90deg, #3b82f6, #8b5cf6, #06b6d4); }
  .step { position: relative; text-align: center; flex: 1; }
  .dot { width: 36px; height: 36px; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; position: relative; z-index: 1; }
  .dot.done { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; box-shadow: 0 0 20px rgba(59,130,246,0.3); }
  .dot.active { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; box-shadow: 0 0 20px rgba(139,92,246,0.4); animation: pulse 2s infinite; }
  .dot.pending { background: #1e293b; border: 2px solid #334155; color: #64748b; }
  @keyframes pulse { 0%, 100% { box-shadow: 0 0 20px rgba(139,92,246,0.4); } 50% { box-shadow: 0 0 30px rgba(139,92,246,0.6); } }
  .label { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .desc { font-size: 12px; color: #64748b; max-width: 140px; margin: 0 auto; }
  .date { font-size: 11px; color: #475569; margin-top: 8px; }
</style></head>
<body>
  <h1>Project Roadmap</h1>
  <div class="timeline">
    <div class="step"><div class="dot done">1</div><div class="label">Research</div><div class="desc">User interviews and competitive analysis</div><div class="date">Jan 2026</div></div>
    <div class="step"><div class="dot done">2</div><div class="label">Design</div><div class="desc">Wireframes, prototypes, design system</div><div class="date">Feb 2026</div></div>
    <div class="step"><div class="dot active">3</div><div class="label">Build</div><div class="desc">Core features and API development</div><div class="date">Mar 2026</div></div>
    <div class="step"><div class="dot pending">4</div><div class="label">Beta</div><div class="desc">Private beta with select users</div><div class="date">Apr 2026</div></div>
    <div class="step"><div class="dot pending">5</div><div class="label">Launch</div><div class="desc">Public release and marketing push</div><div class="date">May 2026</div></div>
  </div>
</body></html>
`)
```

### Comparison table — side-by-side evaluation

```
render_diagram(type: "html", title: "comparison", width: 1200, height: 700, content: `
<!DOCTYPE html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 48px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
  .sub { font-size: 13px; color: #64748b; margin-bottom: 28px; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; padding: 12px 20px; text-align: left; border-bottom: 1px solid #1e293b; }
  th.rec { color: #3b82f6; }
  td { padding: 14px 20px; font-size: 14px; border-bottom: 1px solid rgba(30,41,59,0.5); }
  tr:last-child td { border-bottom: none; }
  .feature { color: #94a3b8; font-weight: 500; }
  .yes { color: #4ade80; }
  .no { color: #64748b; }
  .partial { color: #fbbf24; }
  .highlight { background: rgba(59,130,246,0.05); }
  .highlight td { border-bottom-color: rgba(59,130,246,0.1); }
  .badge { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 99px; background: rgba(59,130,246,0.15); color: #60a5fa; margin-left: 8px; vertical-align: middle; }
</style></head>
<body>
  <h1>Solution Comparison</h1>
  <p class="sub">Evaluated against production requirements — Q1 2026</p>
  <table>
    <tr><th class="feature">Feature</th><th class="rec">Option A <span class="badge">Recommended</span></th><th>Option B</th><th>Option C</th></tr>
    <tr class="highlight"><td class="feature">Auto-scaling</td><td class="yes">✓ Built-in</td><td class="partial">~ Manual config</td><td class="yes">✓ Built-in</td></tr>
    <tr><td class="feature">Cold start</td><td class="yes">&lt; 100ms</td><td class="no">2-5s</td><td class="partial">500ms</td></tr>
    <tr class="highlight"><td class="feature">Multi-region</td><td class="yes">✓ 12 regions</td><td class="yes">✓ 6 regions</td><td class="no">✗ Single region</td></tr>
    <tr><td class="feature">Observability</td><td class="yes">✓ Native tracing</td><td class="partial">~ Third-party</td><td class="partial">~ Basic logs</td></tr>
    <tr class="highlight"><td class="feature">Cost at scale</td><td class="yes">$2.4K/mo</td><td class="partial">$4.1K/mo</td><td class="yes">$1.8K/mo</td></tr>
    <tr><td class="feature">Team expertise</td><td class="yes">High</td><td class="partial">Medium</td><td class="no">Low</td></tr>
  </table>
</body></html>
`)
```

---

## SVG — precise vector graphics

For geometric diagrams, icons, or custom shapes where pixel-perfect control matters:

```
render_diagram(type: "svg", title: "layers", width: 800, height: 600, background: "white", content: `
<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#2563eb"/></linearGradient>
    <linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#7c3aed"/></linearGradient>
    <linearGradient id="g3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#0891b2"/></linearGradient>
    <filter id="shadow"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.15"/></filter>
  </defs>
  <rect x="60" y="20" width="280" height="60" rx="12" fill="url(#g1)" filter="url(#shadow)"/>
  <text x="200" y="55" text-anchor="middle" fill="white" font-family="system-ui" font-size="15" font-weight="600">Presentation Layer</text>
  <rect x="60" y="110" width="280" height="60" rx="12" fill="url(#g2)" filter="url(#shadow)"/>
  <text x="200" y="145" text-anchor="middle" fill="white" font-family="system-ui" font-size="15" font-weight="600">Business Logic</text>
  <rect x="60" y="200" width="280" height="60" rx="12" fill="url(#g3)" filter="url(#shadow)"/>
  <text x="200" y="235" text-anchor="middle" fill="white" font-family="system-ui" font-size="15" font-weight="600">Data Access Layer</text>
  <line x1="200" y1="80" x2="200" y2="110" stroke="#475569" stroke-width="2" stroke-dasharray="4"/>
  <line x1="200" y1="170" x2="200" y2="200" stroke="#475569" stroke-width="2" stroke-dasharray="4"/>
</svg>
`)
```

---

## Tips

- **Match complexity to the request**: quick question → Mermaid; presentation-quality → polished HTML
- **Dark backgrounds** look best in chat — use `#0f172a` or `#0a0a1a` as a base
- **Sizing**: set `width` and `height` to match content — avoid excess whitespace
- **Keep it focused**: a clear diagram with 5-10 elements communicates better than a busy one with 30
- **Color palette**: stick to 2-3 accent colors max. Good combos: blue+purple, cyan+green, amber+rose
- **Typography**: use `-apple-system, system-ui, sans-serif` for clean cross-platform rendering
