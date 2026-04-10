---
name: argus
description: Argus — all-in-one information gathering & reconnaissance toolkit. 135 modules covering network infrastructure, web app analysis, and security/threat intelligence. Use for domain recon, subdomain enum, SSL analysis, tech stack detection, vulnerability scanning, and OSINT.
user-invocable: true
version: 2.0.0
---

# Argus — Information Gathering & Reconnaissance Toolkit

## What It Does
Argus is a Python-based toolkit with **135 modules** across three categories:

### Network & Infrastructure (32 modules)
DNS records, WHOIS, open ports, SSL chain analysis, traceroute, ASN lookup, reverse IP, CDN detection, BGP route analysis, IPv6 reachability, etc.

### Web Application Analysis (52 modules)
CMS detection, tech stack detection, crawler, directory finder, email harvesting, sitemap parsing, social media presence, CORS scanner, hidden parameter discovery, JavaScript analysis, etc.

### Security & Threat Intelligence (51 modules)
Subdomain enumeration, subdomain takeover, SSL Labs report, Shodan recon, Censys recon, VirusTotal scan, data leak detection, firewall detection, malware/phishing check, JWT token analyzer, exposed API endpoints, git repo exposure, SPF/DKIM/DMARC validation, etc.

## Installation
Installed via `pipx` at `~/.local/bin/argus` (v2.0.0).

## Usage

### Interactive Mode (TUI)
```bash
argus
```
Then use the interactive shell:
```
argus> modules              # List all 135 modules
argus> modules -d           # List with descriptions
argus> search ssl           # Search modules by keyword
argus> use 12               # Select module (e.g., SSL Chain Analysis)
argus> set target example.com
argus> set threads 10
argus> run                  # Execute
```

### Key Commands
| Command | Description |
|---------|-------------|
| `modules` | List all 135 modules |
| `modules -d` | List with descriptions |
| `search <keyword>` | Search modules |
| `use <number>` | Select module |
| `set target <domain>` | Set target |
| `set threads <n>` | Set thread count |
| `run` | Run selected module |
| `runall <category>` | Run all modules in category (infra/web/security) |
| `profile speed` | Apply speed profile |
| `viewout` | View cached output |
| `grepout "pattern"` | Search output |

### Non-Interactive / Scripted Usage
Argus is primarily a TUI tool. For scripted/automated use, pipe commands:
```bash
echo -e "use 18\nset target example.com\nrun\nexit" | argus
```

### Common Reconnaissance Workflows

**Quick domain overview:**
```
argus> use 5        # Domain Info
argus> set target getwololo.dev
argus> run
```

**SSL/TLS audit:**
```
argus> search ssl
argus> use 12       # SSL Chain Analysis
argus> set target getwololo.dev
argus> run
```

**Subdomain enumeration:**
```
argus> use 118      # Subdomain Enumeration
argus> set target getwololo.dev
argus> run
```

**Full infrastructure scan:**
```
argus> runall infra
```

## Module Categories (135 total)

### Network & Infrastructure (1-32)
Associated Hosts, DNS Over HTTPS, DNS Records, DNSSEC, Domain Info, Domain Reputation, HTTP/2+3 Support, IP Info, Open Ports, Server Info, Server Location, SSL Chain, SSL Expiry, TLS Ciphers, TLS Handshake, Traceroute, TXT Records, WHOIS, Zone Transfer, ASN Lookup, Reverse IP, IP Range Scanner, RDAP, NTP Leak, IPv6 Test, BGP Routes, CDN Detection, Reverse DNS, Network Timezone, Geo-DNS, SPF Network

### Web Application (53-102)
Archive History, Broken Links, Carbon Footprint, CMS Detection, Cookies, Content Discovery, Crawler, Robots.txt, Directory Finder, Email Harvesting, Performance, Quality Metrics, Redirects, Sitemap, Social Media, Tech Stack, Third-Party Integrations, JS Analyzer, CORS Scanner, Login Brute ID, Hidden Params, Clickjacking, Form Grabber, Favicon Hash, HTML Comments, CAPTCHA Check, JS Obfuscation, VHost Fuzzer, Session Cookie, HTML5 Abuse, Autocomplete Vuln

### Security & Threat Intelligence (103-135)
Censys Recon, Certificate Authority, Data Leak Detection, Exposed Env Files, Firewall Detection, Global Ranking, HTTP Headers, HTTP Security, Malware Check, Pastebin Monitor, Privacy/GDPR, Security.txt, Shodan Recon, SSL Labs, SSL Pinning, Subdomain Enum, Subdomain Takeover, VirusTotal, CT Logs, Breached Creds, Cloud Bucket Exposure, JWT Analyzer, Exposed APIs, Git Repo Exposure, Typosquat Checker, SPF/DKIM/DMARC, Open Redirect, WAF Bypass, Security Changelog, Session Hijacking, Rogue Cert Check

## ⚠️ Important Notes
- **Legal:** Only scan domains you own or have explicit authorization for
- **API keys:** Some modules (Shodan, Censys, VirusTotal) need API keys — configure via `show api_status`
- **Results:** Saved to `./results/` directory
- **Complements WebCopilot:** Argus is better for targeted single-domain deep recon; WebCopilot is better for automated subdomain + vuln scanning pipelines
