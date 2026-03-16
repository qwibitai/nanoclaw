---
name: draft
description: Generate thesis drafts for blog and social media. Triggered by [DRAFT_REQUEST] tags OR conversational requests to draft, write up, or publish ideas. Creates thesis directory in huynh.io, generates humanized drafts in the user's voice, commits to GitHub, and saves X drafts.
---

# /draft - Thesis Draft Generator

Run this workflow when ANY of these are true:
- The message contains `[DRAFT_REQUEST]...[/DRAFT_REQUEST]` tags
- The user asks you to draft something for the blog or huynh.io
- The user asks you to write up, publish, or turn an idea into a post
- The user says something like "draft that", "write that up", "turn this into a blog post", "make a tweet about this", "prepare this for publishing"
- The user references a thesis or idea and wants it written up for any platform

The input may be messy speech-to-text. Extract the core idea — don't expect clean formatting.

**CRITICAL: Never publish anything. Only create drafts for review.**

## Step 1: Gather Source Material

1. Read the user's thesis topic — from `[DRAFT_REQUEST]` tags if present, otherwise from the conversational message
2. Check `/workspace/ipc/obsidian_context.json` for related Obsidian notes (if it exists — it won't for conversational triggers)
3. If no obsidian_context.json, search for related notes directly using `find /workspace/obsidian/pj-private-vault/pj-private-vault/ -name "*.md"` and grep for keywords from the thesis topic
4. If related notes are found, read the most relevant ones to gather context and source material
5. If the user references a specific note by name, search for it in the Obsidian vault

## Step 2: Read Voice Guide

Read `/workspace/projects/pj/huynh.io/voice.md` in full. This is the authoritative style guide. Every draft must match this voice exactly.

Key voice rules (read the full file for details):
- Short paragraphs (1-3 sentences), fragments allowed
- First-person heavy, genuinely casual, contractions required
- Lead with specific experience not thesis
- No bold/italic, no title case headers, no em-dashes
- No rule of three, no thesis-restatement, no parallel constructions
- Use `#` for title and `##` for sections only
- Casual section headers (not descriptive)

## Step 3: Create Thesis Directory

Create a directory in the huynh.io project:

```
/workspace/projects/pj/huynh.io/YYYYMMDD-slug/
```

- **Date**: Today's date in `YYYYMMDD` format
- **Slug**: Short kebab-case summary (2-4 words, e.g., `spec-driven-dev`, `ai-writing-voice`)

Write `thesis.md` — the core thesis. This is the raw idea, structured as:
- What's the claim?
- What evidence/experience supports it?
- Why does it matter?

Keep it concise (300-800 words). This is a working document, not a published piece.

## Step 4: Generate Blog Draft

Write `blog-draft.md` in the thesis directory.

This is a full blog post draft. Follow these rules strictly:

1. **Read and internalize voice.md first** — match rhythm, grammar, tone, and structure exactly
2. **Lead with a specific experience** — not the thesis statement. Start with a moment, a thing that happened
3. **Let the thesis emerge** — don't state it upfront, let the reader discover it through the narrative
4. **Use the naming convention**: no frontmatter needed, just the markdown content with `#` title and `##` sections
5. **Target length**: 800-1500 words (match existing posts)
6. **Apply humanizer rules** (see Step 6)

## Step 5: Generate X/Tweet Draft

Write `x-draft.md` in the thesis directory.

This is a tweet draft (max 280 characters). Rules:
- Distill the thesis to one punchy thought
- Match the casual, first-person voice from voice.md
- No hashtags unless they serve the content
- Should stand alone — don't assume the reader knows the blog post
- Can be provocative or surprising

## Step 6: Humanize All Drafts

Before finalizing, audit every draft against these AI-writing patterns and eliminate them:

### Patterns to Remove
- **Significance inflation**: "groundbreaking", "revolutionary", "game-changing", "paradigm shift"
- **Promotional language**: "exciting", "impressive", "remarkable", "cutting-edge"
- **Vague attributions**: "many experts say", "it is widely believed", "research suggests"
- **Filler phrases**: "In order to" (use "to"), "It is important to note that" (just say it), "At the end of the day"
- **Copula avoidance**: Don't say "serves as" when you mean "is". Don't say "functions as" when you mean "is"
- **Excessive conjunctives**: "Additionally", "Furthermore", "Moreover" — use sparingly or not at all
- **Em dash overuse**: voice.md explicitly bans em-dashes
- **Rule of three**: Don't list exactly three things in a rhythmic pattern
- **Negative parallelisms**: "not just X, but Y" — find a more natural way
- **AI vocabulary**: "delve", "tapestry", "multifaceted", "landscape", "nuanced", "robust", "leverage", "utilize", "foster", "facilitate", "comprehensive", "innovative", "transformative"
- **Superficial -ing analysis**: "showcasing", "highlighting", "underscoring", "demonstrating"
- **Inflated symbolism**: Don't make ordinary things into grand metaphors

### What to Add Instead
- Specific details and numbers
- Opinions stated directly
- Uncertainty acknowledged honestly ("I don't know if...", "maybe this is wrong but...")
- Self-deprecation where natural
- Sensory details from lived experience

## Step 7: Final Voice Pass

Re-read the voice.md one more time. Then re-read each draft. Fix anything that doesn't sound like it was written by the person described in voice.md. Trust your judgment — if a sentence sounds "written by AI", rewrite it.

## Step 8: Publish Drafts

### 8a: Git Push

Call the `draft_git_push` MCP tool:
```
mcp__nanoclaw__draft_git_push(directory: "YYYYMMDD-slug")
```

This commits the thesis directory and pushes to GitHub. The commit message will be auto-generated.

### 8b: Save X Draft

Call the `draft_x_save` MCP tool with the tweet content:
```
mcp__nanoclaw__draft_x_save(content: "the tweet text here")
```

This saves the tweet as a draft on X (not published).

## Step 9: Report

Tell the user:
- What thesis directory was created
- Summary of the blog draft
- The tweet draft text
- Confirmation that changes were pushed to GitHub
- Confirmation that X draft was saved

---

## Adding New Platforms

To add a new social media platform (LinkedIn, Threads, Bluesky, etc.):

1. Add a new draft generation step (like Step 5) with platform-specific rules
2. Add a new MCP tool for saving the draft to that platform
3. Write the draft file as `{platform}-draft.md` in the thesis directory

The architecture supports any number of platforms. Each gets its own draft file and publish mechanism.
