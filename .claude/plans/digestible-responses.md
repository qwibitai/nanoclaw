# Plan: Make Text Responses More Digestible

## Problem Statement

Current responses tend to be long, dense, and hard to scan quickly in messaging apps (WhatsApp/iMessage). User preference is for more concise, structured communication that's easier to digest.

## Current State Analysis

**Formatting Pipeline:**
- Agent output → `formatOutbound()` → Channel prefix → Send
- Minimal processing (only strips `<internal>` tags)
- No message chunking or length limits
- No structured formatting helpers

**Current Guidelines (from CLAUDE.md & methodology.md):**
- Use single asterisks for bold
- Use bullets for lists
- Progress indicators for long tasks (⏳ ✓ → ⚠️ ❌)
- But no guidance on response length or structure

## Proposed Solution

### Approach: Response Formatting Layer + Updated Guidelines

Add a response formatting system that processes agent output before sending to make it more digestible.

### Core Principles

1. **Brevity First** - Start concise, offer details on request
2. **Progressive Disclosure** - TL;DR → Details → Deep dive (if needed)
3. **Scannable Structure** - Use bullets, short paragraphs, visual breaks
4. **Context-Aware** - Simple questions get simple answers

### Implementation Strategy

#### 1. Update Communication Guidelines

**File: `/workspace/group/self/methodology.md`**

Add new section: "Response Structure Guidelines"

```markdown
### Response Structure

**Length Guidelines:**
- Simple questions: 1-3 sentences max
- Moderate complexity: 3-5 bullet points or short paragraphs
- Complex topics: TL;DR + structured details + offer to elaborate

**Structure Patterns:**

*Pattern A: Simple Answer*
```
Direct answer in 1-3 sentences.
```

*Pattern B: Moderate Detail*
```
Brief context (1 sentence)

• Key point 1
• Key point 2
• Key point 3

Closing thought (optional)
```

*Pattern C: Complex Topic*
```
*TL;DR:* One sentence summary

*Key points:*
• Point 1
• Point 2
• Point 3

Want more details on any of these?
```

**Avoid:**
- Walls of text (>200 words without breaks)
- Multiple long paragraphs in a row
- Over-explaining simple concepts
- Repeating information already established
```

#### 2. Create Response Formatter Utility

**File: `/workspace/project/src/response-formatter.ts`** (new)

Core functions:
```typescript
// Detect response type and apply appropriate formatting
export function formatResponse(text: string, context?: MessageContext): string

// Break long messages into digestible chunks
export function chunkLongResponse(text: string, maxLength: number = 800): string[]

// Add visual structure (better bullet spacing, section breaks)
export function enhanceStructure(text: string): string

// Simplify overly complex responses
export function simplifyIfNeeded(text: string): string
```

**Key Features:**
- Detect if response is too long (>800 chars) → suggest chunking or summarizing
- Add spacing around bullet lists for readability
- Detect walls of text → insert paragraph breaks
- Optional: detect if answer could be simplified

#### 3. Integrate into Formatting Pipeline

**File: `/workspace/project/src/router.ts`**

Update `formatOutbound()`:
```typescript
export function formatOutbound(text: string, context?: MessageContext): string {
  // 1. Strip internal tags (existing)
  let formatted = stripInternalTags(text);

  // 2. Apply digestibility formatting (new)
  formatted = formatResponse(formatted, context);

  return formatted;
}
```

#### 4. Add Message Chunking for Very Long Responses

**File: `/workspace/project/src/channels/base.ts` or channel implementations**

For responses >1500 chars:
- Split at logical boundaries (paragraph breaks, section headers)
- Send as multiple messages with small delay between
- Add continuation indicators ("1/3", "2/3", "3/3")

#### 5. Update User Profile Preference

**File: `/workspace/group/memory/users/14195613622.md`**

Add to communication preferences:
```markdown
## Communication Preferences

- **Response length**: Prefer concise, scannable responses
- **Structure**: TL;DR + bullets for complex topics
- **Detail level**: Start simple, offer to elaborate
- **Format**: Brief summaries with option to expand
```

## Implementation Plan

### Phase 1: Guidelines & Documentation (Quick Win)
1. Update `self/methodology.md` with response structure guidelines
2. Update admin user profile with communication preferences
3. Create memory note documenting preference
4. Test with natural conversation adjustments

**Estimated effort:** 30 minutes
**Impact:** Immediate improvement through behavioral guidance

### Phase 2: Code Implementation (Full Solution)
1. Create `src/response-formatter.ts` with formatting functions
2. Integrate into `formatOutbound()` in router.ts
3. Add message chunking to channel implementations
4. Write tests for formatter functions
5. Update CLAUDE.md with new formatting behavior

**Estimated effort:** 2-3 hours
**Impact:** Automated, consistent formatting for all responses

## Trade-offs

**Approach A: Guidelines Only (Recommended Start)**
- Pros: Fast, flexible, adaptive to context
- Cons: Requires agent to remember and apply consistently

**Approach B: Automated Formatting**
- Pros: Guaranteed consistency, works automatically
- Cons: May over-format or miss context nuances

**Hybrid (Recommended):** Start with Phase 1 guidelines, add Phase 2 automation selectively for:
- Very long responses (>1000 chars)
- Known verbose patterns
- List/bullet formatting

## Success Metrics

- User no longer feels overwhelmed by response length
- Responses are scannable in 5-10 seconds
- Follow-up questions decrease (got answer first time)
- User doesn't have to ask "make it shorter"

## Next Steps

1. Get user approval on approach
2. Start with Phase 1 (guidelines update)
3. Test with real interactions
4. Implement Phase 2 if needed
