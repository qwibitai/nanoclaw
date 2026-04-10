---
name: do-issues
description: Work on GitHub issues systematically with proper development workflow
user-invocable: true
---

Work on GitHub issues systematically with proper development workflow: $ARGUMENTS

Follow these steps:

1. **Review available GitHub issues**:
   - Use `gh issue list` to see all open issues
   - Choose a small, manageable task to complete
   - If $ARGUMENTS specifies an issue number, work on that specific issue

2. **Plan your approach**:
   - Use `gh issue view` to get detailed issue information
   - Understand the problem and requirements thoroughly
   - Post your implementation plan as a comment on the issue using `gh issue comment`

3. **Create a development branch**:
   - Create a new branch with descriptive name: `git checkout -b fix/issue-{number}-{description}`
   - Ensure branch is based on the latest main branch

4. **Implement the solution**:
   - Search the codebase for relevant files using appropriate tools
   - Write robust, well-documented code following existing patterns
   - Include comprehensive tests with good coverage
   - Add debug logging where appropriate
   - Follow the project's coding standards and conventions

5. **Verify your implementation**:
   - Run all existing tests to ensure nothing breaks
   - Run linting and type checking if available
   - Test your specific changes thoroughly
   - Ensure all tests pass before proceeding

6. **Create a pull request**:
   - Commit your changes with a descriptive commit message
   - Push the branch to GitHub
   - Use `gh pr create` to open a pull request
   - Reference the issue in the PR description (e.g., "Closes #123")
   - Base the PR on the previous branch if working on sequential issues

7. **Keep the issue open** until the pull request is merged

Remember: Each PR should build incrementally on previous work when working on related issues.
