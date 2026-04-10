---
name: research
description: |
  Conduct comprehensive research across multiple sources - codebase, web,
  and documentation - by spawning parallel sub-agents and synthesizing findings.
  Searches past learnings first, then codebase, docs, and optionally web.
user-invocable: true
---

# Research

You are tasked with conducting comprehensive research across multiple sources - codebase, web, and documentation - by spawning parallel sub-agents and synthesizing their findings.

## Initial Setup

When this command is invoked, respond with:
```
I'm ready to conduct comprehensive research. Please provide your research question or area of interest.

I can research:
- Codebase: Find implementations, patterns, and architecture
- Documentation: Discover existing docs and decisions
- Web: External resources, best practices, and solutions (if requested)

What would you like me to investigate?
```

Then wait for the user's research query.

## Research Process

### Step 1: Read Mentioned Files First

**CRITICAL**: If the user mentions specific files, read them FULLY first:
- Use the Read tool WITHOUT limit/offset parameters
- Read these files yourself in the main context before spawning any sub-tasks
- This ensures you have full context before decomposing the research

### Step 2: Analyze and Decompose

- Break down the query into composable research areas
- Think deeply about underlying patterns, connections, and architectural implications
- Identify specific components, patterns, or concepts to investigate
- Create a research plan using TodoWrite to track all subtasks
- Consider which directories, files, or architectural patterns are relevant

### Step 3: Spawn Parallel Research Tasks

Create multiple Task agents to research different aspects concurrently. Think deeply about the query to determine which types of research are needed.

**Research Types to Consider:**

**E. Learnings Research (ALWAYS do this FIRST):**

Before diving into codebase research, check if we've solved similar problems before.

```bash
# Search local docs/solutions/ for relevant past learnings
~/.claude/utils/search-learnings.sh "[query keywords]"

# Search with category filter
~/.claude/utils/search-learnings.sh -c build-errors "[error keywords]"

# Search with tag filter
~/.claude/utils/search-learnings.sh -t rust -t async "[query]"
```

**What to Search:**
- Error messages (exact or partial)
- Technology/framework names
- Problem descriptions
- Symptom keywords

**What to Extract:**
- `key_insight`: THE ONE THING that fixes the problem
- `root_cause`: Understanding why it happened
- `solution`: Steps to resolve
- Related learnings for broader context

**Critical Patterns:**
Always check `docs/solutions/patterns/critical-patterns.md` for patterns that apply to the current task. These are "Required Reading" that prevent common mistakes.

```
Task: "Search past learnings for [topic]"
- Run search-learnings.sh with relevant keywords
- Search by symptoms, tags, category
- Return key_insight field prominently
- Local results take priority over global
- Check critical-patterns.md for applicable patterns
```

**If Global Learnings Available:**
When a `global-learnings` repository is cloned (usually at `~/.claude/global-learnings/`):
```bash
# Graph-based search (finds related concepts via graph traversal)
learnings search "[query]" --mode local --format json

# Vector-only search (faster, exact symptom matching)
learnings search "[error message]" --mode naive --format json

# Get critical patterns for language/domain
learnings critical-patterns --language rust --domain backend
```

Search modes:
- `naive`: Vector similarity only (fast, good for exact error messages)
- `local`: Entity neighborhood search (finds related concepts via graph)
- `global`: Community-based search (broad patterns across all learnings)

---

**A. Codebase Research (always do this):**
```
Task: "Find all files related to [topic]"
- Search for relevant source files, configs, tests
- Identify main implementation files
- Find usage examples and patterns
- Return specific file:line references

Task: "Analyze how [system/feature] works"
- Understand current implementation
- Trace data flow and dependencies
- Identify conventions and patterns
- Return detailed explanations with code references

Task: "Find similar implementations of [pattern]"
- Look for existing examples to model after
- Identify reusable components
- Find test patterns to follow
```

**B. Documentation Research (if relevant):**
```
Task: "Find existing documentation about [topic]"
- Search README files, docs directories
- Look for architecture decision records (ADRs)
- Find API documentation
- Check inline code comments for important notes

Task: "Extract insights from documentation"
- Synthesize key decisions and rationale
- Identify constraints and requirements
- Find historical context
```

**C. Web Research (if explicitly requested or needed):**
```
Task: "Research best practices for [technology/pattern]"
- MUST use WebSearch tool explicitly (not internal knowledge)
- Find official documentation
- Discover community solutions
- Identify common pitfalls and solutions
- MUST return specific URLs with findings
- Save all search results to /tmp/web-research-results-[timestamp].txt
- Include GitHub/GitLab/Bitbucket URLs found in results or citations

Task: "Find external resources about [topic]"
- MUST use WebSearch tool explicitly
- Look for tutorials, guides, examples
- Find relevant Stack Overflow discussions
- Discover blog posts or articles
- MUST include links for reference
- Save results to file: /tmp/web-research-results-[timestamp].txt
- Note any repository URLs mentioned in sources
```

**Web Page Fetching Optimization:**
When instructing sub-agents to fetch web pages, route through a markdown converter for cleaner extraction:
- **Primary**: `WebFetch(url: "https://markdown.new/<target-url>")`
- **Fallback** (if primary fails or returns empty): `WebFetch(url: "https://r.jina.ai/<target-url>")`
- Example: `WebFetch(url: "https://markdown.new/https://docs.example.com/guide")`
- This produces 80% fewer tokens than raw HTML conversion by returning clean markdown
- Skip for API endpoints (JSON), authenticated URLs, or GitHub (use gh CLI instead)

**CRITICAL for Web Research Tasks**:
- Always use the WebSearch tool (DO NOT rely on internal knowledge)
- Save complete search results to `/tmp/web-research-results-$(date +%s).txt`
- Save agent response with URLs to `/tmp/agent-outputs-$(date +%s)-$$.txt`
- Include ALL URLs found (especially GitHub, GitLab, Bitbucket)
- Include repository URLs from citations and references
- Return the file path with search results for URL detection

**D. Test and Quality Research:**
```
Task: "Analyze test coverage for [component]"
- Find existing tests
- Identify testing patterns
- Check for missing test cases
- Return test file locations
```

**Spawning Strategy:**
- Run 3-6 focused tasks in parallel for efficiency
- Each task should have a clear, specific goal
- Provide enough context for agents to be effective
- Request concrete outputs (file paths, code snippets, URLs)

### Step 3.5: External Repository Discovery Follow-up

**AUTOMATIC DETECTION** (runs if web research was performed):

After web research completes, execute a bash script to scan ALL web research results for external repository URLs:

```bash
# Detect repository URLs from all web research results
REPO_URLS=""
find /tmp -name "web-research-results-*.txt" -mmin -60 2>/dev/null | while IFS= read -r file; do
    URLS=$(bash ~/.claude/utils/detect-repo-urls.sh "$file")
    if [ -n "$URLS" ]; then
        REPO_URLS+="${URLS}"$'\n'
    fi
done

# Deduplicate and display
REPO_URLS=$(echo "$REPO_URLS" | sort -u | grep -v '^$')

if [ -n "$REPO_URLS" ]; then
    echo "Detected external repositories from web research:"
    echo "$REPO_URLS"
    DETECTED_REPOS_FILE="/tmp/detected-repos-$(date +%s)-$$.txt"
    echo "$REPO_URLS" > "$DETECTED_REPOS_FILE"
fi
```

### Step 4: Wait and Synthesize

- **IMPORTANT**: Wait for ALL sub-agent tasks to complete
- Compile all sub-agent results
- Prioritize live codebase findings as primary source of truth
- Connect findings across different components
- Include specific file paths and line numbers for reference
- Highlight patterns, connections, and architectural decisions
- Answer the user's specific questions with concrete evidence

### Step 5: Generate Research Document

Create a document with the following structure:

```markdown
# Research: [User's Question/Topic]

**Date**: [Current date and time]
**Repository**: [Repository name]
**Branch**: [Current branch name]
**Commit**: [Current commit hash]
**Research Type**: [Codebase | Documentation | Web | Comprehensive]

## Research Question
[Original user query]

## Executive Summary
[2-3 sentence high-level answer to the question]

## Key Findings
- [Most important discovery]
- [Second key insight]
- [Third major finding]

## Prior Learnings (if found)

### Relevant Past Solutions
| Learning | Key Insight | Confidence |
|----------|-------------|------------|
| [Title] | [The one thing that fixes it] | high/medium/low |

## Detailed Findings

### Codebase Analysis
#### [Component/Area 1]
- Current implementation: [file.ext:line]
- How it works: [explanation]

### Documentation Insights
- [Key documentation found]

### External Research (if applicable)
- [Best practices from official docs] ([URL])

## Code References
- `path/to/file.py:123` - Main implementation of [feature]

## Recommendations
1. [Actionable recommendation]

## Open Questions
- [Area needing more investigation]
```

Save to: `research/YYYY-MM-DD_HH-MM-SS_topic.md`

### Step 6: Add GitHub Permalinks (if applicable)

- Check if on main branch and generate GitHub permalinks for code references

### Step 7: Present Findings

- Present a concise summary to the user
- Include key file references for easy navigation

## Important Notes

- Always use parallel Task agents to maximize efficiency
- Focus on finding concrete file paths and line numbers
- Research documents should be self-contained
- Keep the main agent focused on synthesis, not deep file reading

## Critical Ordering

1. ALWAYS read mentioned files first before spawning sub-tasks
2. ALWAYS wait for all sub-agents to complete before synthesizing
3. ALWAYS gather metadata before writing the document
4. NEVER write the research document with placeholder values
