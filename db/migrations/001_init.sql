-- 001_init.sql — Revealyst core schema (spec §6.2)
-- All six tables plus supporting indexes. Applied by the migration runner
-- (db/src/run-migrations.ts) which records versions in schema_migrations.
-- gen_random_uuid() is core in PostgreSQL 13+ (RDS 15/16) — no pgcrypto needed.

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    plan TEXT DEFAULT 'free',             -- free, pro, team
    personal_score_trend JSONB DEFAULT '[]',
    preferences JSONB DEFAULT '{}'
);

-- Teams
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_by UUID REFERENCES users(id),
    billing_status TEXT DEFAULT 'active',
    settings JSONB DEFAULT '{"anonymize_identities": true}',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Team memberships
CREATE TABLE IF NOT EXISTS team_members (
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member',           -- 'member' or 'manager'
    anon_alias TEXT,                      -- e.g. 'User_A'
    PRIMARY KEY (team_id, user_id)
);

-- Anonymised prompt events (no raw prompt text)
CREATE TABLE IF NOT EXISTS prompt_events (
    id BIGSERIAL PRIMARY KEY,
    user_anon_id TEXT NOT NULL,           -- hashed identifier
    team_id UUID REFERENCES teams(id),
    prompt_hash TEXT NOT NULL,            -- SHA-256 of prompt text
    score INTEGER,
    breakdown JSONB,
    flags TEXT[],
    llm_platform TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
-- Index for fast aggregation
CREATE INDEX IF NOT EXISTS idx_prompt_events_team_date ON prompt_events (team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_events_user_date ON prompt_events (user_anon_id, created_at);

-- Shared prompt library
CREATE TABLE IF NOT EXISTS library_prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    title TEXT,
    prompt_text_encrypted TEXT NOT NULL,  -- hex(iv || AES-256-GCM ciphertext)
    prompt_hash TEXT NOT NULL,            -- SHA-256 of the plaintext prompt (dedup key)
    tags TEXT[],
    created_by UUID REFERENCES users(id),
    score INTEGER,                        -- PQS at save time (shown on the card)
    usage_count INTEGER DEFAULT 0,
    version INTEGER DEFAULT 1,
    parent_id UUID REFERENCES library_prompts(id),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_library_prompts_team_date ON library_prompts (team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_library_prompts_team_hash ON library_prompts (team_id, prompt_hash);

-- Track suggestions feedback
CREATE TABLE IF NOT EXISTS suggestions_feedback (
    user_id UUID REFERENCES users(id),
    suggestion_id TEXT,
    was_accepted BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suggestions_feedback_user ON suggestions_feedback (user_id, created_at);
