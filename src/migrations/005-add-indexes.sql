-- ============================================================
-- 005-add-indexes.sql — Additional performance indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_complaints_area_id ON complaints(area_id);
CREATE INDEX IF NOT EXISTS idx_complaint_validations_complaint ON complaint_validations(complaint_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_jid, timestamp);
