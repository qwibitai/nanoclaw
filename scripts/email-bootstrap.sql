-- Bootstrap messaging_groups + wirings for the email channel.
--
-- Idempotent: re-running is safe. Each row uses a deterministic id so
-- INSERT OR IGNORE skips existing rows on a re-run.
--
-- Run from repo root:
--   sqlite3 data/v2.db < scripts/email-bootstrap.sql
--
-- Prereqs:
--   - agent_groups rows for email-joi and email-jibot-gidc must exist
--     (they do — created during the v1→v2 port).
--   - .env must include EMAIL_ACCOUNTS=jibot@ito.com,jibot@gidc.bt
--
-- What this wires:
--   1. email:jibot@ito.com:joi@ito.com   -> email-joi
--      (joi mailing her own ito bot — acceptance test #1)
--   2. email:jibot@gidc.bt:joi@ito.com   -> email-jibot-gidc
--      (joi mailing the gidc bot; pilot mode at adapter layer ensures
--      replies go to the configured reviewer, not auto-sent)
--
-- Anything else (a stranger mailing either mailbox) flows through the
-- standard auto-create + channel-request approval gate. Same as how
-- Discord/Slack DMs from unknown users behave.

BEGIN;

-- ── jibot@ito.com / joi@ito.com -> email-joi ───────────────────────────────

INSERT OR IGNORE INTO messaging_groups (
  id, channel_type, platform_id, name, is_group,
  unknown_sender_policy, created_at
) VALUES (
  'mg-email-jibot-ito-joi',
  'email',
  'email:jibot@ito.com:joi@ito.com',
  'joi → jibot@ito.com',
  0,
  'strict',
  datetime('now')
);

INSERT OR IGNORE INTO messaging_group_agents (
  id, messaging_group_id, agent_group_id,
  session_mode, priority, created_at,
  engage_mode, engage_pattern, sender_scope, ignored_message_policy
) VALUES (
  'mga-email-jibot-ito-joi',
  'mg-email-jibot-ito-joi',
  'ag-1778113207062-4831',  -- email-joi
  'shared',
  0,
  datetime('now'),
  'pattern',
  '.',
  'all',
  NULL
);

-- ── jibot@gidc.bt / joi@ito.com -> email-jibot-gidc ────────────────────────

INSERT OR IGNORE INTO messaging_groups (
  id, channel_type, platform_id, name, is_group,
  unknown_sender_policy, created_at
) VALUES (
  'mg-email-jibot-gidc-joi',
  'email',
  'email:jibot@gidc.bt:joi@ito.com',
  'joi → jibot@gidc.bt',
  0,
  'strict',
  datetime('now')
);

INSERT OR IGNORE INTO messaging_group_agents (
  id, messaging_group_id, agent_group_id,
  session_mode, priority, created_at,
  engage_mode, engage_pattern, sender_scope, ignored_message_policy
) VALUES (
  'mga-email-jibot-gidc-joi',
  'mg-email-jibot-gidc-joi',
  'ag-1778113207063-a858',  -- email-jibot-gidc
  'shared',
  0,
  datetime('now'),
  'pattern',
  '.',
  'all',
  NULL
);

COMMIT;

-- Verify
SELECT mg.platform_id, mga.agent_group_id, ag.folder
FROM messaging_group_agents mga
JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
JOIN agent_groups ag ON ag.id = mga.agent_group_id
WHERE mg.channel_type = 'email';
