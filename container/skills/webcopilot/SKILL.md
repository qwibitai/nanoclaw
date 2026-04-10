---
name: webcopilot
description: Automated web security reconnaissance and vulnerability scanning using WebCopilot. Enumerates subdomains, crawls endpoints, filters vulnerability parameters (XSS, SQLi, SSRF, LFI, RCE, Open Redirect), and scans with nuclei/dalfox/sqlmap.
user-invocable: true
version: 2.0.0
---

# WebCopilot — Automated Web Recon & Vuln Scanner

## What It Does
WebCopilot chains 20+ security tools into a single automated pipeline:
1. **Subdomain enumeration** — assetfinder, subfinder, amass, findomain, crt.sh
2. **Active subdomain brute** — gobuster with SecLists DNS wordlists
3. **Live host filtering** — dnsx + httpx (titles, screenshots)
4. **Subdomain takeover check** — subjack
5. **Endpoint crawling** — gau, waybackurls, waymore
6. **Parameter filtering** — gf patterns for XSS, SQLi, SSRF, LFI, RCE, Open Redirect
7. **Vulnerability scanning** — dalfox (XSS), nuclei (CVEs), sqlmap (SQLi), crlfuzz (CRLF)

## Prerequisites
All tools are installed at `~/go/bin/` and system PATH. Verify with:
```bash
webcopilot -v
```

### Tool Locations
- **Go tools**: `~/go/bin/` (subfinder, nuclei, httpx, dalfox, amass, etc.)
- **Python tools**: sqlmap, waymore (pip3)
- **gf patterns**: `~/.gf/*.json` (14 patterns)
- **Wordlists**: `~/wordlists/SecLists/Discovery/DNS/`
- **WebCopilot script**: `~/go/bin/webcopilot`

## Usage

### Quick subdomain enum only (default)
```bash
webcopilot -d target.com
```

### Full scan (subdomain enum + vuln scanning)
```bash
webcopilot -d target.com -a
```

### Full scan with output dir and blind XSS server
```bash
webcopilot -d target.com -a -o target-results -t 200 -b your-bxss-server.oast.fun
```

### Scan with pre-collected subdomains (skip enum)
```bash
webcopilot -d target.com -f subdomains.txt -a
```

### Exclude out-of-scope domains
```bash
webcopilot -d target.com -a -x exclude.txt
```

## Flags
| Flag | Description | Default |
|------|-------------|---------|
| `-d` | Target domain | Required |
| `-o` | Output directory | `webcopilot-<domain>` |
| `-t` | Number of threads | 100 |
| `-b` | Blind XSS server URL | None |
| `-x` | File with excluded domains | None |
| `-f` | File with subdomains (skips enum) | None |
| `-a` | Run ALL scans (not just enum) | Off |
| `-v` | Show version | — |

## ⚠️ Important Notes
- **Requires root** for some network operations — use `sudo` when needed
- **Time consuming** — full `-a` scan can take hours on large targets
- **Legal**: Only scan domains you own or have explicit authorization for
- **BXSS**: Use https://app.interactsh.com/ for blind XSS callback server
- **Output**: All results saved to the output directory with per-tool subdirs

## Individual Tool Usage
You can also use the installed tools individually:

```bash
# Quick subdomain enum
subfinder -d target.com -silent | sort -u

# Nuclei template scan
nuclei -u https://target.com -t cves/

# XSS scan with dalfox
echo "https://target.com/page?q=test" | dalfox pipe

# HTTP probing
cat subdomains.txt | httpx -silent -title -status-code
```
