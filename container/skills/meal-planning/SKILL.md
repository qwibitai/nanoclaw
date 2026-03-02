---
name: meal-planning
description: >
  Plan the week's meals, build a grocery list, and sync it to the Kroger cart.
  JBot orchestrates everything — recipe parsing, meal planning, product matching.
  The Python CLI handles data persistence and Kroger API calls.
allowed-tools: Bash(meal-plan*), Bash(todoist*)
---

# Meal Planning Skill

## Role

JBot is the brain. The `meal-plan` CLI is the hands.

- **JBot does:** meal plan generation, product matching, reasoning about family preferences
- **CLI does:** recipe storage (SQLite), Kroger OAuth + API calls

## Container Paths

| What | Container Path |
|------|----------------|
| meal-plan source | `/workspace/extra/meal-planning-agent/` |
| config, tokens, DB | `/workspace/extra/meal-planning-config/` |
| todoist CLI config | `/workspace/extra/todoist-cli-config/` |

The `meal-plan` command is available directly in PATH (wrapper installed in container image).

## Always Load Family Context First

Before every planning session, read:
```
~/.meal-planning/family.yaml
```

This file defines servings needed, meals per week, cooking time budget, dietary preferences, and grocery setup. Never plan without it.

## Family Context

- **Jim** + **Laura** — 2 adults, Jim cooks
- **Andrew** (5), **Tommy** (3) — picky kids, need kid-friendly meals
- **Lucy** — infant, not eating table food yet
- **Servings needed:** 4
- **Cook 2 meals/week**, eat leftovers 3 nights, 2 free/takeout nights
- **Weeknight budget:** ≤45 min | **Weekend:** up to 90 min
- **Avoid:** seafood, overly spicy
- **Delivery** from Kroger Kedron Village, Peachtree City GA

## Typical Workflow

### 1. Plan the week

```
User: "Plan the week" / "What should we cook this week?"
```

1. Run setup bootstrap (above)
2. Read `~/.meal-planning/family.yaml` for current preferences
3. Call `meal-plan list-recipes --json-output` to see what's in the library
4. **Pick 2 recipes** following these rules:
   - Both must be kid-friendly (Andrew 5, Tommy 3)
   - Vary the protein across the two meals
   - Each should yield ≥4 servings (feeds the family, generates leftovers)
   - At least one should be ≤45 min (weeknight-friendly)
   - Prefer Sunday + Wednesday as cook nights
5. Present the plan showing cook nights, leftover nights, and free nights
6. After Jim approves, call `meal-plan save-plan '<json>'` to persist

**Example output:**
```
Here's the plan for this week:

🍳 Sunday: Marry Me Chicken (cook — 6 servings)
🥡 Monday: Marry Me Chicken (leftovers)
🍳 Wednesday: Beef Stroganoff (cook — 4 servings)
🥡 Thursday: Beef Stroganoff (leftovers)
🍕 Tuesday/Friday: Free nights (takeout or easy)

Good with this? I'll load the Kroger cart.
```

### 2. Load the Kroger cart

⚠️ **NEVER add to cart without explicit confirmation.** Always show the full item list first and wait for Jim to say something like "load it", "go ahead", or "yes". Approving the meal plan is NOT the same as approving the cart load.

After plan is approved AND cart load is explicitly confirmed:

1. Call `meal-plan grocery-list` to get all ingredients as JSON
2. **Filter out staples:** cross-reference `~/.meal-planning/staples.yaml`
   - `always_skip` → drop silently, never add to cart
   - `check_first` → only include if Jim mentioned it OR it's in Todoist
3. **Pull Todoist Groceries list:** `todoist tasks -p "Groceries" --json`
   - These always get added regardless of staples list
4. Ask Jim: "Anything else you're running low on?" before loading cart
5. **Show the final item list** and wait for explicit confirmation before adding anything
6. For each confirmed item:
   - **Check `~/.meal-planning/preferences.yaml` first** — use known preference search terms
   - Call `meal-plan search-products "<search term>" --limit 5`
   - Pick the best match (family of 4 size, price, avoid pre-seasoned)
   - Call `meal-plan add-to-cart <product_id>`
7. Report back: "Cart loaded — X items added. Review at kroger.com before checking out."

### 3. Add a recipe

```
User: "Add this recipe: <url>"
```

1. Call `meal-plan add-recipe <url>` — scraper handles it
2. Confirm title + ingredient count back to user

For PDFs or manual recipes:
1. Call `meal-plan extract-pdf <path>` to get raw text (for PDFs)
2. Parse the recipe yourself from the text
3. Call `meal-plan add-recipe-json '<json>'` to save

## Commands Reference

| Command | What it does |
|---|---|
| `meal-plan setup` | Initialize DB, check env vars |
| `meal-plan kroger-auth` | One-time OAuth flow (run interactively) |
| `meal-plan add-recipe <url>` | Parse + save a recipe from URL |
| `meal-plan add-recipe-json '<json>'` | Save a recipe from structured JSON |
| `meal-plan extract-pdf <path>` | Get raw text from a PDF recipe |
| `meal-plan list-recipes [--json-output]` | List all saved recipes |
| `meal-plan save-plan '<json>' [--week YYYY-WW]` | Save agent-generated meal plan |
| `meal-plan show-plan [--json-output]` | Show current week's plan |
| `meal-plan grocery-list [--week YYYY-WW]` | Get ingredient list as JSON |
| `meal-plan search-products '<query>' [--limit 5]` | Search Kroger, returns JSON candidates |
| `meal-plan add-to-cart <product_id> [--qty 1]` | Add product to Kroger cart |
| `meal-plan find-stores <zip>` | Find nearby Kroger stores |
| `meal-plan email-plan` | Email the week's plan |

## save-plan JSON Format

```json
{
  "monday":    {"dinner": "Chicken Tacos"},
  "tuesday":   {"dinner": "Spaghetti Bolognese"},
  "wednesday": {"dinner": "Sheet Pan Salmon"},
  "thursday":  {"dinner": "Chicken Fried Rice"},
  "friday":    {"dinner": "Homemade Pizza"},
  "saturday":  {},
  "sunday":    {}
}
```

## Product Matching Guidelines

- **Prefer:** standard sizes for a family of 4, name brands the family likely uses
- **Avoid:** pre-seasoned/marinated versions when recipe will season it, single-serve sizes
- **Size heuristic:** recipes assume ~4 servings; pick accordingly (e.g. 1.5 lb chicken, not 3 oz)
- If no good match in 5 results, skip and note it in the summary
