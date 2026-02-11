-- ============================================================
-- 002-user-dob-block-reason.sql — Add date_of_birth and block_reason to users
-- ============================================================

-- Date of birth for birthday greetings
ALTER TABLE users ADD COLUMN date_of_birth TEXT;

-- Reason why user was blocked (for audit trail)
ALTER TABLE users ADD COLUMN block_reason TEXT;
