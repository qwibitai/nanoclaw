# Code Review Checklist

## General Code Quality
- [ ] Code is self-documenting and easy to understand
- [ ] Variable and function names are descriptive and consistent
- [ ] No commented-out code or debug statements
- [ ] DRY principle is followed (no duplicated code)
- [ ] SOLID principles are applied where appropriate

## Functionality
- [ ] Code does what it's supposed to do
- [ ] Edge cases are handled properly
- [ ] Error handling is comprehensive
- [ ] No obvious bugs or logic errors
- [ ] Backward compatibility is maintained (if applicable)

## Performance
- [ ] No obvious performance bottlenecks
- [ ] Database queries are optimized (no N+1 queries)
- [ ] Appropriate caching is implemented
- [ ] Large data sets are paginated
- [ ] Asynchronous operations are used where beneficial

## Security
- [ ] No hardcoded secrets or credentials
- [ ] Input validation is thorough
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (proper escaping)
- [ ] Authentication and authorization checks
- [ ] Sensitive data is encrypted
- [ ] HTTPS is enforced where needed

## Testing
- [ ] Unit tests cover the main functionality
- [ ] Tests are meaningful and not just for coverage
- [ ] Edge cases are tested
- [ ] Tests are readable and maintainable
- [ ] Integration tests for critical paths
- [ ] Test coverage meets project standards

## Documentation
- [ ] README is updated if needed
- [ ] API documentation is current
- [ ] Complex logic has explanatory comments
- [ ] CHANGELOG is updated
- [ ] Deployment instructions are clear

## Architecture & Design
- [ ] Changes align with overall architecture
- [ ] Design patterns are used appropriately
- [ ] Dependencies are minimal and justified
- [ ] Code is modular and reusable
- [ ] Separation of concerns is maintained

## Database (if applicable)
- [ ] Migrations are reversible
- [ ] Indexes are added for frequently queried columns
- [ ] Foreign keys and constraints are proper
- [ ] No breaking changes to existing data
- [ ] Migration scripts are tested

## Frontend Specific (if applicable)
- [ ] Cross-browser compatibility
- [ ] Responsive design works correctly
- [ ] Accessibility standards are met (WCAG)
- [ ] No console errors or warnings
- [ ] Assets are optimized (images, scripts)

## API Specific (if applicable)
- [ ] REST conventions are followed
- [ ] API versioning is handled correctly
- [ ] Response formats are consistent
- [ ] Error responses are informative
- [ ] Rate limiting is considered

## DevOps & Deployment
- [ ] Environment variables are documented
- [ ] Docker configuration is updated (if used)
- [ ] CI/CD pipeline passes
- [ ] Monitoring and logging are adequate
- [ ] Rollback procedure is clear

## Final Checks
- [ ] PR description is clear and complete
- [ ] JIRA ticket is updated
- [ ] No merge conflicts
- [ ] Branch is up to date with main/master
- [ ] All discussions are resolved

## Notes for Reviewer
Space for any specific concerns or areas that need extra attention:

---

**Reviewer Signature:** _______________
**Date:** _______________
