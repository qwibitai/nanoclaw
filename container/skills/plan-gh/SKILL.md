---
name: plan-gh
description: Create a detailed development plan and corresponding GitHub issues
user-invocable: true
---

Create a detailed development plan and corresponding GitHub issues for the project: $ARGUMENTS

Follow these steps:

1. **Read the specification**:
   - Look for the spec file specified in $ARGUMENTS
   - If no file specified, look for `spec.md` or ask for the specification file path
   - Understand the project requirements, goals, and technical constraints

2. **Draft a comprehensive development blueprint**:
   - Break down the project into major phases and milestones
   - Identify dependencies between different components
   - Consider technical architecture and implementation approach
   - Plan for incremental, iterative development
   - Ensure each step builds safely on the previous step

3. **Create small, manageable development chunks**:
   - Review the initial breakdown and further decompose large tasks
   - Ensure steps are small enough to implement safely
   - Make sure steps are large enough to provide meaningful progress
   - Iterate until steps are appropriately sized for the project complexity

4. **Generate implementation prompts**:
   - Create detailed prompts for code-generation LLM for each step
   - Prioritize best practices and incremental progress
   - Ensure no big jumps in complexity between steps
   - Make sure each prompt builds on previous work
   - End with integration steps to wire everything together
   - Avoid creating orphaned or hanging code

5. **Create GitHub issues for each step**:
   - Use `gh issue create` for each development step
   - Apply appropriate labels: `epic`, `feature`, `task`
   - Include detailed acceptance criteria and implementation notes
   - Set up dependencies between issues using GitHub's linking
   - Assign priority levels and effort estimates

6. **Generate comprehensive documentation**:
   - Save the development plan as `development-plan.md`
   - Create `implementation-prompts.md` with LLM prompts for each step
   - Generate `project-roadmap.md` showing timeline and milestones
   - Include links to all created GitHub issues

Remember: Each step should be independently implementable while building toward the complete solution.
