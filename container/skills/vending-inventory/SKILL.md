---
name: vending-inventory
description: Track vending machine inventory by pulling sales data from HahaVending and Vendera, updating the Google Sheets inventory spreadsheet, and generating shopping lists. Use for any vending-related questions about sales, inventory, or restocking.
allowed-tools: Bash(agent-browser:*), Bash(npx tsx /workspace/project/tools/sheets/sheets.ts *)
---

# Vending Machine Inventory Automation

## Overview

Weekly automation (runs every Friday at 7pm Central):
1. Log into HahaVending and Vendera to pull the full week's sales
2. Update the Google Sheets inventory spreadsheet
3. Generate a shopping list based on warehouse stock levels + sales performance
4. Search for replacement products when items are blacklisted
5. Send summary + shopping list via WhatsApp

## MANDATORY RULES

1. **ONE MESSAGE ONLY:** Send exactly ONE WhatsApp message with the complete consolidated report. Do NOT send progress updates, status messages, or multiple messages. Work silently until done, then send one clean report.
2. **WRITE TO SHEETS:** You MUST update Google Sheets (Sales Performance, Warehouse Inventory, Ordering List) — not just read them. Use the sheets tool with `write` and `append` commands.
3. **COMBINE PLATFORMS:** Merge sales from HahaVending + Vendera into unified per-product totals. Show platform breakdown in the report but totals should be combined.
4. **ALL MACHINES:** Account for every machine across both platforms. List all reporting machines in the report.
5. **NO INTERNAL TAGS:** Never wrap your final output in `<internal>` tags. The report must be delivered to the user via `send_message`.
6. **NO PARTIAL REPORTS:** Do NOT send a report unless you have sales data from BOTH HahaVending and Vendera. If one platform fails, retry it (up to 3 attempts). If both fail after retries, send an error message requesting manual intervention — never send a report with only IDDI data.

## Credentials

Login credentials are in the group's CLAUDE.md under "Platform Credentials": `/workspace/group/CLAUDE.md`

Read CLAUDE.md FIRST before doing anything else. Extract the email and password for both platforms.

## Browser Automation — CRITICAL RULES

The browser tool is `agent-browser`. Follow these rules exactly or logins WILL fail:

### Rule 1: Always close before opening
```bash
agent-browser close 2>/dev/null; sleep 1
```
Run this before EVERY `agent-browser open` call. The browser daemon persists between commands — if a previous session is running, `open` will fail or navigate in a stale context.

### Rule 2: Use --session-name for auto-persistence
```bash
agent-browser --session-name vendera open "https://vms.vendera.ai/login"
```
The `--session-name` flag auto-saves and restores cookies/localStorage between runs. If a valid session exists, the site may skip the login page entirely.

### Rule 3: Login sequence
After opening a login page:
```bash
agent-browser snapshot -i          # See form fields and their refs
agent-browser fill @e1 "email"     # Fill email field (use ref from snapshot)
agent-browser fill @e2 "password"  # Fill password field
agent-browser click @e3            # Click login button (use ref from snapshot)
agent-browser wait 3000            # Wait for redirect
agent-browser snapshot -i          # Verify you landed on dashboard
```

### Rule 4: Never use these (they don't work)
- `agent-browser state load <file>` — NOT a valid command
- `agent-browser state save <file>` — NOT a valid command
- `agent-browser new` — NOT a valid command
- `agent-browser navigate` — use `agent-browser open` instead

### Rule 5: Wait after every navigation
```bash
agent-browser open <url> && agent-browser wait 3000 && agent-browser snapshot -i
```
Always chain: open → wait → snapshot. Never snapshot immediately after open.

## Platform: HahaVending

### Login

```bash
agent-browser close 2>/dev/null; sleep 1
agent-browser --session-name hahavending open "https://thorh5.hahabianli.com/pages/login/login"
agent-browser wait 3000
agent-browser snapshot -i
```

If you see a login form (email/password fields):
1. Fill email and password from CLAUDE.md credentials
2. Click the Sign in button
3. Wait 3 seconds, then snapshot to confirm login

If redirected to `/pages/login/register` (Sign up page), look for a "Login" text link and click it first.

If you land on the home page or dashboard directly, the session is still valid — proceed to sales data.

### Getting weekly sales data (preferred method)

Calculate this week's Monday and Friday dates in YYYY-MM-DD format, then:

```bash
agent-browser open "https://thorh5.hahabianli.com/pages/statistics/product-sales-ranking?start_time=YYYY-MM-DD&end_time=YYYY-MM-DD&tabIndex=2"
agent-browser wait 5000
agent-browser snapshot
```

This shows the Product Ranking page directly. Read each row: Product name, Sales ($), Sales volume (quantity). Scroll down to see all products.

If "Sales volume" column is not visible, try:
```bash
agent-browser scroll right 200
agent-browser snapshot
```

### Fallback method (manual navigation)

1. From home page, click "More" button (top right) → Data Center
2. Click "Week" tab at top
3. Scroll to "Product Ranking" section
4. Click "More >" to see full list

## Platform: Vendera

### Login

```bash
agent-browser close 2>/dev/null; sleep 1
agent-browser --session-name vendera open "https://vms.vendera.ai/login"
agent-browser wait 3000
agent-browser snapshot -i
```

If you see a login form:
1. Fill email and password from CLAUDE.md credentials
2. Click the orange "Login" button
3. Wait 3 seconds, then snapshot to confirm login

If you land on Dashboard (`/home`) directly, the session is still valid — proceed.

### Getting weekly sales data

1. After login, navigate to Dashboard if not already there:
   ```bash
   agent-browser open "https://vms.vendera.ai/home"
   agent-browser wait 3000
   agent-browser snapshot
   ```
2. Scroll down past Transaction/Revenue/Machine Overview cards
3. Find "Product Sales Ranking" section
4. Click "Past Week" tab
5. Click "By Items Sold" to sort by quantity
6. Read each row: product name, Quantity, Revenue
7. Check for pagination — look for "Page X of Y" and click "Next >" until all pages are read
8. Record every product name and its quantity sold

**Key URLs:**
- Dashboard: `https://vms.vendera.ai/home`
- Sales Transactions: `https://vms.vendera.ai/orders/orders/sale`
- Product Library: `https://vms.vendera.ai/products/products/library`

## Login Retry Logic

If login fails (wrong page, timeout, error message on page):

1. **Attempt 1:** Close browser, reopen, try login again
2. **Attempt 2:** Close browser, wait 5 seconds, reopen with a fresh session name (`--session-name vendera2`), try login again
3. **Attempt 3:** Close browser, try without `--session-name` flag (completely fresh), try login again

If all 3 attempts fail, do NOT proceed with partial data. Send an error message:
```
*VENDING INVENTORY — Login Failed*
Platform: [name]
Attempts: 3
Last error: [what you saw on screen]
Action needed: Please verify credentials in CLAUDE.md are still valid
```

## Spreadsheet Structure

**Spreadsheet:** "snak group inventory tracker"

### Tab: Warehouse Inventory
| Column | Field |
|--------|-------|
| A | SKU |
| B | Product Name |
| C | Current Stock |
| D | Starting amount |
| E | Color Code |
| F | Expiration date |
| G | Re-Order amount |

**Warehouse Color Codes (column E) — STOCK LEVEL indicator:**
- **Red** = Low stock, running out
- **Yellow** = Moderate stock, still OK for now
- **Green** = Well stocked, plenty on hand

### Tab: Sales Performance
Tracks sales over a 4-week rolling trial per product. Has Week 1, Week 2, Week 3, Week 4 columns.

**Sales Performance Color Codes — DEMAND indicator:**
- **Green** = Selling well, high demand
- **Yellow** = Moderate sales, decent demand
- **Red** = Slow seller, low demand

### Tab: Ordering List
Generated shopping list output.

## CRITICAL: Reorder Decision Matrix

**Always check Warehouse Inventory color FIRST, then cross-reference Sales Performance.**

| Warehouse Color | Sales Performance Color | Action |
|----------------|------------------------|--------|
| RED (low stock) | GREEN (selling well) | REORDER |
| RED (low stock) | YELLOW (moderate sales) | REORDER |
| RED (low stock) | RED (slow seller) | DO NOT REORDER |
| YELLOW (OK stock) | Any color | DO NOT REORDER (enough stock) |
| GREEN (well stocked) | Any color | DO NOT REORDER (plenty on hand) |

**Key rule:** Only reorder items that are BOTH low on stock (red warehouse) AND actually selling (green/yellow sales).

## Blacklist Process

Items are NOT blacklisted immediately. They go through a 4-week trial:

1. **Week 1-3 of poor sales:** Item shows as red in Sales Performance but stays active. Include in report as "approaching blacklist" warning.
2. **Week 4 of consecutive poor sales:** Item is officially blacklisted for 3 months. Do NOT reorder.
3. **After 3 months:** Item comes off blacklist and can be retried.

When inputting weekly sales, use the correct week column (Week 1, 2, 3, or 4) so the 4-week trial tracks properly.

## Replacement Product Search

When an item is blacklisted:
1. Use web search to find similar products at Sam's Club and Costco
2. Suggest 2-3 replacement options with:
   - Product name
   - Price (if visible)
   - Pack size
   - Which store (Sam's Club or Costco)

Do NOT use browser automation on Sam's Club or Costco — they block headless browsers. Use web search instead.

## Step-by-step: Update Spreadsheet

### 1. Read all tabs

```bash
npx tsx /workspace/project/tools/sheets/sheets.ts read --range "Warehouse Inventory!A:G"
npx tsx /workspace/project/tools/sheets/sheets.ts read --range "Sales Performance!A:Z"
npx tsx /workspace/project/tools/sheets/sheets.ts read --range "Ordering List!A:Z"
```

### 2. Update Sales Performance

Record this week's sales in the correct week column (1, 2, 3, or 4). After week 4, the cycle resets.

### 3. Update Warehouse Inventory

Subtract this week's total sold from Current Stock (column C).

## Shopping List Format (WhatsApp)

```
*Weekly Vending Report — [Date]*

*SHOPPING LIST (Reorder from Sam's Club):*
• [Product] — buy [X] (warehouse: RED, sales: GREEN)
• [Product] — buy [X] (warehouse: RED, sales: YELLOW)

*WELL STOCKED (no reorder needed):*
• [Product] — [X] remaining (warehouse: yellow/green)

*APPROACHING BLACKLIST (warning — red sales [X] weeks):*
• [Product] — slow sales week [2/4], [X] units this week
• [Product] — slow sales week [3/4], [X] units this week

*NEWLY BLACKLISTED (4 weeks poor sales — pulled for 3 months):*
• [Product] — avg [X] units/week over 4 weeks
  Suggested replacements:
  - [New product] from Sam's Club ($X, pack of Y)
  - [New product] from Costco ($X, pack of Y)

*COMING OFF BLACKLIST SOON:*
• [Product] — blacklisted [date], eligible to retry [date]

*SALES HIGHLIGHTS:*
• Top seller: [Product] — [X] units
• Total units sold: [X]
• HahaVending: [X] / Vendera: [X]
```

Use WhatsApp formatting: single *bold*, _italic_, bullet points. No markdown headings.

## Execution Order

Follow this exact sequence:

1. Read CLAUDE.md — get credentials
2. Read Google Sheets (all 3 tabs) — understand current state
3. Login to HahaVending — pull weekly sales (retry up to 3x if needed)
4. Login to Vendera — pull weekly sales (retry up to 3x if needed)
5. If BOTH platforms succeeded: combine data, update sheets, generate report, send ONE message
6. If EITHER platform failed after 3 retries: send error message, do NOT send partial report
