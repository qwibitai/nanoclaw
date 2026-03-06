# Linear Read-Only Query Pattern

Use for discovery only. Do not mutate coding task state through raw Linear API calls.

```bash
curl -sS https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{
  "query": "query OpsIssues($teamId:String!,$project:String!){issues(filter:{team:{id:{eq:$teamId}},project:{name:{eq:$project}},state:{name:{in:[\"Approved\",\"Coding\",\"Done\",\"Canceled\",\"In Review\"]}}},first:100){nodes{id identifier title state{name} project{name} parent{id}}}}",
  "variables": {
    "teamId": "YOUR_LINEAR_TEAM_ID",
    "project": "farm"
  }
}
JSON
```
