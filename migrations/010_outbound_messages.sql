-- Outbound messages table for the POST /api/v1/messages endpoint.
-- Tracks proactive messages sent through channels with template formatting,
-- priority ordering, batching, rate limiting, and retry logic.
CREATE TABLE IF NOT EXISTS outbound_messages (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  recipient_type TEXT NOT NULL DEFAULT 'channel_jid',
  template TEXT NOT NULL DEFAULT 'custom',
  content TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_for TEXT,
  batch_key TEXT,
  batch_window INTEGER DEFAULT 300000,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_status ON outbound_messages(status);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_batch ON outbound_messages(batch_key, status);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_priority ON outbound_messages(priority, created_at);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_recipient ON outbound_messages(recipient_id, created_at)
