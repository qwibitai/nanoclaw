# /read-article

Read articles, extract actionable learnings, and integrate knowledge into the system.

## Purpose

Automate the process of consuming external knowledge (articles, blog posts, papers) and applying it to improve NanoClaw's architecture, methodology, and user experience.

## Usage

```bash
/read-article <url>
/read-article <url> --focus=<topic>
```

**Examples:**
- `/read-article https://example.com/context-engineering-guide`
- `/read-article https://example.com/ai-memory-systems --focus=architecture`

## Process

### Phase 1: Read & Comprehend

1. **Fetch the article**
   - Use `agent-browser` for JavaScript-heavy sites (preferred)
   - Fallback to `WebFetch` for static content
   - Take screenshot for reference if visual content matters

2. **Extract key information**
   - Author and publication date
   - Main thesis/argument
   - Key concepts and frameworks
   - Practical techniques/patterns
   - Examples and case studies
   - Tools or technologies mentioned

3. **Identify article type**
   - **Tutorial**: Step-by-step implementation guide
   - **Architecture**: System design patterns
   - **Research**: Academic findings or experiments
   - **Opinion/Analysis**: Thought leadership
   - **Case Study**: Real-world application

### Phase 2: Extract Learnings

4. **Categorize learnings by relevance**

   **Tier 1 - Immediately Applicable**:
   - Concepts we can implement right now
   - Techniques that solve current problems
   - Patterns that improve existing systems

   **Tier 2 - Strategic Value**:
   - Principles that inform future decisions
   - Frameworks for thinking about problems
   - Best practices to adopt over time

   **Tier 3 - Reference Knowledge**:
   - Background information worth keeping
   - Related concepts to explore later
   - Tools or resources for future use

5. **Identify what's novel**
   - Cross-reference with existing `memory/` notes
   - Check if concepts already documented
   - Determine what's truly new vs. reinforcement

### Phase 3: Create Memory Notes

6. **For each Tier 1 & 2 learning**, create atomic memory notes:

   - **Format**: `memory/<Prose sentence title>.md`
   - **Frontmatter**: description, topics, created date, source URL
   - **Content**:
     - Concept explanation in your own words
     - Why it matters (practical application)
     - How it relates to existing knowledge (wiki links)
     - Source attribution

   **Example**:
   ```markdown
   ---
   description: Token bucket algorithm prevents API rate limit violations through controlled request pacing
   topics: [rate-limiting, api-design, architecture]
   created: 2026-02-24
   source: https://example.com/rate-limiting-guide
   ---

   # Token bucket algorithm provides smooth rate limiting without request bursts

   [Content here with practical application]

   ## Related Notes
   - [[Progressive disclosure uses three-level architecture for AI context]]

   ## Source
   Original article: [Rate Limiting Best Practices](https://example.com/rate-limiting-guide)

   ---
   *Topics: [[rate-limiting]] · [[api-design]] · [[architecture]]*
   ```

7. **Update memory/index.md**
   - Add new notes to appropriate topic sections
   - Update "Recent Additions"
   - Create new topic MOC if 5+ notes on same topic

### Phase 4: Apply Improvements

8. **For Tier 1 learnings** (immediately applicable):

   Ask user: "Found X immediately applicable improvements. Implement now?"

   If yes:
   - Create implementation plan
   - Update relevant files (`self/methodology.md`, `CLAUDE.md`, etc.)
   - Document changes in `ops/observations/YYYY-MM-DD-article-applied.md`
   - Test changes if code-related

9. **For Tier 2 learnings** (strategic):

   - Add to `self/methodology.md` if it's an operational principle
   - Create decision framework in `memory/logs/decisions.jsonl` if applicable
   - Log to `ops/queue/` for future implementation

### Phase 5: Summarize & Output

10. **Create summary document**

    Save to `memory/research/YYYY-MM-DD-article-title.md`:

    ```markdown
    # Article: [Title]

    **Source**: [URL]
    **Author**: [Name]
    **Date**: [Publication Date]
    **Read**: [Today's Date]

    ## Summary

    [2-3 paragraph executive summary]

    ## Key Learnings

    ### Tier 1: Immediately Applicable
    - [Learning 1] → Implemented in [file/system]
    - [Learning 2] → Created [[memory note]]

    ### Tier 2: Strategic Value
    - [Learning 1] → Added to methodology
    - [Learning 2] → Queued for future

    ### Tier 3: Reference
    - [Background concept]
    - [Tool/resource]

    ## Memory Notes Created

    1. [[Note title 1]]
    2. [[Note title 2]]

    ## Changes Applied

    - Updated `self/methodology.md` with [principle]
    - Enhanced `CLAUDE.md` with [pattern]
    - Created skill: `/new-skill`

    ## Related Research

    - [[Previous article]]
    - [[Related concept]]
    ```

11. **Report to user**

    Concise summary:
    - Article title and main thesis
    - X memory notes created
    - Y improvements implemented
    - Z items queued for later
    - Link to full research document

## Quality Gates

Before creating memory notes:
- [ ] Title makes a specific claim (not just topic name)
- [ ] Description is ~150 chars, provides context
- [ ] Topics assigned for navigation
- [ ] Source URL included in frontmatter
- [ ] Related notes linked (check index.md first)
- [ ] Content is in your own words (not copy-paste)

Before applying improvements:
- [ ] User confirmed changes should be implemented
- [ ] Changes align with existing methodology
- [ ] Documentation updated
- [ ] Changes logged in ops/observations/

## Context to Load

**Level 2**:
- `memory/index.md` - Check existing knowledge
- `self/methodology.md` - Ensure alignment with principles
- `self/ROUTING.md` - Understand where learnings should go

**Level 3** (as needed):
- Search `memory/*.md` for related concepts
- Check `ops/queue/` for pending improvements
- Review recent `ops/observations/` for friction points article might solve

## Tools

- **agent-browser**: Primary tool for reading articles (handles JS, screenshots)
- **WebFetch**: Fallback for static content
- **Grep**: Search existing memory for related concepts
- **Read**: Load existing notes to check for duplicates

## Output Files

Created by this skill:
1. `memory/<Learning title>.md` - One per key concept (Tier 1 & 2)
2. `memory/research/YYYY-MM-DD-article-title.md` - Research summary
3. `ops/observations/YYYY-MM-DD-article-applied.md` - If changes implemented
4. Updated `memory/index.md` - With new notes

## Example Session

```
User: /read-article https://muratcan.com/context-engineering

[Agent uses agent-browser to read article]
[Agent extracts 6 key concepts]
[Agent checks memory/ for existing knowledge]
[Agent creates 6 memory notes]
[Agent updates memory/index.md]
[Agent asks: "Found 5 immediately applicable improvements. Implement?"]
User: Yes
[Agent creates JSONL logs, voice.yaml, routing.md, etc.]
[Agent documents changes in ops/observations/]
[Agent creates research summary]

Output:
✅ Read: "The File System Is the New Database"
📝 Created 6 memory notes
🔧 Implemented 5 improvements (JSONL logs, voice profile, routing, etc.)
📊 Research summary: memory/research/2026-02-24-file-system-database.md
```

## Success Criteria

- User doesn't have to manually extract learnings
- Knowledge automatically integrated into memory system
- Immediately applicable improvements can be implemented on request
- All learnings discoverable via memory/index.md
- Source attribution preserved
- No duplicate notes created

## Related Skills

- `/remember` - Capture learnings from conversations (this skill does it for external articles)
- `/reflect` - Maintain knowledge graph connections
- `/topic-research` (future) - Deep-dive research on specific topics
