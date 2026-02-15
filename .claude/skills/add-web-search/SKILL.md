---
name: add-web-search
description: Add web search capabilities to NanoClaw agents using Tavily API. Agents can search the web from inside containers to answer questions about current events, look up documentation, and find real-time information.
---

# Add Web Search

This skill adds web search capabilities to NanoClaw agents. Agents running inside containers will be able to search the web to answer questions about current events, look up documentation, verify facts, and find real-time information.

Uses the [Tavily API](https://tavily.com/) which is purpose-built for AI agents and returns clean, structured results.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need a Tavily API key for web search capabilities.
>
> 1. Go to https://tavily.com/ and sign up (free tier includes 1,000 searches/month)
> 2. Go to your dashboard and copy your API key
>
> Cost: Free tier includes 1,000 searches/month. Paid plans start at $0.01/search.
>
> Do you have your API key ready?

Wait for user to confirm and provide the key.

---

## Implementation

### Step 1: Add Tavily API Key to Environment

Add the API key to `.env`:

```bash
echo "TAVILY_API_KEY=<key_from_user>" >> .env
```

Add `TAVILY_API_KEY` to the list of allowed env vars in `src/container-runner.ts` in the `buildVolumeMounts` function. Find the `allowedVars` array and add to it:

```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'TAVILY_API_KEY'];
```

### Step 2: Add Search Tool to Agent Runner

Read `container/agent-runner/src/index.ts` and find the `allowedTools` array in the `query()` call.

Add the web search tools:

```typescript
allowedTools: [
  ...existing tools...
  'WebSearch',
  'WebFetch',
],
```

These are built-in Claude tools that will use the Tavily API key from the environment.

### Step 3: Update Group Memory

Append to `groups/CLAUDE.md`:

```markdown

## Web Search

You have access to web search capabilities:
- `WebSearch` - Search the web for current information on any topic
- `WebFetch` - Fetch and read the content of a specific URL

Use web search when you need:
- Current events or news
- Up-to-date documentation or API references
- Verification of facts
- Real-time data (weather, stock prices, etc.)
- Any information that may have changed after your training data cutoff
```

Also append the same section to `groups/main/CLAUDE.md`.

### Step 4: Rebuild Container and Restart

The container needs to be rebuilt since the agent runner changed:

```bash
cd container && ./build.sh
```

Wait for the build to complete, then compile TypeScript:

```bash
cd .. && npm run build
```

Restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 5: Test

Tell the user:

> Web search is now available! Test it by sending a message like:
>
> `@Andy what happened in the news today?`
>
> or:
>
> `@Andy search for the latest Node.js release notes`
>
> The agent will search the web and include the results in its response.

Monitor logs:

```bash
tail -f logs/nanoclaw.log
```

---

## How It Works

1. The `TAVILY_API_KEY` environment variable is passed into the container
2. Claude's built-in `WebSearch` and `WebFetch` tools use this key automatically
3. When the agent decides it needs current information, it invokes `WebSearch`
4. Results are returned as structured data that the agent incorporates into its response

---

## Troubleshooting

### "WebSearch tool not available"

- Verify `WebSearch` and `WebFetch` are in the `allowedTools` array
- Rebuild the container: `cd container && ./build.sh`

### Search returning no results

- Verify the API key is valid at https://tavily.com/dashboard
- Check that `TAVILY_API_KEY` is in the `allowedVars` list in `container-runner.ts`
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

### Rate limit errors

- Free tier is 1,000 searches/month
- Check usage at https://tavily.com/dashboard
- Upgrade plan if needed

---

## Removing Web Search

1. Remove `TAVILY_API_KEY` from `.env`

2. Remove `TAVILY_API_KEY` from the `allowedVars` array in `src/container-runner.ts`

3. Remove `WebSearch` and `WebFetch` from `allowedTools` in `container/agent-runner/src/index.ts`

4. Remove the "Web Search" section from `groups/CLAUDE.md` and `groups/main/CLAUDE.md`

5. Rebuild:
   ```bash
   cd container && ./build.sh && cd ..
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
