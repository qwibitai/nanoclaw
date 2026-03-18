# /add-minimax-oauth

Adds MiniMax OAuth (Coding Plan) as the model provider.
No Anthropic API key or Claude OAuth token required.

The files are already present in this fork:

- src/minimax-oauth.ts - MiniMax device-code OAuth (PKCE S256)
- scripts/minimax-login.ts - one-shot login CLI
- src/credential-proxy.ts - extended with minimax-oauth auth mode

Run the login CLI to authenticate and write tokens to .env:

```bash
npm run minimax-login
```

For CN region: npm run minimax-login -- --region cn

Then start NanoClaw: npm run dev

Tokens auto-refresh 60s before expiry. See README.md for details.
