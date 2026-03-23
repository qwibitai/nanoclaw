# Writing Infrastructure Build Plan

**Research writing tooling: Zotero integration, gptel, git workflow, agent drafting**

Date: March 20, 2026
Reference: RESEARCH_AGENT_ARCHITECTURE.md, SHOGGOTH_ARCHITECTURE.md

---

## Overview

Four builds, in dependency order. Each produces a working capability before moving to the next. Total estimated time: 1.5–2 focused days.

| Build | What it produces | Estimated time |
|-------|-----------------|----------------|
| 1. Zotero Integration | Agent can search library, add papers, retrieve citation keys | 1–2 hours |
| 2. gptel Research Preset | Tandem writing in Emacs with project-aware AI | 2–3 hours |
| 3. Git Writing Workflow | Project template, Overleaf bridge, agent branch pattern | 1–2 hours |
| 4. Agent Drafting Skill | Autonomous section drafting with commit workflow | 2–3 hours |

---

## Build 1: Zotero Integration

### Goal

The agent (Claude Code on VPS, or gptel in Emacs) can: search your Zotero library by keyword or DOI, create new items in Zotero from Semantic Scholar / OpenAlex results, and retrieve BibTeX citation keys for use in LaTeX.

### Architecture Decision: Which MCP Server?

Two viable options. Evaluate both quickly, commit to one.

**Option A: pyzotero's built-in MCP server**
- Pros: Mature library, write support via Web API, Semantic Scholar integration with dedup, CLI for manual use
- Cons: MCP server is newer/less battle-tested, fewer tools than 54yyyu
- Install: `uvx --from "pyzotero[mcp]" pyzotero-mcp`

**Option B: 54yyyu/zotero-mcp**
- Pros: Most feature-rich (semantic search, annotation extraction, fulltext indexing), active community
- Cons: Read-oriented (uses pyzotero under the hood, but write support less documented), pulls heavy ML deps for semantic search
- Install: `uv tool install "git+https://github.com/54yyyu/zotero-mcp.git"`

**Recommendation**: Start with pyzotero's MCP server. It's the thinnest layer over the well-documented pyzotero write API. If its search isn't good enough, add 54yyyu alongside it for read/search, keeping pyzotero for writes.

### Prerequisites

```bash
# On your Mac (one-time):
# 1. Get your Zotero user ID:
#    https://www.zotero.org/settings/keys → "Your userID for use in API calls"
#
# 2. Create an API key with read/write access:
#    https://www.zotero.org/settings/keys → "Create new private key"
#    Permissions: Allow library access (read/write), Allow notes access
#    Save the key securely.
#
# 3. Verify Better BibTeX is installed and auto-exporting:
#    Zotero → Settings → Better BibTeX → Automatic Export
#    Ensure your .bib file is being auto-exported to a known path.
#    Note the citation key format (default: [auth:lower][year])
```

### Build Steps

#### 1a. Install and test pyzotero MCP server (~20 min)

On the VPS (or wherever Claude Code runs):

```bash
# Install pyzotero with MCP support
uv tool install "pyzotero[mcp]"

# Test the CLI first (confirms connectivity)
pyzotero search "content moderation" --limit 5
pyzotero collections
```

If the CLI returns results from your library, the Web API connection works.

#### 1b. Register as MCP server for Claude Code (~10 min)

```bash
# Add to Claude Code's MCP config
claude mcp add-json "zotero" '{
  "command": "uvx",
  "args": ["--from", "pyzotero[mcp]", "pyzotero-mcp"],
  "env": {
    "ZOTERO_API_KEY": "YOUR_API_KEY",
    "ZOTERO_LIBRARY_ID": "YOUR_LIBRARY_ID"
  }
}'
```

Verify in Claude Code:
```
> List my Zotero collections
> Search my library for "hate speech detection"
> Show me the citation key for [a paper you know is in your library]
```

#### 1c. Test write operations (~15 min)

This is the critical test. In a Claude Code session or via pyzotero CLI/Python:

```python
from pyzotero import zotero
zot = zotero.Zotero('YOUR_LIBRARY_ID', 'user', 'YOUR_API_KEY')

# Get a template for a journal article
template = zot.item_template('journalArticle')
template['title'] = 'Test Paper for Agent Integration'
template['creators'] = [{'creatorType': 'author', 'firstName': 'Test', 'lastName': 'Author'}]
template['DOI'] = '10.1234/test.2026'
template['date'] = '2026'
template['publicationTitle'] = 'Test Journal'

# Create the item
resp = zot.create_items([template])
print(resp)  # Should show successful creation

# Verify it appeared
items = zot.items(q='Test Paper for Agent Integration')
print(items[0]['data']['key'])  # Zotero item key
```

Then check in Zotero on your Mac:
- Does the item appear after sync?
- Does Better BibTeX assign a citation key?
- Does the auto-exported .bib file update?

**Delete the test item after confirming.**

#### 1d. Build the citation key prediction function (~30 min)

The agent needs citation keys immediately after creating items, but Better BibTeX assigns them asynchronously on your Mac. Two approaches:

**Approach 1: Predict the key.** If your Better BibTeX format is `[auth:lower][year]` (the default), the agent can predict it:
- Author "Chen", year 2024 → `chen2024`
- If collision, Better BibTeX appends a letter → `chen2024a`

Write a small utility (Python or TypeScript) that:
1. Takes author last name + year
2. Checks the existing .bib for collisions (the .bib is in the project repo)
3. Returns the predicted key

**Approach 2: Use `[CITE:description]` placeholder.** The agent writes `\cite{CITE:chen-2024-platform-moderation}` and you resolve it later. Simpler, no prediction needed, but requires a manual step.

**Recommendation**: Use Approach 2 for new citations (safe, no wrong keys), Approach 1 for citations the agent finds in the .bib file (already resolved). The agent should always check the .bib first.

#### 1e. Connect to content registry (~15 min)

The pgvector content registry and Zotero serve different purposes:
- **Content registry**: Fast semantic search over literature. The agent's "memory" of the research landscape.
- **Zotero**: Canonical citation library. What you actually cite in papers.

When the content registry finds a paper the agent wants to cite:
1. Check if DOI exists in Zotero (pyzotero search by DOI)
2. If yes: retrieve the item, get the citation key from the `extra` field or predict it
3. If no: create the item in Zotero via Web API, use predicted key or placeholder

This logic should be encoded in the paper-drafting skill (Build 4), not in infrastructure.

### Verification Checklist

- [ ] pyzotero CLI can search your library from the VPS
- [ ] pyzotero MCP server registered in Claude Code
- [ ] Claude Code can search Zotero via MCP
- [ ] Write test: create an item via API, see it in Zotero desktop after sync
- [ ] Write test: created item gets a Better BibTeX citation key
- [ ] Write test: auto-exported .bib file updates with new entry
- [ ] Citation key retrieval works (either from .bib file or Zotero API)
- [ ] Test item deleted from library

---

## Build 2: gptel Research Writing Preset

### Goal

When editing a LaTeX file in Emacs, you can invoke a research-aware AI assistant that knows your writing preferences, the current project's context, and the available citation keys. Two primary interactions: (a) rewrite a selected region with gptel-rewrite, and (b) draft new text via gptel-send.

### Prerequisites

```bash
# Emacs packages needed:
# - gptel (you likely have this already)
# - gptel-quick (optional, for quick lookups)
#
# Verify gptel version — you need recent enough for presets and
# dynamic directive functions:
# M-x package-list-packages → check gptel version
# Or: M-x gptel-version
#
# Anthropic API key configured in auth-source or gptel-api-key
```

### Build Steps

#### 2a. Configure the Anthropic backend (~10 min)

If not already done. In your Emacs config (init.el or relevant config file):

```elisp
;; ~/.emacs.d/init.el or equivalent

(use-package gptel
  :ensure t
  :config
  ;; Anthropic backend
  (gptel-make-anthropic "Claude"
    :stream t
    :key #'gptel-api-key-from-auth-source  ;; or your preferred key method
    :models '(claude-sonnet-4-20250514
              claude-opus-4-20250514))

  ;; Set Claude Sonnet as default
  (setq gptel-model 'claude-sonnet-4-20250514
        gptel-backend (gptel-make-anthropic "Claude"
                        :stream t
                        :key #'gptel-api-key-from-auth-source
                        :models '(claude-sonnet-4-20250514
                                  claude-opus-4-20250514))))
```

Verify: open any buffer, `M-x gptel-send` with a simple prompt. You should get a streamed response from Claude.

#### 2b. Write the project context discovery functions (~45 min)

These elisp functions find and load context for the current writing project. Save in a dedicated file, e.g., `~/.emacs.d/lisp/gptel-research.el`:

```elisp
;;; gptel-research.el --- Research writing support for gptel -*- lexical-binding: t; -*-

(require 'gptel)

;; --- Configuration ---

(defvar gptel-research-vault-path "~/vault/"
  "Path to the Obsidian vault root.")

(defvar gptel-research-meta-files
  '("_meta/preferences.md")
  "Files from the vault _meta/ directory to include in the directive.
Only preferences.md by default — profile and top-of-mind are
available but often too much context for a writing session.")

(defvar gptel-research-max-bib-keys 200
  "Maximum number of .bib citation keys to include in the directive.")

;; --- Helper functions ---

(defun gptel-research--read-file (path)
  "Read file at PATH and return its contents as a string, or nil."
  (when (and path (file-exists-p path))
    (with-temp-buffer
      (insert-file-contents path)
      (buffer-string))))

(defun gptel-research--find-project-root ()
  "Find the project root for the current LaTeX file.
Looks for a directory containing CLAUDE.md, .git, or a Makefile,
walking up from the current file's directory."
  (when buffer-file-name
    (let ((dir (file-name-directory buffer-file-name)))
      (locate-dominating-file dir
        (lambda (d)
          (or (file-exists-p (expand-file-name "CLAUDE.md" d))
              (file-exists-p (expand-file-name "Makefile" d))
              (file-exists-p (expand-file-name ".git" d))))))))

(defun gptel-research--find-project-context ()
  "Find and read the project's CONTEXT.md from the vault.
Looks for a CLAUDE.md in the project root that might reference
a vault project, or searches Projects/ in the vault for a match."
  (let* ((root (gptel-research--find-project-root))
         ;; First, check for CLAUDE.md in the project itself
         (claude-md (when root
                      (gptel-research--read-file
                       (expand-file-name "CLAUDE.md" root))))
         ;; Also look for CONTEXT.md in the project directory
         (context-md (when root
                       (gptel-research--read-file
                        (expand-file-name "CONTEXT.md" root)))))
    (concat
     (when claude-md
       (concat "### Project Instructions (CLAUDE.md)\n" claude-md "\n\n"))
     (when context-md
       (concat "### Project Context (CONTEXT.md)\n" context-md "\n\n")))))

(defun gptel-research--extract-bib-keys ()
  "Extract citation keys from the project's .bib file.
Returns a string of keys, one per line, limited to
`gptel-research-max-bib-keys`."
  (let* ((root (gptel-research--find-project-root))
         (bib-files (when root
                      (directory-files root t "\\.bib$"))))
    (when bib-files
      (with-temp-buffer
        (dolist (f bib-files)
          (insert-file-contents f))
        (let ((keys '()))
          (goto-char (point-min))
          (while (re-search-forward "^@[a-zA-Z]+{\\([^,]+\\)," nil t)
            (push (match-string 1) keys))
          (setq keys (nreverse keys))
          (when (> (length keys) gptel-research-max-bib-keys)
            (setq keys (seq-take keys gptel-research-max-bib-keys)))
          (mapconcat #'identity keys "\n"))))))

(defun gptel-research--get-surrounding-context ()
  "Get the section structure around point for context.
Returns the current section heading and the headings of nearby sections."
  (when (derived-mode-p 'latex-mode 'LaTeX-mode)
    (save-excursion
      (let ((sections '()))
        ;; Find current and nearby section commands
        (goto-char (max (point-min) (- (point) 3000)))
        (while (re-search-forward
                "\\\\\\(section\\|subsection\\|subsubsection\\){\\([^}]+\\)}"
                (min (point-max) (+ (point) 6000)) t)
          (push (format "\\%s{%s}" (match-string 1) (match-string 2))
                sections))
        (when sections
          (mapconcat #'identity (nreverse sections) "\n"))))))

;; --- The directive function ---

(defun gptel-research-writing-directive ()
  "Generate a research writing system prompt from project context.
Reads vault _meta/ files, project CLAUDE.md/CONTEXT.md, and .bib keys."
  (let ((preferences
         (mapconcat
          (lambda (f)
            (gptel-research--read-file
             (expand-file-name f gptel-research-vault-path)))
          gptel-research-meta-files
          "\n"))
        (project-context (gptel-research--find-project-context))
        (bib-keys (gptel-research--extract-bib-keys))
        (section-context (gptel-research--get-surrounding-context)))
    (concat
     "You are a research writing assistant for a computational social "
     "scientist working in LaTeX. You produce substantive academic prose.\n\n"

     (when (and preferences (not (string-empty-p preferences)))
       (concat "## Writer Preferences\n" preferences "\n\n"))

     (when (and project-context (not (string-empty-p project-context)))
       (concat "## Project Context\n" project-context "\n\n"))

     (when (and section-context (not (string-empty-p section-context)))
       (concat "## Document Structure Near Cursor\n"
               section-context "\n\n"))

     (when (and bib-keys (not (string-empty-p bib-keys)))
       (concat "## Available Citation Keys\n"
               "These BibTeX keys are in the project .bib file. "
               "Use \\cite{key} when referencing them. "
               "If citing a paper not in this list, write "
               "[CITE: author year description] as a placeholder.\n\n"
               bib-keys "\n\n"))

     "## Writing Rules\n"
     "- Write in LaTeX. Match the style and conventions of the "
     "existing manuscript.\n"
     "- Produce first drafts that capture the analytical argument "
     "clearly. Do not over-polish.\n"
     "- Use \\cite{key} with real BibTeX keys from the list above.\n"
     "- For papers not in the .bib, use [CITE: description] placeholders.\n"
     "- When revising, preserve the author's voice. Fix the argument, "
     "not the style.\n"
     "- Be specific. Avoid vague academic hedging unless the claim "
     "genuinely warrants it.\n"
     "- Do not add \\begin{document}, preamble, or package imports "
     "unless explicitly asked.\n")))

;; --- Presets ---

(gptel-make-preset 'research-writing
  :description "Research paper writing with project context"
  :system #'gptel-research-writing-directive
  :model 'claude-sonnet-4-20250514
  :max-tokens 4096)

(gptel-make-preset 'research-heavy
  :description "Complex writing tasks — Opus model"
  :system #'gptel-research-writing-directive
  :model 'claude-opus-4-20250514
  :max-tokens 8192)

;; --- Convenience commands ---

(defun gptel-research-rewrite-region ()
  "Rewrite the selected region using the research writing preset."
  (interactive)
  (let ((gptel-model 'claude-sonnet-4-20250514)
        (gptel--system-message (gptel-research-writing-directive)))
    (call-interactively #'gptel-rewrite)))

(defun gptel-research-draft ()
  "Open a gptel buffer with research context pre-loaded."
  (interactive)
  (let* ((root (gptel-research--find-project-root))
         (buf (gptel "* Research Draft *")))
    (with-current-buffer buf
      (setq-local gptel-model 'claude-sonnet-4-20250514)
      (setq-local gptel--system-message
                  (gptel-research-writing-directive))
      (when root
        (setq-local default-directory root))
      (insert "Draft request: \n")
      (goto-char (- (point) 1)))))

;; --- Key bindings (customize to taste) ---

;; These go under a prefix; adjust to your keymap.
;; Example using C-c g as a gptel prefix:
;;
;; (define-key latex-mode-map (kbd "C-c g r") #'gptel-research-rewrite-region)
;; (define-key latex-mode-map (kbd "C-c g d") #'gptel-research-draft)
;; (define-key latex-mode-map (kbd "C-c g a") #'gptel-add)

(provide 'gptel-research)
;;; gptel-research.el ends here
```

#### 2c. Load and test (~30 min)

```elisp
;; In your init.el, after gptel config:
(add-to-list 'load-path "~/.emacs.d/lisp/")
(require 'gptel-research)

;; Customize paths:
(setq gptel-research-vault-path "~/vault/")  ;; adjust to your vault
```

**Test sequence:**

1. Open a .tex file in an existing project that has a .bib file
2. `M-: (gptel-research--find-project-root)` → should return the project directory
3. `M-: (gptel-research--extract-bib-keys)` → should return citation keys
4. `M-: (gptel-research-writing-directive)` → should return a full system prompt
5. Select a paragraph, `M-x gptel-research-rewrite-region` → should propose a revision
6. `M-x gptel-research-draft` → should open a draft buffer with context loaded
7. In any LaTeX buffer, type a prompt ending with `@research-writing` then `C-c RET` → should use the preset

**Test the rewrite flow specifically:**
1. Select a weak paragraph in a real paper
2. `M-x gptel-research-rewrite-region`
3. gptel should present the revision as a diff (ediff)
4. Accept/reject hunks as you would with version control

#### 2d. Iterate on the directive (~30 min)

The directive function is the highest-iteration-surface piece. After testing:

- Is the system prompt too long? (Check token count — the .bib keys might bloat it)
  - Fix: reduce `gptel-research-max-bib-keys` or only include keys from `\cite{}` commands in the current file
- Does the AI respect your writing style?
  - Fix: add more specific instructions to `_meta/preferences.md`
- Does it use real citation keys correctly?
  - Fix: adjust the citation key instruction section
- Is Opus worth the cost for rewrite tasks?
  - Fix: Sonnet for rewrites, Opus for drafting new sections only

### Verification Checklist

- [ ] Anthropic backend configured and working in gptel
- [ ] `gptel-research.el` loaded without errors
- [ ] Project root detection works for at least one project
- [ ] .bib citation key extraction works
- [ ] Dynamic directive function generates a sensible system prompt
- [ ] `gptel-research-rewrite-region` works on a selected LaTeX region
- [ ] Rewrite presents as ediff (accept/reject hunks)
- [ ] `gptel-research-draft` opens a buffer with context
- [ ] `@research-writing` preset works via gptel-send
- [ ] Citation keys are used correctly in AI output
- [ ] Preferences from `_meta/preferences.md` are reflected in output

---

## Build 3: Git Writing Workflow

### Goal

A standardized project structure and git workflow that supports: solo writing in Emacs, collaborative editing in Overleaf, and agent drafting on the VPS — all using the same repository.

### The Project Template

#### 3a. Create a template repository (~30 min)

```bash
mkdir -p ~/templates/paper-template
cd ~/templates/paper-template
git init

mkdir -p sections figures tables
```

Create the template files:

**`main.tex`** — minimal, uses `\input{}` for sections:
```latex
\documentclass[12pt]{article}

% --- Packages ---
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{hyperref}
\usepackage{natbib}  % or biblatex, per your preference
% Add project-specific packages below this line

% --- Metadata ---
\title{TITLE}
\author{AUTHOR}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
\input{sections/abstract}
\end{abstract}

\input{sections/introduction}
\input{sections/literature}
\input{sections/methods}
\input{sections/results}
\input{sections/discussion}
\input{sections/conclusion}

\bibliographystyle{apalike}  % adjust per venue
\bibliography{refs}

\end{document}
```

**`sections/introduction.tex`** — starter with commented structure:
```latex
\section{Introduction}

% Motivation: why does this problem matter?

% Gap: what's missing from existing work?

% Contribution: what does this paper do?

% Roadmap: how is the paper organized?
```

(Create similar stubs for each section file.)

**`CLAUDE.md`** — agent instructions template:
```markdown
# [Paper Title] — Agent Instructions

## What This Is
[One paragraph describing the paper, its argument, and its contribution.]

## How To Build
- Compile: `make` or `latexmk -pdf main`
- Clean: `make clean` or `latexmk -C`
- Watch: `make watch` or `latexmk -pdf -pvc main`

## Project Structure
- main.tex — document root, imports sections
- sections/ — one .tex file per major section
- figures/ — all figures (PDF, PNG)
- tables/ — standalone table files if needed
- refs.bib — Better BibTeX auto-export (do not edit manually)

## Writing Conventions
- [Describe citation style: \cite, \citet, \citep, etc.]
- [Describe any formatting conventions]
- [List key terms or definitions]

## Current Analytical Goals
See vault Projects/[name]/CONTEXT.md for what we're trying to show
in the current revision.

## Constraints
- Never edit refs.bib directly — it's auto-exported by Better BibTeX
- Never modify raw data files
- Use [CITE: description] for papers not yet in the .bib
- Commit to agent/* branches only, never to master/main
```

**`Makefile`**:
```makefile
MAIN = main

.PHONY: all clean watch

all:
	latexmk -pdf $(MAIN)

watch:
	latexmk -pdf -pvc $(MAIN)

clean:
	latexmk -C

# Compile and open (macOS)
open: all
	open $(MAIN).pdf

# Word count (approximate, strips LaTeX)
wc:
	@detex $(MAIN).tex | wc -w
```

**`.latexmkrc`**:
```perl
$pdf_mode = 1;
$bibtex_use = 2;
$pdflatex = 'pdflatex -interaction=nonstopmode -synctex=1 %O %S';
$clean_ext = 'bbl rel %R-blx.bib %R.synctex.gz';
```

**`.gitignore`**:
```
# LaTeX build artifacts
*.aux
*.bbl
*.blg
*.fdb_latexmk
*.fls
*.log
*.out
*.synctex.gz
*.toc
*.lof
*.lot
*.run.xml
*-blx.bib

# OS
.DS_Store

# Editor
*~
\#*\#
.#*
```

Commit: `git add -A && git commit -m "initial paper template"`

#### 3b. New solo project workflow (~15 min to document)

```bash
# 1. Create project from template
cp -r ~/templates/paper-template ~/projects/new-paper
cd ~/projects/new-paper
rm -rf .git && git init

# 2. Configure Better BibTeX export
#    In Zotero: File → Export Library (or collection)
#    Format: Better BibTeX
#    Check "Keep updated"
#    Export to: ~/projects/new-paper/refs.bib

# 3. Edit CLAUDE.md with project-specific details

# 4. Create vault project context
mkdir -p ~/vault/Projects/new-paper
cat > ~/vault/Projects/new-paper/CONTEXT.md << 'EOF'
# New Paper

## What This Is
[Description]

## Core Argument
[The main claim and how you'll support it]

## Key References
[The 3-5 papers this is in conversation with]

## Status
Draft — working on introduction
EOF

cat > ~/vault/Projects/new-paper/STATUS.md << 'EOF'
# New Paper — Status

## Current Phase
Early drafting

## Next Actions
- [ ] Draft introduction
- [ ] Outline methods section

## Blockers
None
EOF

# 5. Initial commit
cd ~/projects/new-paper
git add -A
git commit -m "initial project setup"
```

#### 3c. New collaborative project workflow (Overleaf) (~15 min to document)

```bash
# 1. Clone from Overleaf
#    Get the git URL from Overleaf: Menu → Git
git clone https://git.overleaf.com/PROJECT_ID ~/projects/collab-paper
cd ~/projects/collab-paper

# 2. Set up git credentials for Overleaf
#    Generate token: Overleaf Account Settings → Git Integration
#    Configure credential helper so you don't re-enter every time:
git config credential.helper store
#    (On first push/pull, enter username "git" and the token as password)

# 3. Add CLAUDE.md and .claude/ to the project
#    (Co-authors will see these but they're harmless .md files)
cp ~/templates/paper-template/CLAUDE.md .
cp ~/templates/paper-template/.gitignore .
#    Edit CLAUDE.md with project-specific details

# 4. Optionally, add a second remote for backup:
git remote add github git@github.com:you/collab-paper.git

# 5. Configure Better BibTeX to export to this project's .bib
#    (Same as solo project)

# 6. Create vault project context (same as solo)
mkdir -p ~/vault/Projects/collab-paper
# Write CONTEXT.md and STATUS.md

# 7. Commit the additions
git add -A
git commit -m "add agent instructions and project config"
git push origin master  # pushes to Overleaf
```

#### 3d. Agent branch workflow (~15 min to document)

This is the pattern for agent-written changes flowing into the project:

```bash
# --- ON THE VPS (agent working) ---

# Pull latest from origin (Overleaf or GitHub)
cd ~/projects/collab-paper
git pull origin master

# Create agent branch
git checkout -b agent/draft-results-$(date +%Y%m%d)

# Agent does its work: edits .tex files, commits
# (This happens inside a Claude Code session)

git add sections/results.tex
git commit -m "draft: results section based on sweep analysis"

# Agent does NOT push to origin
# Agent does NOT merge to master

# --- ON YOUR MAC (reviewing) ---

# If using Syncthing: changes are already visible
# If using git: fetch from VPS
git fetch vps  # assuming you added vps as a remote
# Or pull agent branch specifically:
git fetch origin  # if agent pushed to a shared remote

# Review the diff
git diff master..agent/draft-results-20260320

# If it looks good, merge
git checkout master
git merge agent/draft-results-20260320
# Or cherry-pick specific commits:
git cherry-pick abc123

# Edit in Emacs — revise the draft
# Then commit and push
git add -A
git commit -m "revised agent draft of results section"
git push origin master  # pushes to Overleaf
```

**Important Overleaf constraint:** Overleaf only supports the `master` branch. Agent branches are local or on a non-Overleaf remote only. You always merge to master before pushing to Overleaf.

#### 3e. Sync strategy for VPS access (~15 min)

The VPS needs access to the project repo for agent drafting. Options:

**Option A: Git-based (recommended for Overleaf projects)**
```bash
# On VPS, clone the same Overleaf repo:
git clone https://git.overleaf.com/PROJECT_ID ~/projects/collab-paper
# Agent pulls before working, creates branches, commits
# You pull agent branches to your Mac via a shared remote (GitHub)
# or via Syncthing syncing the .git directory
```

**Option B: Syncthing (recommended for solo projects)**
```bash
# Syncthing syncs ~/projects/ between Mac and VPS bidirectionally
# Agent and researcher share the same filesystem
# Git handles conflicts via branches
```

**Option C: Hybrid**
- Syncthing for the vault (always bidirectional)
- Git for project repos (explicit push/pull)

### Verification Checklist

- [ ] Template repository created with all files
- [ ] Solo project workflow tested: create project, compile, commit
- [ ] Overleaf project cloned and git push/pull working
- [ ] Agent branch workflow tested: create branch, commit, merge to master, push
- [ ] Better BibTeX exporting to project's refs.bib
- [ ] VPS has access to at least one project repo
- [ ] CLAUDE.md written for at least one real project
- [ ] Vault CONTEXT.md and STATUS.md created for at least two projects

---

## Build 4: Agent Drafting Skill

### Goal

A skill file and workflow that enables Claude Code (on VPS) to autonomously draft or revise LaTeX sections, commit to an agent branch, and notify you. The agent reads vault context, project CLAUDE.md, existing manuscript sections, and the .bib file.

### Prerequisites

- Build 1 complete (Zotero MCP working)
- Build 3 complete (git workflow established, project repos accessible on VPS)
- At least one real project with CLAUDE.md, CONTEXT.md, and refs.bib

### Build Steps

#### 4a. Write the paper-drafting skill (~1 hour)

Create `.claude/skills/paper-drafting/SKILL.md` in the workspace directory on the VPS:

```markdown
# Paper Drafting

## When to Use
When the researcher asks to draft, revise, or extend a section of a
paper. This includes:
- "Draft the introduction for [project]"
- "Rewrite section 3.2"
- "Extend the methods to cover [new approach]"
- "Write up the results from [analysis]"

## Before Writing

1. **Read the project's CLAUDE.md** in the project root. This tells
   you how the project is structured, what conventions to follow,
   and what the current analytical goals are.

2. **Read the vault context** for this project:
   - `_meta/researcher-profile.md` — who the researcher is
   - `_meta/preferences.md` — writing style preferences
   - `Projects/<name>/CONTEXT.md` — what this paper argues
   - `Projects/<name>/STATUS.md` — current state and goals

3. **Read existing manuscript sections** to match style, voice,
   and argument flow. Never write in isolation — your draft must
   connect to what comes before and after.

4. **Read refs.bib** to know which citation keys are available.
   Use `\cite{key}` for papers in the .bib. For papers you want
   to cite but aren't in the .bib, write `[CITE: author year
   brief description]` — the researcher will resolve these.

5. **Search the content registry** (if available via MCP) for
   relevant papers to cite. If you find something important that
   isn't in the .bib, note it with the [CITE:] placeholder and
   optionally add it to Zotero via the Zotero MCP server.

## Writing Rules

- **Ugly first drafts.** Capture the analytical argument clearly
  and correctly. Do not polish prose. Do not optimize for elegance.
  The researcher revises in Emacs.

- **Real citations only.** Never invent citation keys. Every
  `\cite{}` must reference a key in refs.bib. Use [CITE:] for
  anything else.

- **Match the voice.** Read the existing sections. Match their
  register, formality, and conventions. If the paper uses "we",
  use "we". If it uses passive voice, use passive voice.

- **Structural clarity.** Use clear topic sentences. Each paragraph
  should make one point. Connect paragraphs with explicit transitions.

- **Be specific.** Replace "the literature suggests" with
  "\\citet{smith2024} find that..." Replace "recent work" with
  specific citations. Replace "significant" with effect sizes
  or concrete descriptions.

- **LaTeX conventions.** Write in the project's LaTeX style.
  Use `\input{}` for sections. Use the project's citation
  command style (`\cite`, `\citet`, `\citep`, etc. — check
  existing files).

- **No preamble or wrappers.** Don't add `\begin{document}`,
  package imports, or section numbering unless the existing
  files use them. Write content that drops into the existing
  structure.

## Git Workflow

1. Before starting, pull the latest from origin:
   `git pull origin master`

2. Create an agent branch:
   `git checkout -b agent/<description>-$(date +%Y%m%d)`

3. Make changes to .tex files.

4. Commit with a descriptive message:
   `git add sections/<file>.tex`
   `git commit -m "draft: <what was written and why>"`

5. **Never push to origin.** Never merge to master.
   The researcher reviews and merges.

6. If multiple sections or rounds of revision, make
   separate commits for each logical change.

## After Writing

Report to the researcher (via Discord or terminal output):
- What you drafted/revised and why
- Which citations you used (especially any [CITE:] placeholders)
- What you're unsure about or what needs the researcher's judgment
- The branch name so they can review: `agent/<name>`
```

#### 4b. Write the literature search subagent (~30 min)

Create `.claude/agents/literature-researcher.md` (if not already done in the research agent architecture build):

```markdown
---
name: literature-researcher
description: >
  Search academic literature for a research question. Checks the
  content registry, Semantic Scholar, and OpenAlex. Returns a
  structured landscape summary with citation keys where available.
tools:
  - Read
  - Grep
  - mcp__zotero__*
  - mcp__content_registry__*
model: sonnet
---

You are an academic literature researcher supporting a computational
social scientist.

When given a research question or topic:

1. Search the content registry (pgvector) for already-indexed papers
2. Search Semantic Scholar and OpenAlex for recent additions
3. For each relevant paper found, check if it exists in Zotero
4. Return a structured summary:
   - Key papers with citation keys (if in Zotero) or full references
   - Major findings and debates
   - Methodological approaches
   - Gaps in the literature

Keep summaries concise. Focus on what's relevant to the specific
question asked, not a comprehensive review.
```

#### 4c. Create a session launch script (~15 min)

For autonomous drafting from the VPS:

```bash
#!/bin/bash
# scripts/agent-draft.sh
# Usage: ./scripts/agent-draft.sh <project-name> "<drafting instruction>"

set -e

PROJECT_NAME="$1"
INSTRUCTION="$2"
PROJECT_DIR="$HOME/projects/$PROJECT_NAME"
VAULT_DIR="$HOME/vault"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

if [ -z "$PROJECT_NAME" ] || [ -z "$INSTRUCTION" ]; then
  echo "Usage: $0 <project-name> \"<instruction>\""
  exit 1
fi

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project directory not found: $PROJECT_DIR"
  exit 1
fi

cd "$PROJECT_DIR"

# Pull latest
git pull origin master 2>/dev/null || true

# Run Claude Code with the drafting skill
claude -p \
  --allowedTools "Read,Write,Edit,Bash(git:*),Bash(latexmk:*),Bash(cat:*),Bash(ls:*),Bash(grep:*),mcp__*" \
  "Read .claude/skills/paper-drafting/SKILL.md for your writing instructions.
Read CLAUDE.md for project-specific instructions.
Read $VAULT_DIR/_meta/preferences.md for writing preferences.
Read $VAULT_DIR/Projects/$PROJECT_NAME/CONTEXT.md for project context.

Your task: $INSTRUCTION

Follow the git workflow in the skill: create an agent branch, commit your work.
Report what you did and any [CITE:] placeholders that need resolution." \
  2>&1 | tee "$HOME/logs/draft_${PROJECT_NAME}_${TIMESTAMP}.log"
```

Make it executable: `chmod +x scripts/agent-draft.sh`

Usage:
```bash
./scripts/agent-draft.sh platform-abm \
  "Draft the results section. The key findings are in outputs/sweep_results.csv. Focus on the relationship between moderation threshold and user retention."
```

#### 4d. Test the full pipeline (~30 min)

**Test 1: Simple section draft**
```bash
# On VPS, with a real project:
cd ~/projects/some-paper
claude --resume drafting-test

# In the Claude Code session:
> Read .claude/skills/paper-drafting/SKILL.md
> Read CLAUDE.md
> Draft a two-paragraph introduction for this paper.
> Follow the git workflow: create an agent branch and commit.
```

Verify:
- [ ] Agent created an `agent/` branch
- [ ] The draft is in valid LaTeX
- [ ] Citation keys from refs.bib are used correctly
- [ ] Commit message is descriptive
- [ ] Agent did NOT push or merge to master

**Test 2: Review and merge on Mac**
```bash
# On Mac:
cd ~/projects/some-paper
git fetch  # or wait for Syncthing
git log --oneline --all  # see the agent branch
git diff master..agent/draft-intro-20260320
# Review in Emacs:
# emacsclient sections/introduction.tex
# Revise, then:
git checkout master
git merge agent/draft-intro-20260320
git add -A
git commit -m "revised agent draft of introduction"
```

**Test 3: Citation handling**
- Does the agent use real `\cite{key}` for papers in refs.bib?
- Does it use `[CITE: description]` for papers not in the .bib?
- If Zotero MCP is available, does it check/add papers?

### Verification Checklist

- [ ] paper-drafting skill file created and readable by Claude Code
- [ ] literature-researcher subagent file created
- [ ] agent-draft.sh script works for a simple task
- [ ] Agent reads CLAUDE.md and vault context before writing
- [ ] Agent creates agent/ branches and commits properly
- [ ] Agent does not push or merge to master
- [ ] LaTeX output is valid and compiles
- [ ] Real citation keys used from refs.bib
- [ ] [CITE:] placeholders used for missing citations
- [ ] Review-and-merge workflow tested on Mac
- [ ] Merged result compiles and pushes to Overleaf (if collaborative)

---

## Post-Build: Daily Writing Workflow

Once all four builds are complete, the daily workflow looks like this:

### Solo writing session (Emacs)

1. Open the .tex file in Emacs
2. Write normally with AUCTeX
3. When stuck on a paragraph: select it, `M-x gptel-research-rewrite-region`
4. Review the diff in ediff, accept/reject hunks
5. When you need a new section drafted: `M-x gptel-research-draft`, describe what you need, yank the result into your file
6. When you need literature: ask gptel to suggest citations, or use the content registry via Claude Code in a terminal pane
7. Compile with `make` or `latexmk`, commit when satisfied

### Agent drafting session (VPS)

1. `./scripts/agent-draft.sh paper-name "Draft the methods section"`
2. Wait for completion (or do other work)
3. Review the agent branch on your Mac
4. Merge what works, revise in Emacs
5. Push to Overleaf if collaborative

### Finding and citing new papers

1. Agent searches Semantic Scholar / OpenAlex / content registry
2. Agent adds relevant papers to Zotero via Web API
3. Zotero syncs to Mac, Better BibTeX updates refs.bib
4. On next compile, new citations are available
5. Replace any [CITE:] placeholders with real keys

---

## Open Questions

- **gptel tool use**: gptel now supports MCP integration via mcp.el. Could the content registry and Zotero MCP servers be available directly in Emacs? Worth investigating after the basic preset is working.

- **Prism for specific projects**: If a project benefits from GPT-5.2's strengths (math-heavy, or a collaborator prefers it), Prism can coexist. The .tex source would live in Prism instead of Overleaf for that project, with git export for local work. No need to decide now.

- **Latexdiff for agent review**: Instead of raw `git diff`, `latexdiff` produces a compiled PDF showing changes. Could be integrated into the review step:
  ```bash
  latexdiff master.tex agent.tex > diff.tex
  latexmk -pdf diff.tex
  ```

- **Better BibTeX sync latency**: If the delay between adding to Zotero and the .bib updating causes friction, consider running a cron job that checks for .bib staleness and triggers a Zotero sync + BibTeX export.
