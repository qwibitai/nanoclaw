-- Register the email-dispatch agent_group + wire `email:ws-dispatch` to it.
--
-- Idempotent. Run from repo root:
--   sqlite3 data/v2.db < scripts/email-dispatch-bootstrap.sql
--
-- Prereqs:
--   - groups/email-dispatch/CLAUDE.local.md and container.json on disk
--   - ~/switchboard/config/workstream-routes.json on disk
--   - The pre-router (src/channels/email.ts) emits #ws-tagged mail on
--     `email:ws-dispatch` (built in this commit)

BEGIN;

INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
VALUES ('ag-1778120000000-disp01', 'jibot', 'email-dispatch', NULL, datetime('now'));

INSERT OR IGNORE INTO messaging_groups (
  id, channel_type, platform_id, name, is_group,
  unknown_sender_policy, created_at
) VALUES (
  'mg-email-ws-dispatch',
  'email',
  'email:ws-dispatch',
  'Workstream dispatch (#ws:* router)',
  0,
  'strict',
  datetime('now')
);

INSERT OR IGNORE INTO messaging_group_agents (
  id, messaging_group_id, agent_group_id,
  session_mode, priority, created_at,
  engage_mode, engage_pattern, sender_scope, ignored_message_policy
) VALUES (
  'mga-email-ws-dispatch',
  'mg-email-ws-dispatch',
  'ag-1778120000000-disp01',
  'shared', 0, datetime('now'),
  'pattern', '.', 'all', NULL
);

COMMIT;

-- Verify
SELECT mg.platform_id, ag.folder
FROM messaging_group_agents mga
JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
JOIN agent_groups ag ON ag.id = mga.agent_group_id
WHERE mg.channel_type = 'email'
ORDER BY mg.platform_id;
