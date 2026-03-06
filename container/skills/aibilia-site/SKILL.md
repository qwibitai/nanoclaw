---
name: aibilia-site
description: Manage and update the aibilia.com website. Use when the user asks to modify the site, add content, check status, deploy changes, or manage the aibilia.com web presence.
allowed-tools: Bash(aibilia-site:*)
---

# Aibilia.com Website Manager

Manage the aibilia.com static website served by Caddy from `/var/www/aibilia.com`.

## Site Architecture

- **Type**: Single-page static site (index.html, ~36KB)
- **Server**: Caddy HTTPS reverse proxy on Hetzner
- **Domain**: aibilia.com, www.aibilia.com
- **Design**: Dark theme (#0c0b0e), amber accent (#d4a853), Outfit + DM Serif Display fonts
- **Animations**: GSAP + ScrollTrigger
- **Language**: Italian (primary)
- **Mobile**: Responsive (1024px, 768px, 480px breakpoints)

## Site Sections

| Section | ID | Description |
|---------|-----|-------------|
| Navigation | `nav` | Fixed top nav: AIBILIA brand, links (Lavori, Servizi, Processo), CTA button |
| Hero | `hero` | Two-column: headline + stats left, chat widget right |
| Chat Widget | `hero-chat` | Interactive chat demo in hero section |
| Marquee | (no id) | Scrolling service names: Presentazioni, Siti Web, Brand Identity... |
| Portfolio | `portfolio` | Horizontal scrolling cards (5 projects) |
| Services (Bento) | `servizi` | Bento grid: 5 service cards with icons |
| Process | `processo` | 4 steps: Briefing → AI Generation → Refinement → Delivery |
| Stats | (no id) | 3 counters: Projects, Time, Satisfaction |
| CTA | (no id) | Final call-to-action with amber button |
| Footer | (no id) | Brand, email link, copyright |

## Quick Start

```bash
aibilia-site status         # Check site status
aibilia-site sections       # List all HTML sections
aibilia-site read           # Read index.html
aibilia-site test           # Run health checks
```

## Commands

```bash
aibilia-site status                  # Site status, files, backups, HTTP check
aibilia-site read [file]             # Read a site file (default: index.html)
aibilia-site sections                # List all HTML sections with IDs and line numbers
aibilia-site backup                  # Create timestamped backup (auto-cleanup keeps 20)
aibilia-site restore [backup]        # Restore from backup (latest if omitted)
aibilia-site deploy <file> [name]    # Deploy a local file to site root (auto-backup)
aibilia-site write <file> [content]  # Write content to a site file (auto-backup)
aibilia-site update <file> [source]  # Replace site file from file or stdin (auto-backup)
aibilia-site logs [n]                # Last n Caddy access log lines (default: 30)
aibilia-site test                    # Full health check (HTTP, HTTPS, SSL, load time)
aibilia-site help                    # Show help
```

## Workflow: Updating the Site

### 1. Always backup first (automatic)
All write/deploy/update commands auto-create a backup. But you can also manually:
```bash
aibilia-site backup
```

### 2. Read current content
```bash
aibilia-site read           # Full index.html
aibilia-site sections       # Quick overview of sections
```

### 3. Make changes
You have two approaches:

**A) Small edit — modify in place:**
```bash
# Read the file, make targeted edits, write back
aibilia-site read > /tmp/site-edit.html
# ... edit /tmp/site-edit.html ...
aibilia-site update index.html /tmp/site-edit.html
```

**B) Full rewrite — generate new content:**
```bash
# Write a completely new file
cat > /tmp/new-page.html << 'HTMLEOF'
<!DOCTYPE html>
...
HTMLEOF
aibilia-site deploy /tmp/new-page.html index.html
```

### 4. Verify
```bash
aibilia-site test           # Check all endpoints
```

### 5. Rollback if needed
```bash
aibilia-site restore        # Restore latest backup
```

## Design System Reference

When creating or modifying content, follow these design conventions:

### Colors (CSS variables)
```
--bg: #0c0b0e           (main background)
--bg-warm: #100f13      (warm sections)
--bg-card: #18171c      (card backgrounds)
--bg-glass: rgba(24,23,28,.65)  (glass effects)
--surface: #1e1d23      (surface elements)
--text: #f0ede6         (primary text)
--text-secondary: #9d9a93  (secondary text)
--text-muted: #5c5a55   (muted text)
--amber: #d4a853        (accent color)
--rose: #c45c5c         (error/negative)
--sage: #7a9e7e         (success/positive)
```

### Typography
- **Display**: Outfit (weights: 300-800)
- **Serif accent**: DM Serif Display (italic for emphasis)
- **Headings**: font-weight 700-800, letter-spacing -.02em to -.03em
- **Body**: font-weight 300-400, line-height 1.6-1.7
- **Labels**: font-size .7rem, uppercase, letter-spacing .1-.25em

### Pattern: Section structure
```html
<section class="xxx-section" id="section-id">
  <div class="section-eyebrow">LABEL</div>
  <div class="section-title">Title <span class="serif">accent</span></div>
  <!-- content -->
</section>
```

### Pattern: Card
```html
<div class="bento-card">
  <div class="bento-card-icon amber-bg">ICON</div>
  <h3>Title</h3>
  <p>Description text here</p>
</div>
```

## Adding New Pages

To add a new page (e.g., `/portfolio/project.html`):
```bash
# Create the page
cat > /tmp/project.html << 'EOF'
<!DOCTYPE html>
<html lang="it">
<!-- Use same head/styles as index.html -->
</html>
EOF

# Deploy to a subdirectory
mkdir -p /var/www/aibilia.com/portfolio
aibilia-site deploy /tmp/project.html portfolio/project.html
```

## Other Endpoints on aibilia.com

| Path | Service | Description |
|------|---------|-------------|
| `/` | Static site | Main website |
| `/health` | Engine (9200) | NEO Trading health JSON |
| `/terminal/` | ttyd (7681) | Web terminal (auth: neo/N30Tr4d1ng!) |
| `/cockpit/` | Cockpit (9090) | System management |
| `/api/*` | Chat API (8090) | Chat backend |

## Tips

1. **Always test after changes**: `aibilia-site test` verifies HTTP, HTTPS, SSL, and load time
2. **Backups are automatic**: Every write/deploy/update creates one. Max 20 kept.
3. **Caddy auto-reloads**: After deploy/update, Caddy is reloaded automatically
4. **Don't modify Caddyfile directly** — use `caddy` commands or ask the user
5. **Keep the design system consistent**: Use the CSS variables, don't hardcode colors
6. **Italian language**: All user-facing text should be in Italian
7. **GSAP animations**: Import from cdnjs, use ScrollTrigger for scroll-based effects
