---
description: Generate a visual HTML implementation plan — detailed feature specification with state machines, code snippets, and edge cases
---
Load the visual-explainer skill, then generate a comprehensive visual implementation plan for `$@` as a self-contained HTML page.

Follow the visual-explainer skill workflow. Read the reference template, CSS patterns, and mermaid theming references before generating. Use an editorial or blueprint aesthetic, but vary fonts and palette from previous diagrams.

**Data gathering phase** — understand the context before designing:

1. **Parse the feature request.** Extract:
   - The core problem being solved
   - Desired user-facing behavior
   - Any constraints or requirements mentioned
   - Scope boundaries (what's explicitly out of scope)

2. **Read the relevant codebase.** Identify:
   - Files that will need modification
   - Existing patterns to follow (code style, architecture, naming conventions)
   - Related functionality that the feature should integrate with
   - Types, interfaces, and APIs the feature must conform to

3. **Understand the extension points.** Look for:
   - Hook points, event systems, or plugin architectures
   - Configuration options or flags
   - Public APIs that might need extension
   - Test patterns used in the codebase

4. **Check for prior art.** Search for:
   - Similar features already implemented
   - Related issues or discussions
   - Existing code that can be reused or extended

**Design phase** — work through the implementation before writing HTML:

1. **State design.** What new state variables are needed? What existing state is affected? Draw the state machine if behavior has multiple modes.

2. **API design.** What commands, functions, or endpoints are added? What are the signatures? What are the error cases?

3. **Integration design.** How does this feature interact with existing functionality? What hooks or events are involved?

4. **Edge cases.** Walk through unusual scenarios: concurrent operations, error conditions, boundary values, user mistakes.

**Verification checkpoint** — before generating HTML, produce a structured fact sheet:
- Every state variable (new and modified) with its type and purpose
- Every function/command/API with its signature
- Every file that needs modification with the specific changes
- Every edge case with expected behavior
- Every assumption about the codebase that the plan relies on
Verify each against the code. If something cannot be verified, mark it as uncertain. This fact sheet is your source of truth during HTML generation.

**Diagram structure** — the page should include:

1. **Header** — feature name, one-line description, scope summary. *Visual treatment: use a distinctive header with monospace label ("Feature Plan", "Implementation Spec", etc.), large italic title, and muted subtitle. Set the tone for the page.*

2. **The Problem** — side-by-side comparison panels showing current behavior vs. desired behavior. Use concrete examples, not abstract descriptions. Show what the user experiences or what the code does, step by step. *Visual treatment: two-column grid with rose-tinted "Before" header and sage-tinted "After" header. Numbered flow steps with arrows between them.*

3. **State Machine** — Mermaid flowchart or stateDiagram showing the states and transitions. Label edges with the triggers (commands, events, conditions). *Wrap in `.mermaid-wrap` with zoom controls (+/−/reset/expand) and click-to-expand. Use `flowchart TD` instead of `stateDiagram-v2` if labels need special characters like colons or parentheses. Add explanatory caption below the diagram.*

4. **State Variables** — card grid showing new state and existing state (if modified). Use code blocks with proper `white-space: pre-wrap`. *Visual treatment: two cards side-by-side, elevated depth, monospace labels.*

5. **Modified Functions** — for each function that needs changes, show:
   - Function name and file path
   - Key code snippet (not full implementation — 10-20 lines showing the pattern)
   - Explanation of what changed and why
   *Visual treatment: file path as monospace dim text above code block, code in recessed card with accent-dim background.*

6. **Commands / API** — table with command/function name, parameters, and behavior description. Use `<code>` for technical names. *Visual treatment: bordered table with sticky header, alternating row backgrounds.*

7. **Edge Cases** — table listing scenarios and expected behaviors. Be thorough — include error conditions, concurrent operations, boundary values. *Visual treatment: same table style as Commands section.*

8. **Test Requirements** — table or card grid showing test categories and specific tests to add. Group by: unit tests, integration tests, edge case tests. *Visual treatment: compact table with file references.*

9. **File References** — table mapping files to the changes needed. Include file paths and brief descriptions. *Visual treatment: compact reference table, can use `<details>` if many files.*

10. **Implementation Notes** — callout boxes for:
    - Backward compatibility considerations (gold border)
    - Critical implementation warnings (rose border)
    - Performance considerations if relevant (amber border)
    *Visual treatment: callout boxes with colored left borders, strong labels.*

**Visual hierarchy:**
- Sections 1-3 should dominate the viewport on load (hero depth for header, elevated for problem comparison and state machine)
- Sections 4-6 are core implementation details (elevated cards, readable code blocks)
- Sections 7-10 are reference material (flat or recessed depth, compact layout)

**Typography and color:**
- Pick a distinctive font pairing (not Inter/Roboto)
- Use semantic accent colors: gold for primary accents, sage for "after"/success states, rose for "before"/warning states
- Both light and dark themes must work

**Optional hero image** — if `surf` CLI is available (`which surf`), consider generating a conceptual illustration that captures the feature's essence. Use for abstract concepts that benefit from visual metaphor. Skip for purely structural changes. Embed as base64 data URI using the `.hero-img-wrap` pattern from css-patterns.md.

**Code block requirements:**
- Always use `white-space: pre-wrap` and `word-break: break-word`
- Include file path headers where relevant
- Use syntax-appropriate highlighting via CSS classes if desired
- Keep snippets focused — show the pattern, not the full implementation

**Overflow prevention:**
- Apply `min-width: 0` on all grid/flex children
- Use `overflow-wrap: break-word` on all text containers
- Never use `display: flex` on `<li>` for markers — use absolute positioning
- Test tables with wide content don't overflow their container

Write to `~/.agent/diagrams/` with a descriptive filename (e.g., `feature-name-plan.html`). Open the result in the browser. Tell the user the file path.

Ultrathink.
