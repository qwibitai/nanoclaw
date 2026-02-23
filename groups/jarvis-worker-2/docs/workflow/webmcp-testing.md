# WebMCP Testing

Alternative to DOM scraping for browser testing. Uses structured tools instead of screen-scraping.

## Why WebMCP

| Approach | Tokens | Reliability |
|----------|--------|--------------|
| DOM scraping | High | Brittle |
| WebMCP tools | Low | Robust |

## Setup

1. Enable Chrome flag: `chrome://flags/#enable-webmcp-testing`
2. Install [Model Context Tool Inspector Extension](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd)

## Server Requirement

**ALWAYS:**
1. Start server before testing: `npm run dev` (or equivalent)
2. Verify health: `curl localhost:<port>/health`
3. Stop server after testing: `pkill -f` or kill PID

## WebMCP Registration Verification

**BEFORE browser testing:**

```javascript
// In browser console or via WebMCP tool
const tools = await navigator.modelContext.getTools();
if (tools.length === 0) {
  throw new Error("App missing WebMCP registration - cannot test");
}
```

**If tools not registered:**
- Fail loudly: "WebMCP not available"
- Do NOT fallback to DOM scraping unless explicitly required

## Usage

### Register Tools (Imperative)

```javascript
window.navigator.modelContext.registerTool({
  name: "searchFlights",
  description: "Search for flights between origin and destination",
  inputSchema: {
    type: "object",
    properties: {
      origin: { type: "string" },
      destination: { type: "string" }
    }
  },
  execute: ({ origin, destination }) => {
    // Your logic here
    return { content: [{ type: "text", text: "Results..." }] };
  }
});
```

### Or Declarative (HTML)

```html
<form toolname="submitOrder" toolautosubmit action="/order">
  <input name="item" type="text">
  <input name="quantity" type="number">
</form>
```

## WebMCP vs DOM Scraping

| Scenario | Choice |
|----------|--------|
| App has WebMCP tools | WebMCP (preferred) |
| App missing WebMCP | Report error, skip browser test |
| Critical path needs DOM | Only if explicitly requested |

## For Jarvis

Use WebMCP when:
- Testing forms with complex validation
- Need reliable UI interactions
- Token efficiency matters

See: [WebMCP Documentation](https://github.com/GoogleChromeLabs/webmcp-tools)
