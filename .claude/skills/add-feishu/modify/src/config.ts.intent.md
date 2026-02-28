# Intent: src/config.ts modifications

## What changed

No changes required. Feishu credentials are read from .env using `readEnvFile()` in the FeishuChannel constructor.

## Env variables used

- `FEISHU_APP_ID` - Feishu application ID
- `FEISHU_APP_SECRET` - Feishu application secret
