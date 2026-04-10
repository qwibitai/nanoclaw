---
name: make-github-issues
description: Review codebase and create GitHub issues for identified problems
user-invocable: true
---

Review codebase and create GitHub issues for identified problems: $ARGUMENTS

Follow these steps:

1. **Analyze the codebase**:
   - If $ARGUMENTS specifies files/directories, focus on those areas
   - Otherwise, perform a comprehensive codebase review
   - Look for bugs, design issues, code quality problems, and technical debt
   - Don't hallucinate - only report real, observable issues

2. **Categorize findings**:
   - **Bugs**: Incorrect behavior, logic errors, potential crashes
   - **Design issues**: Architecture problems, poor separation of concerns
   - **Code quality**: Readability, maintainability, performance issues
   - **Security**: Potential vulnerabilities or unsafe practices
   - **Technical debt**: Outdated dependencies, deprecated APIs, code duplication

3. **Document each issue thoroughly**:
   - **Title**: Clear, descriptive summary of the problem
   - **Description**: Detailed explanation of the issue
   - **Code location**: Specific files and line numbers
   - **Impact**: How this affects the system or users
   - **Reproduction steps**: If applicable, how to reproduce the issue
   - **Suggested solution**: Potential approaches to fix the problem

4. **Check for duplicates**:
   - Use `gh issue list` to see existing issues
   - Search for similar problems already reported
   - Only create new issues for genuinely new problems

5. **Create GitHub issues**:
   - Use `gh issue create` for each identified problem
   - Apply appropriate labels: `bug`, `enhancement`, `security`, `tech-debt`
   - Set priority levels based on severity and impact
   - Include code snippets and file references in issue descriptions

6. **Generate a summary report**:
   - Create `code-review-findings.md` with:
     - Overview of issues found
     - Categorization by type and priority
     - Recommendations for addressing issues
     - Links to created GitHub issues

Remember: Be specific and accurate - provide concrete evidence for each issue identified.
