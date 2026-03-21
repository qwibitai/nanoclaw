# TODO

## Consulting / Phase 2 Evaluation

- [ ] **NotebookLM MCP Setup** — Test modular Docker setup at `~/notebooklm-mcp/`: authenticate, create 4 topic-based notebooks (Finance/Supply Chain/HR/Operations), upload selective APQC documents, register with Claude Code, verify auto-notebook selection & citation-backed answers

## Cloudflare

- [ ] **Tunnel** — expose VPS services (PocketBase, web apps) over HTTPS without opening firewall ports; secure with Cloudflare Access (Google login gate)
- [ ] **Email Routing** — route `andy@yourdomain.com` to Gmail or a Worker webhook; cleaner domain for the agent's email channel
- [ ] **AI Gateway** — proxy Claude/Gemini/OpenAI calls for cost/latency/token dashboard; helps debug Gemini RPD quota issues in JanaSuvidha
