# Linear Read-Only Query For Launch Candidates

Use this to find approved child tasks. Keep this read-only.

```bash
curl -sS https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{
  "query": "query ApprovedChildren($teamId:String!,$project:String!){issues(filter:{team:{id:{eq:$teamId}},project:{name:{eq:$project}},state:{name:{eq:\"Approved\"}},parent:{null:false}},first:100){nodes{id identifier title state{name} project{name} parent{id}}}}",
  "variables": {
    "teamId": "YOUR_LINEAR_TEAM_ID",
    "project": "farm"
  }
}
JSON
```
