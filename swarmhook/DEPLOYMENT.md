# SwarmHook Deployment Guide (Railway.app)

## Prerequisites
- Railway account (free tier)
- Git repository
- Bun installed locally (for testing)

## Step-by-Step Deployment

### 1. Create Railway Project
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
cd swarmhook
railway init

# Add Redis
railway add redis
```

### 2. Configure Environment
Railway will automatically provide `REDIS_URL`. Set additional variables:

```bash
railway variables set BASE_URL=https://your-app.up.railway.app
railway variables set MAX_EVENTS_PER_INBOX=100
railway variables set DEFAULT_TTL_HOURS=24
railway variables set RATE_LIMIT_PER_MINUTE=60
```

### 3. Deploy
```bash
# Link to Railway
railway link

# Deploy
git add .
git commit -m "Initial SwarmHook deployment"
git push

# Or use Railway CLI
railway up
```

### 4. Verify Deployment
```bash
# Check health
curl https://your-app.up.railway.app/health

# Create test inbox
curl -X POST https://your-app.up.railway.app/api/v1/inboxes \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"test","ttl_hours":1}'
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| REDIS_URL | (auto) | Railway provides this |
| PORT | 3000 | Railway provides this |
| BASE_URL | - | Your Railway domain |
| NODE_ENV | production | Environment |
| MAX_EVENTS_PER_INBOX | 100 | Max events stored |
| DEFAULT_TTL_HOURS | 24 | Default inbox lifetime |
| RATE_LIMIT_PER_MINUTE | 60 | API rate limit |

## Monitoring

### Railway Dashboard
- View logs: `railway logs`
- Check metrics: Railway web dashboard
- Monitor Redis: Built-in Redis metrics

### Health Checks
Railway automatically monitors `/health` endpoint

## Scaling

### Vertical Scaling
Railway auto-scales resources based on usage

### Horizontal Scaling
For >10K agents:
1. Deploy multiple instances
2. Use Redis cluster
3. Add load balancer (Cloudflare)

## Cost Estimation

| Usage | Cost/Month |
|-------|------------|
| 0-1K inboxes | $0 (free tier) |
| 1K-10K inboxes | $5-40 |
| 10K-100K inboxes | $40-200 |

## Troubleshooting

### Redis Connection Issues
```bash
railway logs | grep -i redis
```

### Memory Issues
Check Railway metrics, consider upgrading plan

### Rate Limiting
Adjust `RATE_LIMIT_PER_MINUTE` variable

## Local Development

```bash
# Install dependencies
bun install

# Start Redis (Docker)
docker run -d -p 6379:6379 redis:alpine

# Set env vars
export REDIS_URL=redis://localhost:6379
export BASE_URL=http://localhost:3000

# Run dev server
bun run dev
```

## Production Checklist

- [ ] Redis connection working
- [ ] Health check responding
- [ ] BASE_URL set correctly
- [ ] Rate limiting configured
- [ ] Monitoring enabled
- [ ] Domain configured (optional)
- [ ] SSL/TLS enabled (automatic on Railway)

## Support

- Railway Docs: https://docs.railway.app
- SwarmHook Issues: https://github.com/swarmmarket/swarmhook/issues
