-- ============================================================
-- 001-complaints.sql — Constituency Complaint Bot Schema
-- ============================================================

-- TENANT CONFIGURATION (loaded from YAML, cached in DB)
CREATE TABLE IF NOT EXISTS tenant_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- USERS (identified by WhatsApp phone number)
CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    name TEXT,
    language TEXT DEFAULT 'mr',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    total_complaints INTEGER DEFAULT 0,
    is_blocked INTEGER DEFAULT 0
);

-- COMPLAINTS
CREATE TABLE IF NOT EXISTS complaints (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    category TEXT,
    subcategory TEXT,
    description TEXT NOT NULL,
    location TEXT,
    language TEXT NOT NULL,
    status TEXT DEFAULT 'registered',
    status_reason TEXT,
    priority TEXT DEFAULT 'normal',
    source TEXT DEFAULT 'text',
    voice_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    days_open INTEGER DEFAULT 0,
    FOREIGN KEY (phone) REFERENCES users(phone)
);
CREATE INDEX IF NOT EXISTS idx_complaints_phone ON complaints(phone);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_category ON complaints(category);
CREATE INDEX IF NOT EXISTS idx_complaints_created ON complaints(created_at);
CREATE INDEX IF NOT EXISTS idx_complaints_days_open ON complaints(days_open);

-- View that computes days_open dynamically at query time
CREATE VIEW IF NOT EXISTS complaints_view AS
  SELECT *,
    CAST(julianday(COALESCE(resolved_at, datetime('now'))) -
         julianday(created_at) AS INTEGER) AS days_open_live
  FROM complaints;

-- COMPLAINT UPDATES (audit trail)
CREATE TABLE IF NOT EXISTS complaint_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    note TEXT,
    updated_by TEXT DEFAULT 'system',
    created_at TEXT NOT NULL,
    FOREIGN KEY (complaint_id) REFERENCES complaints(id)
);
CREATE INDEX IF NOT EXISTS idx_updates_complaint ON complaint_updates(complaint_id);

-- CONVERSATION HISTORY (for Claude context)
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    complaint_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (phone) REFERENCES users(phone)
);
CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone, created_at);

-- RATE LIMITING
CREATE TABLE IF NOT EXISTS rate_limits (
    phone TEXT NOT NULL,
    date TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    last_message_at TEXT,
    recent_timestamps TEXT,
    PRIMARY KEY (phone, date)
);

-- USAGE TRACKING
CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    complaint_id TEXT,
    model TEXT NOT NULL,
    purpose TEXT,
    container_duration_ms INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_phone ON usage_log(phone);
CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_log(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_log(model);

-- CATEGORIES
CREATE TABLE IF NOT EXISTS categories (
    name TEXT PRIMARY KEY,
    display_name_en TEXT,
    display_name_mr TEXT,
    display_name_hi TEXT,
    complaint_count INTEGER DEFAULT 0,
    first_seen TEXT NOT NULL,
    is_active INTEGER DEFAULT 1
);
