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

Write `x-draft.md` in the thesis directory. This file contains **two tweets** separated by `---`:

1. **Hook tweet** (max 280 characters) — the standalone first tweet:
   - Distill the thesis to one punchy thought
   - Match the casual, first-person voice from voice.md
   - No hashtags unless they serve the content
   - Should stand alone — don't assume the reader knows the blog post
   - Can be provocative or surprising
   - **Never include the blog link** — that goes in the reply

2. **Link reply** (max 280 characters) — the self-reply that shares the blog URL:
   - Use a placeholder URL: `https://huynh.io/{slug}/`
   - Add a forward-looking note or honest status update, not just "link here"
   - Keep the same casual voice

Format:
```
Hook tweet text here.

---

Reply with link and context here: https://huynh.io/{slug}/
```

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

## Step 8: Header Image

Check the thesis directory for an existing header image:

```bash
ls /workspace/projects/pj/huynh.io/YYYYMMDD-slug/*.{jpg,jpeg,png,webp,gif} 2>/dev/null
```

**If an image file exists** (e.g., `header.jpg`, `header.png`):
- Note its full path — you'll pass it to `draft_ghost_publish` in Step 9b.

**If NO image file exists**:
1. Read `thesis.md` and `blog-draft.md` to understand the content
2. Suggest 2-3 image prompt ideas based on the post's theme. Keep prompts visual and concrete — describe a scene, mood, or composition, not the thesis itself. Examples:
   - For a post about dev tooling: "Minimal workspace with a single terminal window glowing blue against a dark background, soft bokeh lights"
   - For a post about writing: "Notebook open on a wooden desk, morning light casting long shadows, coffee cup nearby, shot from above"
3. Send the suggestions to the user via `send_message`:
   ```
   I didn't find a header image in the thesis directory. Want me to generate one?

   1. [prompt idea 1]
   2. [prompt idea 2]
   3. [prompt idea 3]

   Reply with a number, your own prompt, or "skip" to publish without a header image.
   ```
4. **Publish the Ghost draft without an image** (Step 9b) — don't block on the user's response
5. Include the Ghost post ID in the report so the user can add an image later

When the user replies with a number (1, 2, 3) or a custom prompt:
1. Generate the image using `generate_image` with `landscape_16_9` size, saving to the thesis directory with filename `header`
2. Call `draft_ghost_set_image` with the Ghost post ID and the generated image path
3. Also call `draft_git_push` again to push the new image to the repo

## Step 9: Publish Drafts

**CRITICAL: Do NOT run git commands (git add, git commit, git push) directly.** You are inside a container without SSH keys — git push will fail. All git operations must go through the MCP tool, which runs on the host where credentials exist.

### 9a: Git Push

Call the `draft_git_push` MCP tool:
```
mcp__nanoclaw__draft_git_push(directory: "YYYYMMDD-slug")
```

This handles git add, commit, AND push on the host side. The commit message will be auto-generated. Do not stage or commit files yourself — the tool does everything.

### 9b: Ghost Draft

Call the `draft_ghost_publish` MCP tool. If you found a header image in Step 8, pass its path:

```
mcp__nanoclaw__draft_ghost_publish(directory: "YYYYMMDD-slug", feature_image_path: "/workspace/projects/pj/huynh.io/YYYYMMDD-slug/header.jpg")
```

Without an image:
```
mcp__nanoclaw__draft_ghost_publish(directory: "YYYYMMDD-slug")
```

This calls the Ghost Admin API directly from the container — no IPC round-trip. It reads `blog-draft.md` from the thesis directory, extracts the title from the first `#` heading, and creates a draft post. **Save the post ID from the response** — you'll need it if the user wants to add a header image later.

### 9c: X/Twitter — Manual Only

**Do NOT try to save X drafts via any tool or MCP call.** X does not support draft saving via API or automation. The `x-draft.md` file is pushed to GitHub as part of Step 9a for the user to manually copy and post.

## Step 10: Report

Tell the user:
- What thesis directory was created
- Summary of the blog draft
- The full tweet text from `x-draft.md` (so they can copy it directly — do NOT say "check x-draft.md", just include the text)
- Confirmation that changes were pushed to GitHub
- Confirmation that Ghost draft was created (with URL and post ID)
- Whether a header image was included, or that they can reply with a prompt to generate one

---

## Adding New Platforms

To add a new social media platform (LinkedIn, Threads, Bluesky, etc.):

1. Add a new draft generation step (like Step 5) with platform-specific rules
2. Add a new MCP tool for saving the draft to that platform
3. Write the draft file as `{platform}-draft.md` in the thesis directory

The architecture supports any number of platforms. Each gets its own draft file and publish mechanism.
