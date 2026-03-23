# Writing Workflow

How papers get written across Mac, VPS, and Overleaf.

---

## Project Setup

### New solo project (code + paper)

```bash
# On the VPS or Mac:
cp -r ~/shoggoth/templates/research-project ~/projects/new-paper
cd ~/projects/new-paper
git init

# Edit pyproject.toml with project name/description
# Copy CLAUDE.md template and fill in project details:
cp ~/shoggoth/templates/CLAUDE.md.template CLAUDE.md

# Create vault project context:
mkdir -p ~/obsidian-notes/projects/new-paper
# Write PROJECT.md following the template in SHOGGOTH_ARCHITECTURE.md

# Configure Better BibTeX export (on Mac):
#   Zotero → right-click collection → Export Collection
#   Format: Better BibTeX
#   Check "Keep updated"
#   Export to: ~/projects/new-paper/draft/refs.bib

git add -A
git commit -m "initial project setup"
```

### New paper-only project

```bash
cp -r ~/shoggoth/templates/paper-only ~/projects/new-paper
cd ~/projects/new-paper
git init
cp ~/shoggoth/templates/CLAUDE.md.template CLAUDE.md
# Edit CLAUDE.md, main.tex metadata, refs.bib export target
git add -A
git commit -m "initial project setup"
```

### New collaborative project (Overleaf)

Overleaf syncs via GitHub — not direct git clone. This keeps one source of
truth and lets the agent work on branches in the same repo.

```bash
# 1. Create the project in Overleaf, write initial content there

# 2. In Overleaf: Menu → Sync → GitHub → create a GitHub repo
#    This gives you a repo like github.com/you/paper-title

# 3. Clone from GitHub (not Overleaf):
git clone git@github.com:you/paper-title.git ~/projects/paper-title
cd ~/projects/paper-title

# 4. Add agent instructions:
cp ~/shoggoth/templates/CLAUDE.md.template CLAUDE.md
# Edit CLAUDE.md with project-specific details
git add CLAUDE.md
git commit -m "add agent instructions"
git push origin main

# 5. In Overleaf: Menu → Sync → GitHub → pull from GitHub
#    Overleaf now sees CLAUDE.md (harmless .md file to co-authors)

# 6. Create vault project context (same as solo)
```

**Sync flow:**
```
Overleaf ←→ GitHub ←→ VPS (agent branches)
                  ←→ Mac (Emacs editing)
```

Overleaf only sees `main`. Agent branches live on GitHub and locally.
The researcher merges agent work to `main`, then Overleaf picks it up
on next sync.

---

## Agent Branch Workflow

The agent never pushes to `main`. All agent work happens on branches.

### On the VPS (agent working):

```bash
cd ~/projects/paper-name

# Pull latest
git pull origin main

# Create agent branch
git checkout -b agent/draft-results-$(date +%Y%m%d)

# Agent edits .tex files, commits
git add draft/sections/results.tex
git commit -m "draft: results section — moderation threshold vs retention"

# Agent does NOT push to main
# Agent does NOT merge to main
# Agent CAN push the branch to origin for review:
git push -u origin agent/draft-results-$(date +%Y%m%d)
```

### On your Mac (reviewing):

```bash
cd ~/projects/paper-name
git fetch origin

# See what the agent did
git log --oneline main..origin/agent/draft-results-20260323
git diff main..origin/agent/draft-results-20260323

# Review in Emacs, then merge what works
git checkout main
git merge origin/agent/draft-results-20260323
# Or cherry-pick specific commits:
git cherry-pick abc123

# Revise the draft in Emacs
# Commit and push
git add -A
git commit -m "revised agent draft of results section"
git push origin main

# For Overleaf projects: sync in Overleaf UI (Menu → Sync → GitHub)
```

### Branch naming convention

```
agent/<description>-<YYYYMMDD>
```

Examples:
- `agent/draft-introduction-20260323`
- `agent/revise-methods-20260325`
- `agent/add-citations-lit-review-20260326`

---

## Sync Strategy

### Vault (Obsidian notes)

Already synced bidirectionally between Mac and VPS via Syncthing.
Both the researcher and agents read/write vault notes.
Path: `~/obsidian-notes/` on VPS, vault on Mac.

### Project repos

Two options depending on the project:

**GitHub-based (recommended for collaborative / Overleaf projects):**
- GitHub is the shared remote
- Mac and VPS both clone from GitHub
- Agent pushes branches to GitHub
- Researcher merges on Mac, pushes to GitHub
- Overleaf syncs with GitHub

**Syncthing-based (for solo projects that don't need Overleaf):**
- Syncthing syncs `~/projects/<name>` between Mac and VPS
- Git handles conflicts via branches
- No GitHub needed unless you want backup

### Better BibTeX → refs.bib

The .bib file lives in the project repo (at root for paper-only, at
`draft/refs.bib` for research-project). Better BibTeX on your Mac
auto-exports to this path. The file reaches the VPS via git push or
Syncthing.

If the agent adds a paper to Zotero via the Web API:
1. Zotero cloud syncs to your Mac
2. Better BibTeX assigns a citation key
3. Auto-export updates refs.bib
4. refs.bib reaches VPS on next git pull or Syncthing cycle

Until the .bib updates, the agent uses `[CITE: author year description]`
placeholders.

---

## Daily Writing Workflow

### Solo writing session (Emacs on Mac)

1. Open the .tex file in Emacs
2. Write normally with AUCTeX
3. When stuck: select a paragraph, use gptel-research-rewrite-region
4. Review the diff in ediff, accept/reject hunks
5. For new sections: use gptel-research-draft, describe what you need
6. For literature: ask gptel or use the content registry via Claude Code
7. Compile with `make`, commit when satisfied

### Agent drafting session (VPS)

1. Tell the agent (via WhatsApp or Claude Code) what to draft
2. Agent creates a branch, writes LaTeX, commits
3. Review the branch on your Mac
4. Merge what works, revise in Emacs
5. Push to GitHub; sync Overleaf if collaborative

### Finding and citing new papers

1. Agent searches Semantic Scholar / OpenAlex / content registry
2. Agent adds relevant papers to Zotero via zotero-cli
3. Zotero syncs to Mac, Better BibTeX updates refs.bib
4. On next compile, new citations are available
5. Replace any [CITE:] placeholders with real \cite{key}
