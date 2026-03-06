# Linear Read-Only Query For Parent/Child Readiness

Use read-only discovery to evaluate integration readiness.

```bash
curl -sS https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{
  "query": "query ParentChildren($teamId:String!,$project:String!){issues(filter:{team:{id:{eq:$teamId}},project:{name:{eq:$project}}},first:200){nodes{id identifier title state{name} parent{id} project{name}}}}",
  "variables": {
    "teamId": "YOUR_LINEAR_TEAM_ID",
    "project": "farm"
  }
}
JSON
```
